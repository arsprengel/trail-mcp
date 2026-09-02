import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createApiClient } from './api.js'
import { planejarFaxina, REGUA_MRP, MRP_ALVO, INSTRUCAO_FAXINA } from './memory-review.js'
import { blindarItem, INSTRUCAO_TERCEIRO } from './procedencia.js'

// A versao vem do package.json, NAO escrita a mao aqui: com a publicacao automatica, um numero
// duplicado passaria a mentir sozinho a cada release - e e justo esta string que a ferramenta de
// IA mostra e que o painel usa pra saber em que versao cada pessoa esta.
const VERSAO = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version

// Espelha tether/src/core/schema.ts (fonte de verdade dos valores validos). Repo standalone,
// nao importa o core do tether - se o core mudar os valores, atualizar aqui tambem.
const ItemType = z.enum(['feature', 'bug', 'chore', 'idea', 'question'])
const ItemStatus = z.enum(['backlog', 'todo', 'in_progress', 'blocked', 'done', 'dropped'])
const Priority = z.enum(['low', 'med', 'high'])
const Ref = z.object({ kind: z.enum(['commit', 'pr', 'file', 'item']), value: z.string().min(1) })
// O resumo que o CLIENTE le no relatorio. A descricao abaixo e o unico lugar que ensina a IA
// quando preencher e o que escrever - nao ha validacao de conteudo no servidor, so de tamanho.
const DICA_RESUMO =
  'Resumo em portugues simples do que o CLIENTE precisa entender sobre este item: o que sera ' +
  'feito ou foi feito e por que isso importa pra ele. Sem jargao tecnico, sem nome de arquivo, ' +
  'sem nome de funcao, sem termo de implementacao. 2 a 3 frases, ate 600 caracteres. Preencha ' +
  'ao criar um item ja claro o suficiente para o cliente entender, ou ao concluir/avancar um ' +
  'item (junto da mudanca de status) - e o texto que aparece pro cliente no relatorio, em vez ' +
  'do corpo tecnico.'

const ItemPatch = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  summary: z.string().max(600).nullable().optional().describe(DICA_RESUMO),
  assignees: z.array(z.string()).optional(),
  type: ItemType.optional(),
  status: ItemStatus.optional(),
  priority: Priority.optional(),
  tags: z.array(z.string()).optional(),
  links: z.array(Ref).optional(),
  blocked_by: z.array(z.string()).optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
})
const MemoryCategory = z.enum(['command', 'deploy', 'gotcha', 'decision', 'context'])
const MemoryPatch = z.object({
  category: MemoryCategory.optional(),
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  hint: z.string().optional(),
  archived: z.boolean().optional(),
})
const ReminderStatus = z.enum(['pending', 'done', 'dismissed'])

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

// ANEXO DE IMAGEM: a IA so ENXERGA a foto se ela voltar como bloco de imagem do protocolo. Ate
// 28/08/2026 a foto saia como base64 dentro do JSON de texto - um paredao de caracteres que nao
// vira imagem nenhuma pro modelo. Quem anexava print no card via a IA perguntar "a que voce se
// refere" com a foto ali do lado. Teto de 4 MB de arquivo cru (o modelo aceita 5 MB ja em base64).
const MAX_IMAGEM_BYTES = 4_000_000

// Dica de anexo junto do card. A ficha (`anexos`) vem pronta do servidor; ela pode NAO existir
// quando o servidor ainda nao subiu a versao nova - por isso o guarda de Array.isArray.
function comAnexos(item) {
  if (!item || !Array.isArray(item.anexos) || item.anexos.length === 0) return item
  const imagens = item.anexos.filter((a) => String(a?.content_type ?? '').startsWith('image/')).length
  return {
    ...item,
    dica_anexos: imagens
      ? `Este item tem ${imagens} imagem(ns) anexada(s). Chame get_attachment(id) pra VER a foto antes de perguntar ao usuario a que ele se refere.`
      : 'Este item tem anexo(s). Use get_attachment(id) pra ler o conteudo.',
  }
}
function fail(err) {
  const msg = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
}

