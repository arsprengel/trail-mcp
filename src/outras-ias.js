import { homedir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { configDir, resolveConfig, readSaved } from './config.js'
import { comandoDoGancho, grupoTemGanchoDoTrail } from './hooks-install.js'

// Ligar o Trail nas IAs que NAO sao o Claude Code: Gemini CLI e Antigravity.
//
// Por que este arquivo existe separado do hooks-install.js: as tres IAs guardam a configuracao em
// formatos diferentes, e o do Antigravity nao se parece com nenhum dos outros dois. Misturar tudo
// naquele arquivo faria o caminho do Claude Code - o unico que ja esta em producao - correr risco
// a toa. Aqui reusamos a DISCIPLINA de la (copia de seguranca, idempotencia, arquivo ilegivel
// aborta, marca pra quem removeu de proposito) e o proprio reconhecedor de "gancho nosso".
//
// O ACHADO QUE CRIOU ESTE ARQUIVO (01/09/2026): o comando que o guia ensina para Gemini/Antigravity
// grava o servidor em ~/.gemini/settings.json, mas o Antigravity le ~/.gemini/config/mcp_config.json.
// Sao arquivos diferentes na mesma pasta. Quem ligava pelo Antigravity via "conectado com sucesso"
// e ficava sem nenhuma ferramenta do Trail.

const PACOTE = 'usetrail'
const NOME_SERVIDOR = 'trail'
const NOME_GANCHO = 'trail'

// O tempo limite NATIVO do gancho do Antigravity. Ele bloqueia o laco do agente enquanto roda, e o
// padrao dele e 30s. 25s deixa folga sobre os 4s de rede do resumo e sobre a trava interna do
// atalho (20s), entao quem corta primeiro e sempre o nosso lado, que sabe devolver vazio.
const LIMITE_GANCHO_S = 25

// Carimbo do atalho. Sobe quando o CONTEUDO do atalho muda - e so isso destrava a reescrita nas
// maquinas que ja tem a versao anterior instalada.
export const VERSAO_ATALHO = 1

export function geminiDir() {
  return join(homedir(), '.gemini')
}

export function geminiSettingsPath() {
  return join(geminiDir(), 'settings.json')
}

// A configuracao do Antigravity mora numa subpasta da pasta do Gemini. Se ela nao existe, o
// Antigravity nao esta nesta maquina - e criar seria fabricar configuracao de programa ausente.
export function antigravityDir() {
  return join(geminiDir(), 'config')
}

export function antigravityMcpPath() {
  return join(antigravityDir(), 'mcp_config.json')
}

export function antigravityHooksPath() {
  return join(antigravityDir(), 'hooks.json')
}

export function atalhoPath() {
  return join(configDir(), 'antigravity-hook.mjs')
}

// UM ARQUIVO POR MARCA, e nao um arquivo com varias chaves. Cada sessao da IA sobe o seu proprio
// conector, entao ha varios processos escrevendo ao mesmo tempo; num arquivo compartilhado, o
// ler-mesclar-gravar perde a chave que o outro processo acabou de escrever (medido: 48 perdas em
// 200 pares simultaneos), e marca perdida faz voltar sozinho o que a pessoa removeu de proposito.
// Arquivo por marca nao tem como se atropelar: ninguem le pra escrever.
function marcaPath(chave) {
  return join(configDir(), 'marcas', chave)
}

function jaTentou(chave) {
  return existsSync(marcaPath(chave))
}

function marcar(chave) {
  try {
    mkdirSync(dirname(marcaPath(chave)), { recursive: true })
    writeFileSync(marcaPath(chave), new Date().toISOString() + '\n')
  } catch {
    /* sem pasta gravavel: o pior caso e tentar de novo depois */
  }
}

function noPath(nome) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) if (existsSync(join(dir, nome + ext))) return true
  }
  return false
}

// ATENCAO: a pasta ~/.gemini NAO serve para reconhecer o Gemini CLI. O Antigravity roda sobre o
// mesmo nucleo e mora na MESMA pasta, entao numa maquina so com Antigravity ela existe. Reconhecer
// por ela faria o conector escrever um gancho de sessao do Gemini CLI na maquina de quem nao tem
// Gemini CLI - o mesmo tipo de invasao que ja aconteceu com o Claude Code. O sinal e o ARQUIVO de
// configuracao dele. O binario no caminho do sistema so e consultado pelo comando explicito, que
// cobre quem acabou de instalar e ainda nao abriu nenhuma sessao.
export function temGeminiCli({ olharPath = false } = {}) {
  if (existsSync(geminiSettingsPath())) return true
  return olharPath ? noPath('gemini') : false
}

