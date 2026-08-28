import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Registra/remove os hooks de sessao do Trail no ~/.claude/settings.json do usuario.
// Cuidados (mexer em settings alheio e invasivo): backup .tether-bak antes de escrever,
// registro IDEMPOTENTE (nao duplica; respeita hook do tether ja existente, inclusive o do
// repo principal na maquina do admin), e JSON invalido aborta sem sobrescrever nada.

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export function settingsPath() {
  return join(homedir(), '.claude', 'settings.json')
}

function isTetherHook(cmd, word) {
  return typeof cmd === 'string' && /tether/i.test(cmd) && cmd.includes(word)
}

function groupHasTetherHook(groups, word) {
  return (groups ?? []).some((g) => (g.hooks ?? []).some((h) => isTetherHook(h.command, word)))
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
  const bin = join(PKG_DIR, 'bin.js')
  const results = []
  // So o de abertura. O de fechamento (Stop) saiu na v1.11.0: falar no fim do turno fazia a IA
  // emitir mais uma resposta na tela a cada mensagem trocada, e o que ele cobrava agora e dito
  // na abertura. Quem ja tinha o Stop registrado perde ele aqui - o comando ja e mudo de
  // qualquer forma, isto so evita rodar um processo a toa em todo fim de turno.
  const event = 'SessionStart'
  const command = `node "${bin}" hook context`
  settings.hooks[event] = settings.hooks[event] ?? []
  if (groupHasTetherHook(settings.hooks[event], 'context')) {
    results.push(`${event}: ja havia um hook do tether (mantido, nada a fazer)`)
  } else {
    settings.hooks[event].push({ hooks: [{ type: 'command', command }] })
    results.push(`${event}: registrado (${command})`)
  }
  const stop = settings.hooks.Stop
  if (Array.isArray(stop)) {
    const before = stop.length
    // Pega tanto o nosso (bin.js hook reconcile) quanto o do repo principal, e nao depende da
    // palavra "tether" estar no caminho: quem clonou numa pasta de outro nome tambem limpa.
    const isReconcile = (c) => typeof c === 'string' && /\breconcile\b/.test(c) && (/tether/i.test(c) || c.includes('hook reconcile'))
    settings.hooks.Stop = stop.filter((g) => !(g.hooks ?? []).some((h) => isReconcile(h.command)))
    if (settings.hooks.Stop.length !== before) results.push('Stop: removido (nao existe mais)')
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
  return results
}

export function uninstallHooks() {
  const path = settingsPath()
  if (!existsSync(path)) return ['settings.json nao existe - nada a remover']
  const settings = JSON.parse(readFileSync(path, 'utf8'))
  copyFileSync(path, path + '.tether-bak')
  const results = []
  for (const event of ['SessionStart', 'Stop']) {
    const groups = settings.hooks?.[event]
    if (!Array.isArray(groups)) continue
    const before = groups.length
    // Remove SO os nossos (bin.js + subcomando "hook ..."); o hook do repo principal
    // do admin usa outro caminho/forma e fica intocado.
    settings.hooks[event] = groups.filter(
      (g) => !(g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('bin.js" hook ')),
    )
    if (settings.hooks[event].length !== before) results.push(`${event}: removido`)
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
  return results.length ? results : ['nenhum hook do trail encontrado']
}
