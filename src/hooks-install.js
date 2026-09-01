import { homedir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configDir } from './config.js'

// Registra/remove o gancho de abertura de sessao do Trail no ~/.claude/settings.json do usuario.
// Cuidados (mexer em settings alheio e invasivo): backup .tether-bak antes de escrever,
// registro IDEMPOTENTE (nao duplica; respeita gancho do trail ja existente, inclusive o do
// repo principal na maquina do admin), e JSON invalido aborta sem sobrescrever nada.

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const PACOTE = 'usetrail'

export function settingsPath() {
  return join(homedir(), '.claude', 'settings.json')
}

// Marca de que a instalacao automatica ja rodou UMA vez nesta maquina. Sem ela, quem removeu o
// gancho de proposito veria ele voltar no proximo login ou na proxima abertura do servidor.
//
// ESTE ARQUIVO E SO DO CLAUDE CODE, E CONTINUA SENDO ESCRITO DE UMA VEZ SO. Houve a tentacao de
// guardar aqui uma chave por IA, lendo-mesclando-gravando. Nao da: cada sessao da IA sobe o seu
// proprio conector, entao ha varios processos escrevendo ao mesmo tempo, e um leitor atrasado
// apaga a chave que o outro acabou de gravar. Medido: 48 perdas em 200 pares simultaneos. A marca
// perdida faz o gancho que a pessoa removeu de proposito VOLTAR sozinho. As outras IAs usam um
// arquivo por marca (ver outras-ias.js), que nao tem como se atropelar.
function marcaPath() {
  return join(configDir(), 'hooks.json')
}

function jaTentouSozinho() {
  try {
    return !!JSON.parse(readFileSync(marcaPath(), 'utf8')).auto
  } catch {
    return false
  }
}

function marcarQueTentou() {
  try {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(marcaPath(), JSON.stringify({ auto: new Date().toISOString() }, null, 2) + '\n')
  } catch {
    /* sem pasta de config gravavel: o pior caso e tentar de novo depois */
  }
}

// Existe Claude Code nesta maquina? A PASTA e o sinal barato, e o unico que a instalacao
// automatica usa (ela roda sem ninguem olhando, entao erra pro lado conservador). O binario no
// PATH so e consultado pelo comando explicito: ele cobre quem acabou de instalar o Claude Code e
// ainda nao abriu nenhuma sessao - recusar justo essa pessoa seria recusar quem esta configurando
// tudo do zero.
export function temClaudeCode({ olharPath = false } = {}) {
  if (existsSync(join(homedir(), '.claude'))) return true
  if (!olharPath) return false
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) if (existsSync(join(dir, 'claude' + ext))) return true
  }
  return false
}

// O que o `status` mostra sobre o gancho. Existe porque perguntar "o gancho esta configurado?"
// custava SETE comandos: na maquina do dono (01/09/2026) a IA rodou --help, status e doctor, depois
// vasculhou a pasta do Claude com mais tres buscas, e so entao instalou. Uma linha no status resolve.
//   'ligado' | 'ausente' | 'sem-claude' | 'ilegivel'
export function estadoDoGancho() {
  if (!existsSync(join(homedir(), '.claude'))) return 'sem-claude'
  const path = settingsPath()
  if (!existsSync(path)) return 'ausente'
  try {
    const settings = JSON.parse(readFileSync(path, 'utf8'))
    return grupoTemGanchoDoTrail(settings.hooks?.SessionStart, 'context') ? 'ligado' : 'ausente'
  } catch {
    return 'ilegivel'
  }
}

// O comando que o gancho roda. Instalado por clone (tem .git ao lado), aponta pro arquivo local -
// ele se atualiza sozinho e nao paga rede a cada abertura. Instalado pelo registro publico, PKG_DIR
// e a pasta temporaria do npx: caminho que caduca com a limpeza de cache E congela a versao daquele
// dia. Nesse caso o gancho chama o pacote do mesmo jeito que o servidor e registrado.
export function comandoDoGancho() {
  if (existsSync(join(PKG_DIR, '.git'))) return `node "${join(PKG_DIR, 'bin.js')}" hook context`
  // O `--silent` cala o npm, e nao e enfeite: o Gemini CLI, quando a saida do gancho nao e JSON,
  // usa o que veio pelo canal de erro E MOSTRA como mensagem de sistema na abertura da conversa.
  // Sem ele, um "npm notice: nova versao disponivel" aparecia pra pessoa como se fosse recado do
  // Trail, justamente na pasta onde o resumo devia ficar calado.
  return `npx -y --silent ${PACOTE}@latest hook context`
}

// Reconhece um gancho NOSSO em qualquer das formas ja usadas: caminho local com "tether" no meio
// (repo principal do admin e clones antigos), caminho com "trail", e o comando pelo pacote.
export function ehGanchoDoTrail(cmd, word) {
  return typeof cmd === 'string' && /tether|trail/i.test(cmd) && cmd.includes(word)
}

