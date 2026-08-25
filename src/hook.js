import { basename } from 'node:path'
import { resolveConfig } from './config.js'
import { findTetherProject } from './tether-file.js'
import { formatFaxina } from './memory-review.js'

// Hooks de sessao do Claude Code falando com a API do Trail (mesmo desenho dos hooks do
// repo principal, portado pro cliente standalone): "context" injeta itens abertos + MRP no
// inicio da sessao; "reconcile" existe so por compatibilidade e nao fala mais nada (v1.11.0).
// REGRA DE OURO: hook NUNCA derruba nem atrasa a sessao - qualquer falha (sem login, sem
// rede, timeout, HTTP ruim) vira exit 0 silencioso. Nada aqui sai por exit != 0.

const CATEGORY_ORDER = ['command', 'deploy', 'gotcha', 'decision', 'context']
const CATEGORY_LABEL = {
  command: 'Comandos',
  deploy: 'Deploy',
  gotcha: 'Gotchas',
  decision: 'Decisoes',
  context: 'Contexto',
}

// Tambem migrou do fim do turno para a abertura, pelo mesmo motivo do STATUS_CONVENTION.
// Nao repete a regua inteira (ela vive na description do add_memory, que a IA ja tem em contexto):
// aqui so lembra que ela existe e que o padrao e NAO gravar - era esse default que faltava.
export const MEMORY_REMINDER =
  'Descobriu algo duravel do projeto nesta sessao? Antes de gravar na MRP, passe pela regua do add_memory (as TRES perguntas) - o padrao e NAO gravar, e trabalho-a-fazer vira item do tracker. Aposente entrada velha com update_memory.'

function line(i) {
  // #N = "ponto N" (numero 1-based na ordem natural do projeto), o MESMO que a UI mostra e que
  // humanos/commits usam - pra IA nao traduzir via position (0-based, com gaps) e pegar o item
  // errado. Vem do payload da API (/api/items). Omite o #N se faltar (nao imprime "#undefined").
  const n = i.number != null ? `#${i.number} ` : ''
  return `- ${n}[${i.type}/${i.status}/${i.priority}] ${i.title} (${i.id})`
}

// Convencao do item #11: idea = captura crua. Ao atacar, a IA clarifica escopo + plan mode
// antes de codar (feature/chore/bug ja detalhados vao direto). So aparece quando ha idea aberta.
export const IDEA_CONVENTION =
  'Convencao para itens type=idea (captura crua do usuario): ao atacar uma idea, NAO saia codando. ' +
  'Primeiro clarifique o escopo com o usuario e apresente um plano para aprovacao (plan mode) antes de ' +
  'implementar. Itens feature/chore/bug ja detalhados podem ir direto.'

// Convencao do item #12: a sessao nao fica aberta pra "lembrar sozinha" numa data futura. Se a IA
// prometer avisar algo, ela grava AGORA no Trail (add_reminder), que guarda e mostra no dashboard.
export const REMINDER_CONVENTION =
  'Lembretes: se voce prometer avisar algo no futuro ("quando chegar o dia X eu te lembro") ou ' +
  'combinar de retomar algo numa data, registre AGORA via add_reminder (message + remind_at ISO) - ' +
  'a sessao nao fica aberta pra lembrar sozinha; o Trail guarda e mostra na aba Lembretes.'

// Antes esta cobranca vivia no fim de cada turno (hook de Stop). Ela custava uma resposta extra
// na tela por mensagem trocada, entao migrou para a abertura: dita uma vez, de graca. Fica FORA
// do formatContext porque vale tambem em projeto que abre sem nenhum item aberto.
export const STATUS_CONVENTION =
  'Status em dia: marque in_progress ao COMECAR um item (update_item) e feche-o na mesma sessao - ' +
  'done se concluiu, blocked se travou, todo se nao avancou - com nota/link de evidencia. Nada ' +
  'cobra isso no fim da conversa: item que voce deixar marcado in_progress fica mentindo no tracker.'

export function formatContext(open) {
  const body = open.map(line).join('\n')
  const base = `Tracker Trail deste projeto - ${open.length} item(ns) aberto(s):\n${body}\n\nConsulte/atualize via as tools do MCP tether (list_items, get_item, update_item, get_next) conforme avancar.`
  const withIdea = open.some((i) => i.type === 'idea') ? `${base}\n\n${IDEA_CONVENTION}` : base
  return `${withIdea}\n\n${REMINDER_CONVENTION}`
}