export function temAntigravity() {
  return existsSync(antigravityDir())
}

// Le um arquivo de configuracao JSON. ZERO BYTE (ou so espaco em branco) conta como configuracao
// VAZIA, nao como ilegivel: e exatamente o estado do mcp_config.json numa instalacao nova do
// Antigravity, e tratar isso como "quebrado" faria o registro nunca acontecer em ninguem.
//   estado: 'vazio' (nao existe ou existe sem conteudo) | 'ok' | 'ilegivel'
function lerJson(path) {
  const existe = existsSync(path)
  if (!existe) return { estado: 'vazio', valor: {}, existe: false }
  let cru
  try {
    cru = readFileSync(path, 'utf8')
  } catch {
    return { estado: 'ilegivel', valor: null, existe: true }
  }
  if (cru.trim() === '') return { estado: 'vazio', valor: {}, existe: true }
  try {
    const v = JSON.parse(cru)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { estado: 'ilegivel', valor: null, existe: true }
    return { estado: 'ok', valor: v, existe: true }
  } catch {
    return { estado: 'ilegivel', valor: null, existe: true }
  }
}

// Copia de seguranca so quando ha o que salvar (arquivo vazio nao vira copia vazia) e SO NA
// PRIMEIRA VEZ. O conserto do gancho pode reescrever o arquivo em varias aberturas; copiando toda
// vez, a segunda passada gravaria por cima da copia o arquivo que NOS ja tinhamos mexido, e o
// original da pessoa - a unica coisa que a copia existe pra guardar - sumiria.
// Escreve ao lado e so entao troca de lugar. Escrever direto por cima era arriscado de verdade:
// isto roda na subida do servidor, que o cliente derruba a qualquer momento, e a pessoa ficaria
// com a propria configuracao cortada no meio.
function gravar(path, obj, tinhaConteudo) {
  mkdirSync(dirname(path), { recursive: true })
  if (tinhaConteudo && !existsSync(path + '.tether-bak')) copyFileSync(path, path + '.tether-bak')
  // Nome de temporario UNICO por processo. Com nome fixo, duas sessoes de IA subindo o conector ao
  // mesmo tempo escreveriam no mesmo temporario e o conteudo embaralhado dos dois chegaria
  // ATOMICAMENTE na configuracao da pessoa - pior do que a escrita cortada que isto veio evitar.
  const temp = `${path}.${process.pid}-${Math.random().toString(36).slice(2)}.tether-tmp`
  try {
    writeFileSync(temp, JSON.stringify(obj, null, 2) + '\n')
    renameSync(temp, path)
  } catch (e) {
    try {
      rmSync(temp)
    } catch {
      /* nem chegou a existir */
    }
    throw e
  }
}

function objeto(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null
}

// Um nome de chave que ainda nao existe no mapa. Quando chegamos aqui, ja sabemos que a chave
// preferida NAO e nossa (o reconhecimento por comando ja teria devolvido "ja tinha") - entao ela e
// de outra coisa que a pessoa configurou, e escrever por cima apagaria o trabalho dela.
function chaveLivre(mapa, base) {
  if (mapa[base] === undefined) return base
  for (let i = 2; ; i++) if (mapa[`${base}-${i}`] === undefined) return `${base}-${i}`
}

// ---------------------------------------------------------------------------
// #262 - o Trail no arquivo de servidores que o Antigravity realmente le
// ---------------------------------------------------------------------------

// So o COMANDO conta, e so o nome do pacote. A primeira versao disto procurava as palavras
// "trail"/"tether" no registro inteiro, caminhos incluidos - e ai quem tivesse qualquer outro
// servidor apontando pra uma pasta chamada "trailhead" (ou quem trabalha no proprio Trail) recebia
// "ja esta registrado", ficava sem nenhuma ferramenta do Trail, e o status ainda garantia que
// estava tudo certo. Ou seja: o defeito do #262 de volta, agora com o diagnostico mentindo junto.
function ehServidorDoTrail(cfg) {
  const c = objeto(cfg)
  if (!c) return false
  const linha = [c.command, ...(Array.isArray(c.args) ? c.args : [])].filter((x) => typeof x === 'string').join(' ')
  // O `.` no fim cobre o atalho do Windows (usetrail.cmd), que senao nao seria reconhecido como
  // nosso - e o registro seria feito de novo, por cima.
  return new RegExp(`(^|[\\s/\\\\])${PACOTE}(@|\\.|$|\\s)|tether-mcp`).test(linha)
}