// Os Array.isArray nao sao paranoia: estes arquivos sao editados a mao pelas pessoas, e um
// SessionStart escrito como objeto (ou um "hooks" que virou texto) derrubava o `status` inteiro
// com erro na tela, numa maquina onde ele funcionava.
export function grupoTemGanchoDoTrail(groups, word) {
  if (!Array.isArray(groups)) return false
  return groups.some((g) => (Array.isArray(g?.hooks) ? g.hooks : []).some((h) => ehGanchoDoTrail(h?.command, word)))
}

export function installHooks() {
  const path = settingsPath()
  let settings = {}
  if (existsSync(path)) {
    settings = JSON.parse(readFileSync(path, 'utf8'))
    copyFileSync(path, path + '.tether-bak')
  } else {
    mkdirSync(dirname(path), { recursive: true })
  }
  settings.hooks = settings.hooks ?? {}
  const results = []
  // So o de abertura. O de fechamento (Stop) saiu na v1.11.0: falar no fim do turno fazia a IA
  // emitir mais uma resposta na tela a cada mensagem trocada, e o que ele cobrava agora e dito
  // na abertura. Quem ja tinha o Stop registrado perde ele aqui - o comando ja e mudo de
  // qualquer forma, isto so evita rodar um processo a toa em todo fim de turno.
  const event = 'SessionStart'
  const command = comandoDoGancho()
  settings.hooks[event] = settings.hooks[event] ?? []
  if (grupoTemGanchoDoTrail(settings.hooks[event], 'context')) {
    results.push(`${event}: ja havia um gancho do Trail (mantido, nada a fazer)`)
  } else {
    settings.hooks[event].push({ hooks: [{ type: 'command', command }] })
    results.push(`${event}: registrado (${command})`)
  }
  const stop = settings.hooks.Stop
  if (Array.isArray(stop)) {
    const before = stop.length
    // Pega tanto o nosso (bin.js hook reconcile) quanto o do repo principal, e nao depende da
    // palavra "tether" estar no caminho: quem clonou numa pasta de outro nome tambem limpa.
    const isReconcile = (c) => typeof c === 'string' && /\breconcile\b/.test(c) && (/tether|trail/i.test(c) || c.includes('hook reconcile'))
    settings.hooks.Stop = stop.filter((g) => !(g.hooks ?? []).some((h) => isReconcile(h.command)))
    if (settings.hooks.Stop.length !== before) results.push('Stop: removido (nao existe mais)')
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
  return results
}

// Instalacao automatica: e o que faz o resumo do projeto chegar sem ninguem saber que existe um
// gancho. Roda ao entrar na conta e na primeira subida do servidor, porque quem cola credencial
// em vez de entrar pelo site nunca passa pelo login. NUNCA lanca e NUNCA escreve em stdout (no
// servidor, stdout e o canal do protocolo). Devolve o que aconteceu, pro login poder contar.
//   'instalado' | 'ja-tinha' | 'sem-claude' | 'ja-tentou' | 'falhou'
export function installHooksAuto() {
  try {
    // Sem a pasta do Claude a pessoa usa outra ferramenta: criar config de um programa que ela
    // nao tem seria invasivo e nao serviria pra nada.
    if (!existsSync(join(homedir(), '.claude'))) return 'sem-claude'
    const path = settingsPath()
    if (existsSync(path)) {
      const settings = JSON.parse(readFileSync(path, 'utf8'))
      if (grupoTemGanchoDoTrail(settings.hooks?.SessionStart, 'context')) return 'ja-tinha'
    }
    if (jaTentouSozinho()) return 'ja-tentou'
    installHooks()
    marcarQueTentou()
    return 'instalado'
  } catch {
    // JSON invalido, disco cheio, permissao: o settings do usuario fica como estava e a proxima
    // abertura tenta de novo (a marca so e escrita quando deu certo).
    return 'falhou'
  }
}

export function uninstallHooks() {
  const path = settingsPath()
  if (!existsSync(path)) return ['settings.json nao existe - nada a remover']
  const settings = JSON.parse(readFileSync(path, 'utf8'))
  copyFileSync(path, path + '.tether-bak')
  const results = []
  // Remove SO os nossos, nas duas formas: caminho pro bin.js e chamada do pacote pelo npx. O
  // gancho do repo principal do admin usa outro caminho/forma e fica intocado.
  const nosso = (c) =>
    typeof c === 'string' && (c.includes('bin.js" hook ') || new RegExp(`${PACOTE}(@[^\\s]*)?\\s+hook\\s`).test(c))
  for (const event of ['SessionStart', 'Stop']) {
    const groups = settings.hooks?.[event]
    if (!Array.isArray(groups)) continue
    const before = groups.length
    settings.hooks[event] = groups.filter((g) => !(g.hooks ?? []).some((h) => nosso(h.command)))
    if (settings.hooks[event].length !== before) results.push(`${event}: removido`)
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
  // Marca a passagem: quem removeu de proposito nao pode ver o gancho voltar sozinho depois.
  marcarQueTentou()
  return results.length ? results : ['nenhum gancho do Trail encontrado']
}