// #130: TETO DE SAIDA. A resposta de uma tool MCP tem limite no cliente (25K tokens no padrao
// do Claude Code); acima dele a resposta e trocada por um ponteiro pra arquivo em disco - ou
// seja, some justo pra quem le, que e a IA. A MRP cresce sem freio (tether 60 entradas/131K
// chars, argus 177/421K), entao `detail:"full"` ja nascia condenado. 40K chars sobrevive ate
// ao cambio char/token mais pessimista (~2.5) e cabe em qualquer teto praticado.
// ESPELHO de src/mcp/tools.ts no tether (paginarNoTeto/cortarCorpo) - mudou la, muda aqui.
export const TETO_RESPOSTA_CHARS = 40_000

// CURSOR OPACO, o modelo de paginacao do proprio MCP (o cliente nao deve interpretar nem
// guardar o valor). Aqui ele carrega a IDENTIDADE do ultimo item entregue, nao a posicao:
// offset numerico so serve quando a lista so cresce no fim (a MRP, ordenada por created_at).
// A lista de itens sai na ordem do board, que o move_item reordena - com offset, mexer num
// item da pagina 1 empurra a lista e a pagina 2 PULA um item, em silencio.
const paraCursor = (v) => Buffer.from(v, 'utf8').toString('base64url')
const deCursor = (c) => Buffer.from(c, 'base64url').toString('utf8')

// Corta a lista por ORCAMENTO DE CHARS (nao por numero de entradas: elas variam de 500 a 7000
// chars). Devolve o array puro quando a pagina cobre a lista inteira - o formato antigo, que e
// o caso comum - e so entao veste o envelope com o aviso. O corte nunca e silencioso.
export function paginarNoTeto(todas, opts = {}) {
  const teto = opts.teto ?? TETO_RESPOSTA_CHARS
  // Cursor que nao existe mais (item apagado ou renumerado) NAO vira erro: a IA ficaria sem
  // nada na mao. Recomeca do inicio e diz que recomecou.
  let cursorPerdido = false
  let porCursor = -1
  if (opts.cursorDe && opts.cursor) {
    const alvo = (() => { try { return deCursor(opts.cursor) } catch { return '' } })()
    porCursor = alvo ? todas.findIndex((e) => opts.cursorDe(e) === alvo) : -1
    cursorPerdido = porCursor < 0
  }
  const bruto = porCursor >= 0 ? porCursor + 1 : Math.trunc(Number(opts.offset ?? 0))
  const inicio = Math.min(Math.max(0, Number.isFinite(bruto) ? bruto : 0), todas.length)
  const limite = opts.limit && opts.limit > 0 ? Math.trunc(opts.limit) : todas.length
  const janela = todas.slice(inicio, inicio + limite)

  const escolhidas = []
  let gasto = 0
  let cortou = false
  for (const e of janela) {
    const custo = JSON.stringify(e, null, 2).length
    // A primeira entrada da pagina SEMPRE entra (cortada, se houver como): sem isso uma
    // entrada maior que o teto devolveria pagina vazia pra sempre e a paginacao travava.
    if (escolhidas.length === 0) {
      cortou = custo > teto && !!opts.cortar
      escolhidas.push(cortou ? opts.cortar(e, teto) : e)
    }
    else if (gasto + custo > teto) break
    else escolhidas.push(e)
    gasto += custo
    if (gasto > teto) break
  }

  const montar = (entries) => {
    const proximo = inicio + entries.length
    // Array puro (formato antigo) SO quando a resposta e a lista inteira e nada foi cortado -
    // corpo cortado com cara de resposta completa e exatamente o silencio que este item veio
    // resolver.
    if (inicio === 0 && proximo >= todas.length && !cortou && !cursorPerdido) return entries
    const faltam = todas.length - proximo
    const ultima = entries[entries.length - 1]
    const cursorDaqui = opts.cursorDe && ultima !== undefined ? paraCursor(opts.cursorDe(ultima)) : null
    const continuar = opts.cursorDe
      ? `chame de novo com cursor:"${cursorDaqui}"`
      : `chame de novo com offset:${proximo}`
    const avisoCursor = cursorPerdido ? 'O cursor recebido nao existe mais na lista (item saiu ou mudou de lugar), entao recomecei do inicio. ' : ''
    return {
      aviso: avisoCursor + (entries.length === 0
        ? `Nada aqui: a lista tem ${todas.length} entrada(s).`
        : faltam > 0
          ? `Resposta cortada no teto de saida: vieram ${entries.length} de ${todas.length} entrada(s). Faltam ${faltam} - ${continuar}${opts.dica ?? ''}.`
          : cortou
            ? 'Entrada grande demais para uma resposta so: o corpo veio cortado (o proprio corpo diz onde e como ler o resto).'
            : `Fim da lista: ${entries.length} entrada(s) de ${todas.length}.`),
      total: todas.length,
      devolvidas: entries.length,
      ...(opts.cursorDe
        ? { proximo_cursor: faltam > 0 ? cursorDaqui : null }
        : { offset: inicio, proximo_offset: faltam > 0 ? proximo : null }),
      entries,
    }
  }

  // Garantia dura: o texto EMITIDO (mesmo JSON.stringify do ok()) fica sob o teto. O orcamento
  // acima estima sem o envelope nem a indentacao extra do aninhamento; aqui confere de fato.
  let pagina = montar(escolhidas)
  const tamanho = () => JSON.stringify(pagina, null, 2).length
  while (escolhidas.length > 1 && tamanho() > teto) {
    escolhidas.pop()
    pagina = montar(escolhidas)
  }
  // Sobrou uma entrada so e ainda passa: aperta o corte dela ate caber, em vez de confiar numa
  // folga chutada. Sem isso o envelope (aviso + contadores) empurra a resposta pra fora do teto.
  const inteira = janela[0]
  if (opts.cortar && inteira !== undefined) {
    for (let folga = 0; escolhidas.length === 1 && tamanho() > teto && folga < teto; ) {
      folga += tamanho() - teto + 200
      cortou = true
      escolhidas[0] = opts.cortar(inteira, teto - folga)
      pagina = montar(escolhidas)
    }
  }
  return pagina
}