//   'registrado' | 'ja-tinha' | 'sem-antigravity' | 'ilegivel' | 'falhou'
export function registrarMcpAntigravity() {
  if (!temAntigravity()) return 'sem-antigravity'
  const path = antigravityMcpPath()
  const lido = lerJson(path)
  if (lido.estado === 'ilegivel') return 'ilegivel'
  const cfg = lido.valor
  // Campo presente com o tipo errado NAO vira campo novo: substituir calado apagaria a
  // configuracao da pessoa e ainda diria "registrado".
  if (cfg.mcpServers !== undefined && !objeto(cfg.mcpServers)) return 'ilegivel'
  cfg.mcpServers = objeto(cfg.mcpServers) ?? {}
  if (Object.values(cfg.mcpServers).some(ehServidorDoTrail)) return 'ja-tinha'
  // A MESMA forma que o comando do guia ja grava para o Gemini CLI - e a que a propria IA do
  // Antigravity recomendou ao dono. Nao inventamos formato novo aqui.
  const servidor = { command: 'npx', args: ['-y', `${PACOTE}@latest`] }
  // A CREDENCIAL VAI JUNTO quando ela so existe no ambiente de quem esta rodando. Quem cola a
  // credencial no comando de registro em vez de entrar pela conta deixa o token dentro da
  // configuracao de UMA IA; sem repeti-la aqui, o Antigravity sobe o Trail, mostra as ferramentas
  // e todas respondem vazio - "ligado" na tela e mudo na pratica. Nao gravamos a credencial em
  // lugar nenhum alem deste arquivo, que e o mesmo tipo de lugar onde a pessoa ja a colocou; assim
  // desconectar continua funcionando do mesmo jeito para as duas IAs.
  try {
    const cfgAtual = resolveConfig()
    if (cfgAtual.token && !readSaved()?.token) servidor.env = { TRAIL_API_TOKEN: cfgAtual.token }
  } catch {
    /* sem credencial nenhuma: registra sem env, e o login depois resolve */
  }
  cfg.mcpServers[chaveLivre(cfg.mcpServers, NOME_SERVIDOR)] = servidor
  try {
    gravar(path, cfg, lido.estado === 'ok')
  } catch {
    return 'falhou'
  }
  return 'registrado'
}

//   'ligado' | 'ausente' | 'ilegivel'
export function estadoMcpAntigravity() {
  const lido = lerJson(antigravityMcpPath())
  if (lido.estado === 'ilegivel') return 'ilegivel'
  if (lido.valor.mcpServers !== undefined && !objeto(lido.valor.mcpServers)) return 'ilegivel'
  const servidores = objeto(lido.valor.mcpServers) ?? {}
  return Object.values(servidores).some(ehServidorDoTrail) ? 'ligado' : 'ausente'
}

// ---------------------------------------------------------------------------
// #263a - resumo de abertura no Gemini CLI
// ---------------------------------------------------------------------------

// O Gemini CLI usa o MESMO envelope de saida do Claude Code (conferido na fonte da versao 0.34.0):
// hookSpecificOutput.additionalContext. Entao o comando e o mesmo de sempre, sem variante de texto
// puro - alias, texto puro seria ATIVAMENTE errado la: ele exige que a saida do gancho seja so
// JSON. Sem filtro de origem de proposito: assim o resumo chega ao abrir, ao retomar e depois de
// limpar a conversa.
//   'instalado' | 'ja-tinha' | 'sem-gemini' | 'ilegivel' | 'falhou'
export function instalarGanchoGemini({ olharPath = false } = {}) {
  if (!temGeminiCli({ olharPath })) return 'sem-gemini'
  const path = geminiSettingsPath()
  const lido = lerJson(path)
  if (lido.estado === 'ilegivel') return 'ilegivel'
  const settings = lido.valor
  // Mesmo cuidado do registro de servidores: campo presente com o tipo errado aborta, nunca vira
  // campo novo por cima do que a pessoa tinha.
  if (settings.hooks !== undefined && !objeto(settings.hooks)) return 'ilegivel'
  settings.hooks = objeto(settings.hooks) ?? {}
  if (settings.hooks.SessionStart !== undefined && !Array.isArray(settings.hooks.SessionStart)) return 'ilegivel'
  const grupos = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : []
  if (grupoTemGanchoDoTrail(grupos, 'context')) return 'ja-tinha'
  grupos.push({ hooks: [{ type: 'command', command: comandoDoGancho() }] })
  settings.hooks.SessionStart = grupos
  try {
    gravar(path, settings, lido.estado === 'ok')
  } catch {
    return 'falhou'
  }
  return 'instalado'
}