const TITLE_MAX = 70
const HINT_MAX = 200

// Corte so na EXIBICAO - o dado nunca e truncado.
function oneLine(s, max) {
  const flat = String(s).replace(/\s*\n\s*/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + '…'
}

// Espelho de src/hooks/format.ts (tether). A MRP inteira so cabe no inicio da sessao enquanto o
// projeto e novo; passado o cap sobra o INDICE (titulo + gancho), e o corpo vem do get_memory.
export function formatMemory(entries) {
  const active = entries.filter((e) => !e.archived)
  if (active.length === 0)
    return 'MRP (Memoria Referencial de Projeto) vazia - ao descobrir comando, gotcha ou decisao duravel do projeto, registre via add_memory.'
  const totalChars = active.reduce((n, e) => n + e.body.length, 0)
  const compact = active.length > 30 || totalChars > 8000
  const lines = [
    `MRP (Memoria Referencial de Projeto) - ${active.length} entrada(s)${compact ? ' [indice: titulo + gancho. O corpo vem do get_memory(id); list_memory da os ids]' : ''}:`,
  ]
  for (const cat of CATEGORY_ORDER) {
    const group = active.filter((e) => e.category === cat)
    if (group.length === 0) continue
    lines.push(`[${CATEGORY_LABEL[cat]}]`)
    for (const e of group) {
      if (!compact) {
        lines.push(`- ${e.title}: ${e.body.replace(/\n/g, '\n  ')}`)
        continue
      }
      lines.push(`- ${oneLine(e.title, TITLE_MAX)}`)
      // `?? ''` obrigatorio: aqui o JSON de /api/memory chega CRU. Servidor ainda nao migrado
      // manda a entrada sem o campo, e sem isso o bloco inteiro da sessao quebra.
      const hint = oneLine(e.hint ?? '', HINT_MAX)
      if (hint) lines.push(`  > ${hint}`)
    }
  }
  lines.push(
    compact
      ? 'O gancho (>) diz QUANDO a entrada importa. Antes de mexer numa area coberta por um gancho acima, ABRA a entrada com get_memory(id) - nao trabalhe so pelo titulo.'
      : 'Siga o que esta na MRP ao trabalhar neste projeto.',
  )
  // Backfill oportunista (item #133): so aparece enquanto HA o que preencher e some sozinho no
  // zero - nunca vira ruido permanente.
  const semGancho = active.filter((e) => !(e.hint ?? '').trim()).length
  if (semGancho > 0) {
    lines.push(
      `[${semGancho} destas entradas ainda estao sem gancho] Ao ABRIR uma delas e ver que nao tem o gancho, escreva um antes de seguir: update_memory(id, {hint: "..."}) - uma linha com o que a entrada poupa e QUANDO abri-la. Nao interrompa a tarefa do usuario pra preencher em lote; se ele PEDIR o backfill, ai sim faca todas de uma vez.`,
    )
  }
  lines.push(MEMORY_REMINDER)
  return lines.join('\n')
}

// Lembretes VENCIDOS na abertura da sessao (item #70). Espelho de formatLembretes em
// src/hooks/format.ts (tether). O lembrete ja avisava a pessoa no sino do produto; a IA que abre a
// pasta ficava de fora, e era ela quem ia mexer no assunto.
//
// So o que JA venceu. Lembrete marcado para daqui a duas semanas nao e informacao no comeco desta
// sessao - seria ruido em toda abertura ate a data chegar.
const LEMBRETES_NA_LISTA = 10

function diaISO(ts) {
  return new Date(ts).toISOString().slice(0, 10)
}

export function formatLembretes(entries, agora = Date.now()) {
  const vencidos = (entries ?? [])
    // Numero/`??` obrigatorios: aqui o JSON de /api/reminders chega CRU, sem validacao. Servidor
    // ainda nao migrado manda o registro sem os campos novos, e uma excecao aqui derruba o bloco
    // INTEIRO de abertura - itens e MRP junto.
    .filter((e) => (e.status ?? 'pending') === 'pending')
    .filter((e) => Number.isFinite(Number(e.remind_at)) && Number(e.remind_at) <= agora)
    .sort((a, b) => Number(a.remind_at) - Number(b.remind_at))
  if (vencidos.length === 0) return null
  const mostrados = vencidos.slice(0, LEMBRETES_NA_LISTA)
  const lines = [
    `[LEMBRETES VENCIDOS] ${vencidos.length} lembrete(s) com a data ja passada neste projeto:`,
    ...mostrados.map((e) => `- ${diaISO(Number(e.remind_at))}: ${e.message} (${e.id})`),
  ]
  if (vencidos.length > mostrados.length)
    lines.push(`- ... e mais ${vencidos.length - mostrados.length}; list_reminders({status:"pending"}) traz a lista toda.`)
  lines.push(
    'Trate cada um ANTES de seguir: se o assunto ja esta resolvido, feche com update_reminder(id, {status:"done"}); ' +
      'se ainda nao, remarque a data com update_reminder(id, {remind_at:"AAAA-MM-DD"}). Lembrete vencido que ninguem ' +
      'fecha volta em toda abertura de sessao, e vira ruido que o usuario para de ler.',
  )
  return lines.join('\n')
}

function sessionStart(context) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })
}

