#!/usr/bin/env node
// Prova do gancho de abertura que se instala sozinho. Roda tudo numa casa de mentira (HOME e
// XDG_CONFIG_HOME apontados pra uma pasta temporaria): nenhum teste aqui pode encostar no
// ~/.claude/settings.json de quem esta rodando.
//
// Uso: node scripts/gancho.mjs

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let falhas = 0
const casas = []

function casaNova({ comClaude = true, settings = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trail-gancho-'))
  casas.push(dir)
  process.env.HOME = dir
  process.env.XDG_CONFIG_HOME = join(dir, '.config')
  if (comClaude) mkdirSync(join(dir, '.claude'), { recursive: true })
  if (settings !== undefined) writeFileSync(join(dir, '.claude', 'settings.json'), settings)
  return dir
}

// Import novo a cada casa: o modulo le HOME na hora da chamada, mas config.js tambem, entao
// recarregar mantem o teste honesto se isso mudar.
async function mod() {
  return await import(`../src/hooks-install.js?v=${Math.random()}`)
}

function checa(nome, cond, extra = '') {
  if (cond) return console.log(`  ok   ${nome}`)
  falhas++
  console.log(`  FALHOU ${nome}${extra ? `\n         ${extra}` : ''}`)
}

function ganchos(dir) {
  const p = join(dir, '.claude', 'settings.json')
  if (!existsSync(p)) return []
  return JSON.parse(readFileSync(p, 'utf8')).hooks?.SessionStart ?? []
}

console.log('\nGancho de abertura que se instala sozinho\n')

{
  const dir = casaNova({ comClaude: false })
  const { installHooksAuto } = await mod()
  const r = installHooksAuto()
  checa('quem nao tem Claude nesta maquina fica intocado', r === 'sem-claude' && !existsSync(join(dir, '.claude')), `devolveu ${r}`)
}

{
  const dir = casaNova()
  const { installHooksAuto } = await mod()
  const r = installHooksAuto()
  const g = ganchos(dir)
  checa('primeira vez: registra o gancho', r === 'instalado' && g.length === 1, `devolveu ${r}, ${g.length} gancho(s)`)
  checa('o gancho roda o resumo de abertura', JSON.stringify(g).includes('hook context'), JSON.stringify(g))
}

{
  const dir = casaNova()
  const { installHooksAuto } = await mod()
  installHooksAuto()
  const r = installHooksAuto()
  checa('segunda vez: nao duplica', r === 'ja-tinha' && ganchos(dir).length === 1, `devolveu ${r}, ${ganchos(dir).length} gancho(s)`)
}

{
  const dir = casaNova()
  const { installHooksAuto, uninstallHooks } = await mod()
  installHooksAuto()
  uninstallHooks()
  const r = installHooksAuto()
  checa('quem removeu de proposito nao ve o gancho voltar', r === 'ja-tentou' && ganchos(dir).length === 0, `devolveu ${r}, ${ganchos(dir).length} gancho(s)`)
}

{
  const dir = casaNova({ settings: '{ isto nao e json' })
  const { installHooksAuto } = await mod()
  const r = installHooksAuto()
  const cru = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')
  checa('config quebrada: nao escreve nada por cima', r === 'falhou' && cru === '{ isto nao e json', `devolveu ${r}`)
}

{
  const dir = casaNova({ settings: JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo oi' }] }] } }) })
  const { installHooksAuto } = await mod()
  installHooksAuto()
  const s = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'))
  checa('o que a pessoa ja tinha continua la', s.model === 'opus' && JSON.stringify(s.hooks.SessionStart).includes('echo oi'), JSON.stringify(s))
  checa('e sobrou copia de seguranca do arquivo antigo', existsSync(join(dir, '.claude', 'settings.json.tether-bak')))
}

{
  const dir = casaNova({ settings: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /home/alguem/dev/tether/dist/hooks/bin.js context' }] }] } }) })
  const { installHooksAuto } = await mod()
  const r = installHooksAuto()
  checa('gancho antigo do repo principal e respeitado, nao duplicado', r === 'ja-tinha' && ganchos(dir).length === 1, `devolveu ${r}, ${ganchos(dir).length} gancho(s)`)
}

for (const d of casas) rmSync(d, { recursive: true, force: true })
console.log(falhas ? `\n${falhas} falha(s)\n` : '\nTudo passou\n')
process.exit(falhas ? 1 : 0)