//   'ligado' | 'ausente' | 'ilegivel'
export function estadoGanchoGemini() {
  const lido = lerJson(geminiSettingsPath())
  if (lido.estado === 'ilegivel') return 'ilegivel'
  // O MESMO julgamento do caminho de escrita. Sem isto o status dizia "ausente" e mandava rodar o
  // comando, o comando respondia "configuracao ilegivel" e nada mudava - a pessoa ficava num
  // vaivem sem fim entre um diagnostico e um remedio que discordavam.
  const hooks = lido.valor.hooks
  if (hooks !== undefined && !objeto(hooks)) return 'ilegivel'
  if (objeto(hooks)?.SessionStart !== undefined && !Array.isArray(hooks.SessionStart)) return 'ilegivel'
  return grupoTemGanchoDoTrail(objeto(hooks)?.SessionStart, 'context') ? 'ligado' : 'ausente'
}

// ---------------------------------------------------------------------------
// #263b - resumo de abertura no Antigravity
// ---------------------------------------------------------------------------

// O atalho local. Existe por um motivo so, e ele e caro: o gancho do Antigravity dispara antes de
// CADA pensada da IA (nao por mensagem do usuario) e BLOQUEIA o laco do agente enquanto roda.
// Chamar o pacote publicado a cada disparo custaria ~1s por pensada e deixaria a IA do cliente
// lenta o tempo todo. O atalho custa so a partida do Node, decide em disco se ja falou nesta
// conversa e, so na PRIMEIRA vez, chama o pacote.
//
// Ele NAO tem formatacao nenhuma de proposito: so decide e delega. Assim o carimbo de versao
// quase nunca muda, e o conteudo do resumo continua vivendo num lugar so (o pacote).
const ATALHO = `#!/usr/bin/env node
// trail-atalho v${VERSAO_ATALHO} - gerado pelo conector do Trail. Nao edite: ele e reescrito.
//
// Por que existe: o gatilho do Antigravity dispara antes de CADA pensada da IA e BLOQUEIA o laco
// do agente enquanto roda. Chamar o pacote publicado a cada disparo custaria ~1s por pensada. Este
// atalho custa so a partida do Node, decide se ja falou nesta conversa, e so na PRIMEIRA vez chama
// o conector. Nao ha formatacao nenhuma aqui de proposito: assim ele nao envelhece com o conteudo.
import { spawn } from 'node:child_process'
import { readdirSync, mkdirSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const AQUI = dirname(fileURLToPath(import.meta.url))
// UM ARQUIVO POR CONVERSA, criado com "falhe se ja existir". Guardar todas numa lista dentro de um
// arquivo so parecia mais arrumado e era um defeito grave: o Antigravity roda pensadas em
// paralelo, entao varios atalhos gravam ao mesmo tempo, e o ler-mesclar-gravar apaga a marca que o
// outro acabou de escrever. Medido: de 40 conversas simultaneas, 39 perdiam a marca e recebiam o
// resumo de novo, no meio da conversa. Criar arquivo e a unica operacao que o sistema garante ser
// de um so - ou voce criou, ou alguem ja tinha criado.
const PASTA = join(AQUI, 'antigravity-conversas')
const TETO = 400
const TRAVA_MS = Number(process.env.TRAIL_ATALHO_TRAVA_MS) || 20000

let respondido = false
let marcaFeita = null
let filho = null

// Responde UMA vez e so. A escrita e assincrona, entao quem chama tem que devolver na mesma linha
// (return sai(...)) - senao o resto da funcao continua rodando depois de a resposta ter saido.
function sai(texto, desfazer = false) {
  if (respondido) return
  respondido = true
  // DESFAZ a marca so quando o conector nao conseguiu nem responder direito (nao rodou, morreu,
  // estourou o tempo, devolveu coisa que nao e JSON). Ai vale tentar de novo na proxima pensada.
  // Quando ele responde vazio de forma limpa - pasta sem projeto no Trail, sem login - a marca
  // FICA: insistir custaria a partida de um processo antes de cada pensada da IA, pra sempre.
  if (desfazer && marcaFeita) {
    try {
      rmSync(marcaFeita)
    } catch {
      /* nada a desfazer */
    }
  }
  if (filho) {
    try {
      filho.kill()
    } catch {
      /* ja morreu */
    }
  }
  process.stdout.write(texto, () => process.exit(0))
}

// A trava vale desde antes da leitura: se o Antigravity nao fechar a entrada, esperar pra sempre
// deixaria a IA da pessoa parada, porque este gatilho bloqueia o laco dela.
setTimeout(() => sai('{}', true), TRAVA_MS)

// Nome de arquivo seguro a partir do identificador da conversa, sem depender do que vem de fora.
function nomeDaMarca(id) {
  let h = 5381
  for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0
  return id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) + '-' + h.toString(36)
}

// Poda: so roda quando uma conversa nova e marcada, entao quase nunca.
function podar() {
  try {
    const nomes = readdirSync(PASTA)
    if (nomes.length <= TETO) return
    nomes
      .map((n) => ({ n, t: statSync(join(PASTA, n)).mtimeMs }))
      .sort((a, b) => a.t - b.t)
      .slice(0, nomes.length - TETO / 2)
      .forEach((x) => {
        try {
          rmSync(join(PASTA, x.n))
        } catch {
          /* outro processo ja apagou */
        }
      })
  } catch {
    /* poda e enfeite: nunca pode atrapalhar */
  }
}

// O npx que vive AO LADO do proprio Node em uso. Chamar so "npx" era incoerente com o resto: o
// comando do gatilho aponta pro Node por caminho absoluto justamente porque o programa que abre a
// IA pode nao ter o Node no caminho do sistema - e onde o Node nao esta, o npx tambem nao.
function acharNpx() {
  // Regulavel por variavel de ambiente so pra prova conseguir trocar o conector por um de mentira
  // sem tocar a rede - na vida real ninguem define isso.
  if (process.env.TRAIL_ATALHO_NPX) return process.env.TRAIL_ATALHO_NPX
  const ao_lado = join(dirname(process.execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx')
  return existsSync(ao_lado) ? ao_lado : 'npx'
}

async function main() {
  let cru = ''
  try {
    const pedacos = []
    for await (const c of process.stdin) pedacos.push(c)
    cru = Buffer.concat(pedacos).toString('utf8').trim()
  } catch {
    /* entrada ruim: segue e cai no silencio abaixo */
  }
  let entrada = {}
  try {
    const v = JSON.parse(cru)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) entrada = v
  } catch {
    /* idem */
  }

  // SO texto ou numero serve como identificador. Objeto ou lista nunca casariam na comparacao, e o
  // resumo entraria em TODA pensada - o desastre que este desenho existe pra evitar.
  const bruto = entrada.conversationId ?? entrada.conversation_id
  const conversa = (typeof bruto === 'string' || typeof bruto === 'number') && String(bruto).length > 0 && String(bruto).length <= 200 ? String(bruto) : null
  if (conversa) {
    const marca = join(PASTA, nomeDaMarca(conversa))
    try {
      mkdirSync(PASTA, { recursive: true })
      // "wx" = crie, e falhe se ja existir. E o teste-e-marca de uma so vez.
      writeFileSync(marca, '', { flag: 'wx' })
      marcaFeita = marca
      podar()
    } catch {
      return sai('{}')
    }
  } else {
    // Sem identificar a conversa, so o comeco dela pode falar. Sem os dois sinais, silencio: e
    // melhor nao falar do que falar em toda pensada da IA.
    const n = Number(entrada.invocationNum ?? entrada.invocation_num)
    if (!(n === 0 || n === 1)) return sai('{}')
  }

  filho = spawn(acharNpx(), ['-y', '--silent', '${PACOTE}@latest', 'hook', 'antigravity'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  })
  // Junta os PEDACOS e so no fim vira texto. Somando pedaco a pedaco, um caractere acentuado que
  // caisse na fronteira virava lixo - e o JSON continuava valido, entao o texto estragado seguia
  // pro modelo sem ninguem notar.
  const saida = []
  filho.stdout.on('data', (d) => {
    saida.push(d)
  })
  filho.on('error', () => sai('{}', true))
  // O filho pode terminar sem ler a entrada (sem rede, registro fora do ar, pacote que nao
  // resolve). A falha de escrita chega DEPOIS, como evento, e sem este ouvinte ela virava erro nao
  // tratado: o gatilho morria alto, com rastro de pilha, dentro do laco da IA do cliente.
  filho.stdin.on('error', () => sai('{}', true))
  filho.on('close', (codigo) => {
    const texto = Buffer.concat(saida).toString('utf8')
    // Saida que nao e JSON nao pode ser repassada: o Antigravity le stdout como o resultado do
    // gatilho, e texto solto ali seria erro na cara da pessoa.
    try {
      JSON.parse(texto)
    } catch {
      return sai('{}', true)
    }
    if (codigo !== 0) return sai('{}', true)
    return sai(texto)
  })
  try {
    filho.stdin.end(cru)
  } catch {
    /* o ouvinte acima cobre */
  }
}

main().catch(() => sai('{}', true))
`