async function fetchJson(url, token, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export async function runHook(command, input = {}, fetchImpl = fetch) {
  const cfg = resolveConfig()
  if (!cfg.url || !cfg.token) return { exitCode: 0 }
  const cwd = input.cwd ?? process.cwd()
  const project = process.env.TETHER_PROJECT || findTetherProject(cwd) || basename(cwd)
  const q = '?project=' + encodeURIComponent(project)

  if (command === 'context') {
    const [items, memory, lembretes] = await Promise.all([
      fetchJson(cfg.url + '/api/items' + q, cfg.token, fetchImpl),
      fetchJson(cfg.url + '/api/memory' + q, cfg.token, fetchImpl),
      fetchJson(cfg.url + '/api/reminders' + q + '&status=pending', cfg.token, fetchImpl),
    ])
    const open = (items ?? []).filter((i) => i.status !== 'done' && i.status !== 'dropped')
    const mem = memory ?? []
    // Servidor antigo (que ainda nao serve lembrete) devolve null: o bloco simplesmente nao
    // aparece, e nada mais muda.
    const avisoDeLembrete = formatLembretes(lembretes ?? [])
    // Silencio total em pasta sem nada rastreado - senao poluiria todo projeto da maquina, ja
    // que com a nuvem ligada qualquer pasta responde. A convencao de status vai junto sempre que
    // o hook ja fala (inclusive em projeto so com MRP): nada mais cobra item in_progress no fim
    // do turno.
    if (open.length === 0 && mem.length === 0 && !avisoDeLembrete) return { exitCode: 0 }
    const parts = []
    if (open.length > 0) parts.push(formatContext(open))
    parts.push(STATUS_CONVENTION)
    parts.push(formatMemory(mem))
    // As duas ultimas sao as que pedem acao ANTES de comecar - no meio do indice da MRP passariam
    // batidas. Entre elas, o lembrete fica por ULTIMO: a faxina e arrumacao da casa, e o lembrete e
    // um compromisso que a PESSOA marcou e cuja data ja passou.
    const faxina = formatFaxina(mem)
    if (faxina) parts.push(faxina)
    if (avisoDeLembrete) parts.push(avisoDeLembrete)
    return { exitCode: 0, stdout: sessionStart(parts.join('\n\n')) }
  }

  // Qualquer outro subcomando (na pratica so o "reconcile" do hook de Stop, morto na v1.11.0)
  // cai aqui calado. O bin ja sai antes de chegar neste ponto; isto e a rede de seguranca pra
  // quem chamar runHook direto. Motivo de ter morrido: medido no proprio Claude Code, qualquer
  // palavra devolvida no fim de um turno - exit 2 com stderr, decision:block OU additionalContext
  // - reabre o turno e o modelo produz MAIS UMA resposta na tela do usuario, e o Stop dispara a
  // CADA fim de turno. O que ele cobrava migrou pro texto de abertura da sessao.
  return { exitCode: 0 }
}