// Status que tiram o item da mesa. Definido pelo NEGATIVO de proposito: status novo nasce
// contando como aberto e aparece na frente, em vez de sumir no fim sem ninguem notar.
const FECHADOS = new Set(['done', 'dropped'])
const indiceDeItem = (i) => ({
  id: i.id, number: i.number, title: i.title, type: i.type, status: i.status, priority: i.priority,
})

// #156: a resposta de list_items degrada em NIVEIS, e o que ela sacrifica e PROFUNDIDADE,
// nunca COBERTURA. Paginar a lista crua seria pior que o defeito que conserta: ela sai na
// ordem do board e os antigos (concluidos) vem na frente, entao a pagina 1 do tether seria
// 25 itens fechados e zero abertos - resposta plausivel e inutil, que passa batido. A ordem
// certa, que e o padrao de mercado pra resultado de tool grande, e outra: filtrar (status/
// type/tag, ja existia) > PROJETAR CAMPOS (resumo agora, detalhe sob demanda via get_item) >
// so entao paginar. E dizer sempre o que ficou de fora.
// ESPELHO de respostaDeItens em src/mcp/tools.ts no tether - mudou la, muda aqui.
export function respostaDeItens(todos, opts = {}) {
  const teto = opts.teto ?? TETO_RESPOSTA_CHARS
  // Nivel 1: cabe com corpo -> byte a byte o que ja saia antes. E o caso comum (list_items
  // com filtro de status), e nao muda.
  if (opts.detail !== 'index' && !opts.cursor && JSON.stringify(todos, null, 2).length <= teto)
    return todos

  // Nivel 2: indice enxuto do conjunto INTEIRO, aberto antes de fechado.
  const abertos = todos.filter((i) => !FECHADOS.has(i.status))
  const indice = [...abertos, ...todos.filter((i) => FECHADOS.has(i.status))].map(indiceDeItem)
  const nota = opts.detail === 'index'
    ? 'Indice enxuto, abertos primeiro: so id/numero/titulo/tipo/status/prioridade. Abra um item inteiro com get_item(id).'
    : `Lista grande demais pra caber com os corpos: veio o INDICE de TODOS os ${todos.length} item(ns), abertos primeiro (${abertos.length} aberto(s)) - nenhum ficou de fora. Abra um com get_item(id), ou filtre por status/type pra receber os corpos.`
  // Nivel 3: nem o indice cabe (argus 355 itens, TrendWager 389) -> pagina, por cursor. O
  // orcamento desconta a nota ANTES de paginar: ela e grudada no aviso depois, ou seja por
  // fora da garantia do helper - foi assim que a resposta passou do teto por ~150 chars.
  const pagina = paginarNoTeto(indice, {
    cursor: opts.cursor, limit: opts.limit, teto: teto - nota.length - 40, cursorDe: (e) => e.id,
  })
  if (Array.isArray(pagina))
    return { aviso: nota, total: indice.length, devolvidas: pagina.length, proximo_cursor: null, entries: pagina }
  return { ...pagina, aviso: `${nota} ${pagina.aviso}` }
}