// O caminho ABSOLUTO do Node em uso, e nao a palavra "node": o interpretador que roda o gancho no
// Windows pode nao ter o Node no caminho do sistema.
//
// O PAR DE ASPAS EXTERNO NO WINDOWS NAO E ENFEITE - sem ele NADA funciona la. O gancho e executado
// por interpretador de linha de comando, e a regra dele e: havendo mais de duas aspas na linha,
// ele APAGA a primeira e a ultima. Com dois caminhos entre aspas sao quatro, entao a linha chega
// no sistema partida e o comando morre - em qualquer caminho, com ou sem espaco. Envolvendo tudo
// num par a mais, e esse par que e comido e o resto chega inteiro. (Conferido rodando no Windows
// desta maquina: sem o par externo, "'C:\\Program' nao e reconhecido"; com ele, devolve o vazio
// esperado.) O gancho do Claude Code escapa disso por sorte: o comando dele comeca sem aspas.
function comandoDoAtalho() {
  const base = `"${process.execPath}" "${atalhoPath()}"`
  return process.platform === 'win32' ? `"${base}"` : base
}

function atalhoDesatualizado() {
  try {
    return !readFileSync(atalhoPath(), 'utf8').includes(`trail-atalho v${VERSAO_ATALHO}`)
  } catch {
    return true
  }
}

function escreverAtalho() {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(atalhoPath(), ATALHO)
}

// O arquivo de ganchos do Antigravity tem forma PROPRIA: um MAPA nome-do-gancho -> eventos, e o
// evento de antes-da-pensada e uma lista PLANA de comandos (sem o embrulho de grupo com filtro que
// o Claude Code e o Gemini usam). Escrever a forma do Claude Code aqui produz um arquivo que o
// Antigravity ignora EM SILENCIO - por isso nada de reusar o formato de la.
function comandosPreInvocation(cfg) {
  const out = []
  for (const [nome, spec] of Object.entries(cfg)) {
    const s = objeto(spec)
    if (!s) continue
    // `enabled: false` e o jeito documentado de desligar um gancho sem apagar. Ele entra na lista
    // (pra nao duplicarmos o registro dela), mas marcado - o status precisa dizer "desligado" em
    // vez de "ligado", senao a pessoa que desligou de proposito recebe a garantia de que esta on.
    for (const h of Array.isArray(s.PreInvocation) ? s.PreInvocation : []) out.push({ nome, h, ligado: s.enabled !== false })
  }
  return out
}

// SO pelo comando. Reconhecer pelo NOME da chave ('trail') fazia o conector sequestrar um gancho
// que a pessoa mesma tivesse chamado assim: o conserto reescrevia o comando dela pelo nosso, em
// toda abertura, sem avisar.
function ehNossoNoAntigravity(cmd) {
  if (typeof cmd !== 'string') return false
  return cmd.includes('antigravity-hook.mjs') || new RegExp(`${PACOTE}(@[^\\s]*)?\\s+hook\\s`).test(cmd)
}

// O caminho do Node gravado no gancho. Comparar com o Node de AGORA seria errado: quem usa gerenciador
// de versao (nvm e afins) tem varios Nodes validos, e cada abertura resolveria um. O que importa e
// se o que esta gravado ainda EXISTE - se existe, o gancho funciona e nao ha o que consertar.
// Pega o primeiro trecho entre aspas, seja qual for a forma gravada (com ou sem o par externo do
// Windows).
function nodeGravado(cmd) {
  const partes = typeof cmd === 'string' ? cmd.match(/"([^"]+)"/g) : null
  return partes && partes.length ? partes[0].slice(1, -1) : null
}

function ganchoQuebrado(cmd) {
  if (!existsSync(atalhoPath())) return true
  const node = nodeGravado(cmd)
  return !node || !existsSync(node)
}