// Ultimo recurso: UMA entrada da MRP maior que o teto inteiro. Corta o corpo e deixa o aviso
// DENTRO do texto, onde a IA vai ler, com o ponteiro pra leitura completa. Nao se corta o
// corpo de entrada que caiba - meia verdade num gotcha e pior que uma pagina a mais.
function cortarCorpo(e, teto) {
  const cabe = teto - JSON.stringify({ ...e, body: '' }, null, 2).length - 300
  if (cabe <= 0 || e.body.length <= cabe) return e
  const faltam = e.body.length - cabe
  return { ...e, body: `${e.body.slice(0, cabe)}\n\n[corpo cortado aqui - faltam ${faltam} chars. Leia inteiro com get_memory("${e.id}").]` }
}

// Sobe o MCP server (stdio). As tools espelham as do tether e falam com a API REST da nuvem.
export async function runServer(config) {
  if (!config.url || !config.token) {
    process.stderr.write(
      '[trail] ainda nao conectado - rode: npx -y usetrail@latest login\n',
    )
  }
  const api = createApiClient(config)
  const server = new McpServer(
    { name: 'trail', version: VERSAO },
    {
      instructions:
        'Trail: tracker de itens + MRP (Memoria Referencial de Projeto). ' +
        // Em ferramenta com gancho de inicio de sessao (Claude Code) o resumo ja chega sozinho. Em
        // qualquer outra NAO chega, e a instrucao antiga afirmava que sim: a IA acreditava e comecava
        // a trabalhar sem contexto nenhum. Agora ela confere e busca quando faltar.
        'CONTEXTO DO PROJETO, ANTES DE COMECAR: se o resumo do projeto (indice da MRP + itens abertos) ' +
        'NAO tiver chegado no inicio desta conversa, chame list_memory e get_next AGORA, antes de agir. ' +
        'O INDICE da MRP (titulo + gancho de cada entrada) e leitura obrigatoria - leia-o e SIGA o que estiver la. ' +
        'O GANCHO (linha com ">") diz QUANDO aquela entrada importa: ao tocar uma area que um gancho cobre, ' +
        'ABRA a entrada com get_memory(id) antes de agir - trabalhar so pelo titulo e o erro que o gancho existe pra evitar. ' +
        'Para o CONTEUDO de uma entrada, leia sob demanda (nao puxe a MRP toda a toa): ' +
        'list_memory da o indice barato (ids+titulos), get_memory(id) abre UMA entrada, ' +
        'list_memory({category, detail:"full"}) le uma categoria inteira antes de operar nela. ' +
        'Ao descobrir um GOTCHA/decisao/comando/deploy nao-obvio e duravel, registre com add_memory. ' +
        REGUA_MRP + ' Grave o PORQUE, nao duplique SQL/estrutura/passo-a-passo. Cheque list_memory antes. ' +
        'TRABALHO-A-FAZER nao vai pra MRP, vira item do tracker (add_item); corte deliberado = ponteiro pro item. ' +
        'Corrija ou aposente entradas velhas com update_memory. ' +
        'FAXINA: se o inicio da sessao avisar que a faxina da MRP esta pendente, chame review_memory ANTES ' +
        'de comecar a tarefa - ele devolve um lote pequeno pra julgar. Sem isso a MRP so cresce e para de ser lida. ' +
        // Um pedaco destas instrucoes manda SEGUIR o que esta gravado. O texto de feedback/
        // solicitacao vem de fora e nao pode herdar essa autoridade.
        INSTRUCAO_TERCEIRO + ' ' +
        'Itens de trabalho: list_items/get_next para ver pontas abertas, add_item ao descobrir ' +
        'trabalho novo, update_item ao avancar ou concluir. Item que voce marcar in_progress, ' +
        'FECHE na mesma sessao (done concluiu / blocked travou / todo nao avancou) com nota ou ' +
        'link de evidencia: nada cobra isso no fim da conversa, e item esquecido em in_progress ' +
        'fica mentindo no tracker pra equipe inteira. ' +
        'Lembretes: se prometer avisar algo numa data futura, registre com add_reminder (o Trail ' +
        'guarda e mostra no dashboard, ja que a sessao nao fica aberta pra lembrar); list_reminders ve os pendentes.',
    },
  )
  const scoped = ` Default: projeto "${config.project}" (a pasta aberta); passe project so para outro.`
  // Convencao do item #11: reforca a regra de idea no momento em que a IA puxa um item.
  const ideaHint =
    ' Se o item for type=idea (captura crua), clarifique o escopo com o usuario e entre em plan mode ' +
    '(plano para aprovar) antes de codar; feature/chore/bug detalhados podem ir direto.'

  server.registerTool(
    'list_items',
    {
      description: 'Lista itens do tracker. Use no inicio para ver pontas abertas antes de agir. Filtre (status/type/tag) sempre que souber o que procura - e mais barato e mais preciso. Projeto grande: se a lista nao couber com os corpos, ela vem como INDICE de TODOS os itens (id/numero/titulo/tipo/status/prioridade), abertos primeiro, com aviso - nenhum item fica de fora, e o corpo de um item sai por get_item(id). Se ainda assim vier cortada, continue pelo proximo_cursor.' + scoped,
      inputSchema: {
        project: z.string().optional(),
        status: ItemStatus.optional(),
        type: ItemType.optional(),
        tag: z.string().optional(),
        detail: z.enum(['index', 'full']).optional().describe('full (padrao): itens completos, caindo pro indice sozinho se nao couber. index: pede logo o indice enxuto.'),
        cursor: z.string().optional().describe('Continua de onde a resposta anterior parou. Use o proximo_cursor devolvido; e opaco, nao interprete o valor.'),
        limit: z.number().int().min(1).optional().describe('Teto de itens nesta resposta (o teto de tamanho vale de qualquer jeito).'),
      },
    },
    // #156: detail/cursor/limit sao da SAIDA, nao do storage - saem do filtro antes da API.
    async ({ detail, cursor, limit, ...filter }) => {
      try {
        const itens = (await api.listItems(filter)).map(blindarItem)
        return ok(respostaDeItens(itens, { detail, cursor, limit }))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'get_item',
    {
      description: 'Detalhe completo de um item por id. Chame antes de agir sobre um item para ver o estado atual. Traz junto a ficha dos ANEXOS do card (nome/tipo/tamanho): se houver imagem, abra com get_attachment(id) e OLHE - o print costuma ser o pedido inteiro.' + ideaHint,
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        return ok(comAnexos(blindarItem(await api.getItem(args.id))))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'add_item',
    {
      description: 'Cria um item (ponta solta). Chame ao descobrir trabalho novo a fazer.' + scoped,
      inputSchema: {
        project: z.string().optional(),
        title: z.string(),
        body: z.string().optional(),
        summary: z.string().max(600).optional().describe(DICA_RESUMO),
        type: ItemType.optional(),
        status: ItemStatus.optional(),
        priority: Priority.optional(),
        links: z.array(Ref).optional(),
        blocked_by: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        return ok(await api.addItem(args))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'update_item',
    {
      description:
        'Atualiza um item (status, notas, links). Chame ao concluir ou avancar trabalho. ' +
        'patch.summary: ' + DICA_RESUMO,
      inputSchema: { id: z.string(), patch: ItemPatch },
    },
    async (args) => {
      try {
        return ok(await api.updateItem(args.id, args.patch))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'move_item',
    {
      description: 'Reordena um item na lista do seu projeto (index 0-based; 0 = topo, um numero grande = fim). Use para controlar a ordem/cronologia dos itens.',
      inputSchema: { id: z.string(), index: z.number().int().min(0) },
    },
    async (args) => {
      try {
        return ok(await api.moveItem(args.id, args.index))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'get_next',
    {
      description: 'Retorna o proximo item aberto de maior prioridade, com a ficha dos anexos dele. Chame quando precisar decidir o que atacar a seguir.' + scoped + ideaHint,
      inputSchema: { project: z.string().optional() },
    },
    async (args) => {
      try {
        return ok(comAnexos(blindarItem(await api.getNext(args))))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'delete_item',
    {
      description: 'Apaga um item de vez (item + historico). Use quando um item foi criado por engano ou nao serve mais. Irreversivel.',
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        const deleted = await api.deleteItem(args.id)
        return ok({ deleted, id: args.id })
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'list_memory',
    {
      description: 'Le a MRP (Memoria Referencial de Projeto): comandos, deploy, gotchas, decisoes e contexto duraveis do projeto. Os TITULOS de todas as entradas ja vem no inicio da sessao. Por padrao devolve so o INDICE (id, categoria, titulo) - barato; use pra pegar os ids das entradas que interessam. Para o CONTEUDO: get_memory(id) le UMA entrada; list_memory({category, detail:"full"}) le os bodies de UMA categoria; detail:"full" sem category le TUDO (caro) - so quando precisar de varios bodies. Resposta grande demais vem PAGINADA: nesse caso vem um objeto com aviso/total/proximo_offset/entries - se proximo_offset nao for null, chame de novo com esse offset pra pegar o resto. SIGA o que estiver na MRP.' + scoped,
      inputSchema: {
        project: z.string().optional(),
        category: MemoryCategory.optional(),
        detail: z.enum(['index', 'full']).optional().describe('index (padrao): so id/categoria/titulo. full: bodies completos (combine com category pra escopar).'),
        offset: z.number().int().min(0).optional().describe('Pula as N primeiras entradas. Use o proximo_offset devolvido pela pagina anterior.'),
        limit: z.number().int().min(1).optional().describe('Teto de entradas nesta resposta (o teto de tamanho vale de qualquer jeito).'),
      },
    },
    // #93: default = INDICE (so id/category/title, ~1.5K tok em vez de ~18.5K de bodies). O body
    // vem sob demanda (get_memory ou detail:'full'). 'detail' nao vai pra api.listMemory.
    // #130: offset/limit sao da SAIDA, nao do storage - saem do filtro junto com o detail.
    async ({ detail, offset, limit, ...filter }) => {
      try {
        const entries = await api.listMemory(filter)
        const pag = { offset, limit }
        if (detail === 'full')
          return ok(paginarNoTeto(entries, { ...pag, dica: ', ou filtre por category pra uma fatia menor', cortar: cortarCorpo }))
        return ok(paginarNoTeto(entries.map((e) => ({ id: e.id, category: e.category, title: e.title })), pag))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'get_memory',
    {
      description: 'Le o CONTEUDO completo de UMA entrada da MRP por id (o body inteiro). Use pra abrir so a entrada relevante, a partir do indice do list_memory (ou dos titulos do inicio da sessao). Barato por design - nao puxe a MRP toda pra ler uma nota.',
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        const entry = await api.getMemory(args.id)
        if (!entry) return fail(new Error('entrada da MRP nao encontrada'))
        return ok(entry)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'add_memory',
    {
      description: 'Registra conhecimento duravel de REFERENCIA na MRP do projeto (comando, deploy, gotcha, decisao, contexto) - o que um agente precisa LER pra nao redescobrir. ' + REGUA_MRP + ' Grave so o PORQUE nao-obvio + a implicacao de futuro; NAO duplique SQL, constantes, estrutura de tabela nem passo-a-passo (isso vive no codigo/commit - no maximo aponte pra la). NAO registre trabalho-a-fazer/follow-up/backlog: isso e item do tracker (use add_item). Corte deliberado vira referencia com ponteiro pro item ("out-of-scope, ver #86"), nao TODO. Cheque list_memory antes para nao duplicar.' + scoped,
      inputSchema: {
        project: z.string().optional(),
        category: MemoryCategory,
        title: z.string().describe('Curto (ate ~60 caracteres): o ASSUNTO, nao o resumo. Titulo longo e cortado na exibicao.'),
        body: z.string(),
        hint: z.string().describe('O GANCHO, uma linha: o que essa entrada poupa e QUANDO abri-la. Numa MRP grande e a UNICA coisa que o agente ve alem do titulo, entao e ele que decide se a entrada e lida. Escreva pra quem ainda nao sabe que precisa dela: "Vai te custar 1h cacando cache. Abra ANTES de mexer em pagina de autoatendimento."'),
      },
    },
    async (args) => {
      try {
        return ok(await api.addMemory(args))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'update_memory',
    {
      description: 'Corrige uma entrada da MRP ou aposenta com patch {archived: true}. Prefira aposentar a apagar.',
      inputSchema: { id: z.string(), patch: MemoryPatch },
    },
    async (args) => {
      try {
        return ok(await api.updateMemory(args.id, args.patch))
      } catch (e) {
        return fail(e)
      }
    },
  )

  // Faxina (item #171). DUAS chamadas, nao duas tools: sem keep/archive devolve o lote a julgar;
  // com eles, fecha a rodada. ESPELHO de review_memory em tether/src/mcp/tools.ts.
  server.registerTool(
    'review_memory',
    {
      description:
        `FAXINA da MRP. Chame sem argumentos quando o inicio da sessao avisar que a faxina esta pendente (ou quando o usuario pedir limpeza): devolve um LOTE de entradas pra julgar, a regua e o que fazer. Depois chame de novo com keep/archive pra fechar a rodada. Existe porque a MRP so crescia: entrada boa e entrada morta ficavam lado a lado ate o indice virar parede de texto. O alvo e ${MRP_ALVO} entradas ativas por projeto - alvo desta faxina, nao trava do add_memory. Quem julga tem que ser a sessao que trabalha DENTRO do projeto: so ela consegue conferir se a nota ainda e verdade.` + scoped,
      inputSchema: {
        project: z.string().optional(),
        keep: z.array(z.string()).optional().describe('ids que CONTINUAM valendo (so carimba o julgamento; nao mexe na entrada).'),
        archive: z.array(z.object({
          id: z.string(),
          reason: z.string().describe('por que sai, em uma linha. Fica no historico da entrada, pra quem for desarquivar entender.'),
        })).optional().describe('ids que SAEM da MRP. Arquiva (reversivel pelo dashboard), nunca apaga.'),
      },
    },
    async ({ keep, archive, ...resto }) => {
      try {
        if (keep?.length || archive?.length)
          return ok(await api.reviewMemory({ ...resto, keep: keep ?? [], archive: archive ?? [] }))
        const plano = planejarFaxina(await api.listMemory(resto), Date.now())
        const cabecalho = {
          projeto: resto.project ?? config.project ?? null,
          total: plano.total, alvo: plano.alvo, excedente: plano.excedente,
          por_julgar: plano.lote.length, nunca_revisadas: plano.novas,
          regua: REGUA_MRP,
          instrucao: INSTRUCAO_FAXINA,
        }
        // O lote e o unico campo que cresce: desconta o cabecalho do teto antes de paginar.
        const folga = JSON.stringify(cabecalho, null, 2).length + 200
        return ok({ ...cabecalho, lote: paginarNoTeto(plano.lote, { teto: TETO_RESPOSTA_CHARS - folga, cortar: cortarCorpo }) })
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'add_reminder',
    {
      description:
        'Registra um lembrete/agendamento no Trail. Chame SEMPRE que prometer avisar algo no futuro ' +
        '("quando chegar o dia X eu te lembro") ou combinar de retomar algo numa data - a sessao nao ' +
        'fica aberta pra lembrar sozinha; o Trail guarda e mostra no dashboard (aba Lembretes).' + scoped,
      inputSchema: {
        project: z.string().optional(),
        message: z.string(),
        remind_at: z.string().describe('data/hora do lembrete em ISO 8601 (ex: 2026-08-01 ou 2026-08-01T09:00:00Z)'),
        item_id: z.string().optional().describe('id de um item do tracker a vincular (opcional)'),
      },
    },
    async (args) => {
      try {
        return ok(await api.addReminder(args))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'list_reminders',
    {
      description: 'Lista os lembretes/agendamentos do projeto (pendentes por padrao; ordenados por data). Chame pra conferir o que ja foi agendado.' + scoped,
      inputSchema: {
        project: z.string().optional(),
        status: ReminderStatus.optional(),
      },
    },
    async (args) => {
      try {
        return ok(await api.listReminders(args))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'add_attachment',
    {
      description: 'Anexa um arquivo (base64) a um card do tracker. Use pra guardar spec, doc ou planilha relevante ao card. Nasce INTERNO (so o time ve); passe shared_with_client=true pra o cliente do portal poder baixar.' + scoped,
      inputSchema: {
        item_id: z.string(),
        project: z.string().optional(),
        filename: z.string(),
        content_base64: z.string().describe('conteudo do arquivo em base64'),
        description: z.string().optional().describe('resumo curto do anexo (a IA le isso na lista, barato)'),
        shared_with_client: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const { item_id, ...input } = args
        return ok(await api.addAttachment(item_id, input))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'get_attachment',
    {
      description: 'Le o CONTEUDO de um anexo sob demanda. IMAGEM VOLTA COMO IMAGEM DE VERDADE: se o card tem foto/print, CHAME AQUI e OLHE antes de perguntar ao usuario a que ele se refere. Texto extraido pra txt/csv. Nao chame a toa - a ficha dos anexos (nome, tipo, tamanho) ja vem no get_item.',
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        const meta = await api.getAttachment(args.id)
        if (!meta) return fail(new Error('anexo nao encontrado'))
        if (meta.extracted_text) return ok({ ...meta, text: meta.extracted_text })
        if (meta.content_type.startsWith('image/')) {
          if (meta.size_bytes > MAX_IMAGEM_BYTES)
            return ok({ ...meta, note: `imagem grande demais para ler aqui (limite ${MAX_IMAGEM_BYTES} bytes); baixe pelo dashboard` })
          const bytes = await api.downloadAttachment(args.id)
          if (!bytes) return fail(new Error('anexo nao encontrado'))
          return {
            content: [
              ...ok({ ...meta, note: 'a imagem vai no bloco seguinte' }).content,
              { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: meta.content_type },
            ],
          }
        }
        return ok({ ...meta, note: 'sem texto extraido; baixe pelo dashboard para processar' })
      } catch (e) {
        return fail(e)
      }
    },
  )

  await server.connect(new StdioServerTransport())
}