//   'instalado' | 'ja-tinha' | 'sem-antigravity' | 'ilegivel' | 'falhou'
export function instalarGanchoAntigravity() {
  if (!temAntigravity()) return 'sem-antigravity'
  const path = antigravityHooksPath()
  const lido = lerJson(path)
  if (lido.estado === 'ilegivel') return 'ilegivel'
  const cfg = lido.valor
  if (comandosPreInvocation(cfg).some(({ h }) => ehNossoNoAntigravity(h?.command))) return 'ja-tinha'
  // Se ja existe uma chave "trail" e ela NAO e nossa (a checagem acima teria pegado), ela e de algo
  // que a pessoa configurou com esse nome. Escrever por cima apagava o gatilho dela inteiro.
  cfg[chaveLivre(cfg, NOME_GANCHO)] = {
    PreInvocation: [{ type: 'command', command: comandoDoAtalho(), timeout: LIMITE_GANCHO_S }],
  }
  try {
    escreverAtalho()
    gravar(path, cfg, lido.estado === 'ok')
  } catch {
    return 'falhou'
  }
  return 'instalado'
}

// CONSERTO, e ele NAO passa pelo portao da marca de "ja tentou". A marca barra INSTALAR (quem
// removeu de proposito nao ve voltar), nunca CONSERTAR: gancho que continua registrado mas perdeu
// o atalho - ou cujo Node mudou de lugar, o caso de quem troca de versao - ficaria morto para
// sempre, com o arquivo la, parecendo instalado.
//   'consertado' | 'nada' | 'sem-antigravity' | 'ilegivel' | 'falhou'
export function consertarGanchoAntigravity() {
  if (!temAntigravity()) return 'sem-antigravity'
  const path = antigravityHooksPath()
  const lido = lerJson(path)
  if (lido.estado === 'ilegivel') return 'ilegivel'
  const cfg = lido.valor
  const nosso = comandosPreInvocation(cfg).find(({ h }) => ehNossoNoAntigravity(h?.command))
  // Ninguem registrou, ou a pessoa removeu: nao ha o que consertar, e nada volta sozinho.
  if (!nosso) return 'nada'
  let mudou = false
  try {
    if (atalhoDesatualizado()) {
      escreverAtalho()
      mudou = true
    }
    // So reescreve o comando quando ele esta MORTO (Node gravado sumiu). Reescrever sempre que
    // diferisse do Node de agora faria o arquivo ser regravado a cada abertura em quem tem
    // gerenciador de versao - sem necessidade nenhuma, ja que os dois Nodes funcionam.
    if (!existsSync(nodeGravado(nosso.h.command) ?? '')) {
      nosso.h.command = comandoDoAtalho()
      gravar(path, cfg, lido.estado === 'ok')
      mudou = true
    }
  } catch {
    return 'falhou'
  }
  return mudou ? 'consertado' : 'nada'
}

//   'ligado' | 'ausente' | 'quebrado' | 'desligado' | 'ilegivel'
export function estadoGanchoAntigravity() {
  const lido = lerJson(antigravityHooksPath())
  if (lido.estado === 'ilegivel') return 'ilegivel'
  const nosso = comandosPreInvocation(lido.valor).find(({ h }) => ehNossoNoAntigravity(h?.command))
  if (!nosso) return 'ausente'
  if (!nosso.ligado) return 'desligado'
  // Registrado mas com o atalho fora do lugar (ou apontando pra um Node que sumiu) e pior do que
  // ausente: parece ligado e nao fala nada. O conserto roda sozinho na proxima abertura, mas o
  // status tem que contar a verdade agora.
  if (ganchoQuebrado(nosso.h.command)) return 'quebrado'
  return 'ligado'
}

// ---------------------------------------------------------------------------
// Disparo automatico e remocao
// ---------------------------------------------------------------------------

// Roda ao entrar na conta e na primeira subida do servidor. NUNCA lanca e NUNCA escreve em stdout
// (no servidor, stdout e o canal do protocolo). Uma marca POR ALVO: quem desligar o resumo numa IA
// nao afeta as outras, e a marca 'auto' do Claude Code continua com o significado de sempre.
export function instalarOutrasIAsAuto() {
  const r = {}
  // SEM CREDENCIAL, NAO MEXE NA CASA DE NINGUEM. Quem tem o Antigravity instalado mas nunca ligou
  // o Trail pagaria a partida de um processo em toda pensada da IA - e uma consulta de rede na
  // primeira de cada conversa - so pra descobrir que nao ha login e devolver vazio.
  let cfg
  try {
    cfg = resolveConfig()
    if (!cfg.token) return { semCredencial: true }
  } catch {
    return { semCredencial: true }
  }
  // A CREDENCIAL PRECISA ESTAR NO DISCO, e nao so no ambiente de quem chamou. Quem cola a
  // credencial no comando de registro em vez de entrar pela conta deixa o token dentro da
  // configuracao de UMA IA; o conector que o Antigravity sobe nasce sem ele, e as ferramentas do
  // Trail aparecem na lista e respondem vazio - "ligado" na tela, mudo na pratica, que e a mesma
  // mentira que este trabalho existe pra matar. Salvar aqui e o que o login ja faz, no mesmo lugar
  // e com a mesma permissao de arquivo.
  void cfg
  // O conserto vem antes e fora do portao da marca (ver consertarGanchoAntigravity).
  try {
    r.conserto = consertarGanchoAntigravity()
  } catch {
    r.conserto = 'falhou'
  }
  const passo = (chave, fn) => {
    try {
      if (jaTentou(chave)) return 'ja-tentou'
      const res = fn()
      if (res === 'instalado' || res === 'registrado') marcar(chave)
      return res
    } catch {
      return 'falhou'
    }
  }
  r.gemini = passo('gemini', () => instalarGanchoGemini())
  r.mcp = passo('antigravity-mcp', () => registrarMcpAntigravity())
  r.antigravity = passo('antigravity', () => instalarGanchoAntigravity())
  return r
}

// Remove SO os ganchos de abertura. O registro do servidor no Antigravity fica: tira-lo aqui
// desligaria o Trail inteiro daquela IA, e quem pede "tira o resumo de abertura" nao esta pedindo
// isso. Para desligar de vez existe o logout.
export function desinstalarOutrasIAs() {
  const results = []
  // Remove SO os nossos, nas duas formas (caminho pro bin.js do clone e chamada pelo pacote).
  // Gancho de outra ferramenta que a pessoa tenha ali fica intocado.
  const nossoComando = (c) =>
    typeof c === 'string' && (c.includes('bin.js" hook ') || new RegExp(`${PACOTE}(@[^\\s]*)?\\s+hook\\s`).test(c))
  const geminiLido = lerJson(geminiSettingsPath())
  if (geminiLido.estado === 'ilegivel') {
    results.push('Gemini CLI: configuracao ilegivel - NAO removi nada dela')
  }
  if (geminiLido.estado === 'ok') {
    const grupos = geminiLido.valor.hooks?.SessionStart
    if (Array.isArray(grupos)) {
      const antes = grupos.length
      geminiLido.valor.hooks.SessionStart = grupos.filter((g) => !(g.hooks ?? []).some((h) => nossoComando(h?.command)))
      if (geminiLido.valor.hooks.SessionStart.length !== antes) {
        gravar(geminiSettingsPath(), geminiLido.valor, true)
        results.push('Gemini CLI: resumo de abertura removido')
      }
    }
  }
  const agLido = lerJson(antigravityHooksPath())
  // Configuracao ilegivel NAO pode virar "nada encontrado": a frase seria falsa, e apagar o atalho
  // logo abaixo deixaria um gatilho registrado apontando pra um arquivo que nao existe mais -
  // disparando em toda pensada da IA, sem ninguem saber por que.
  if (agLido.estado === 'ilegivel') {
    results.push('Antigravity: configuracao ilegivel - NAO removi nada, e o atalho fica onde esta')
    marcar('gemini')
    return results
  }
  if (agLido.estado === 'ok') {
    const cfg = agLido.valor
    let mexeu = false
    for (const [nome, spec] of Object.entries(cfg)) {
      const s = objeto(spec)
      if (!s || !Array.isArray(s.PreInvocation)) continue
      const antes = s.PreInvocation.length
      s.PreInvocation = s.PreInvocation.filter((h) => !ehNossoNoAntigravity(h?.command))
      if (s.PreInvocation.length !== antes) mexeu = true
      // Chave que ficou sem nenhum evento vira lixo no arquivo da pessoa.
      if (s.PreInvocation.length === 0) delete s.PreInvocation
      if (Object.keys(s).length === 0) delete cfg[nome]
    }
    if (mexeu) {
      gravar(antigravityHooksPath(), cfg, true)
      results.push('Antigravity: resumo de abertura removido')
    }
  }
  for (const p of [atalhoPath(), join(configDir(), 'antigravity-conversas')]) {
    try {
      rmSync(p, { recursive: true })
    } catch {
      /* nao existia */
    }
  }
  // Marca a passagem nos dois ganchos: quem removeu de proposito nao pode ver voltar sozinho. O
  // registro do servidor NAO e marcado aqui de proposito - este comando nao o removeu, entao
  // marca-lo impediria o conector de repor um registro que a pessoa apagasse depois.
  marcar('gemini')
  marcar('antigravity')
  return results
}
