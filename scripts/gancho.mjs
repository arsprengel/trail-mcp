#!/usr/bin/env node
// Prova do gancho de abertura que se instala sozinho. Roda tudo numa casa de mentira (HOME e
// XDG_CONFIG_HOME apontados pra uma pasta temporaria): nenhum teste aqui pode encostar no
// ~/.claude/settings.json de quem esta rodando.
//
// Uso: node scripts/gancho.mjs

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync, readdirSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, delimiter, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)))

let falhas = 0
const casas = []

// comGemini: a maquina tem o Gemini CLI (o sinal e o ARQUIVO de configuracao dele).
// comAntigravity: a maquina tem o Antigravity (o sinal e a subpasta de configuracao dele).
// As duas moram em ~/.gemini de proposito, porque e assim na vida real - e e justamente por isso
// que a pasta sozinha nao serve pra reconhecer nenhum dos dois.
function casaNova({ comClaude = true, settings = undefined, comGemini = false, comAntigravity = false, geminiSettings = undefined, mcpConfig = undefined, agHooks = undefined, comCredencial = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trail-gancho-'))
  casas.push(dir)
  process.env.HOME = dir
  process.env.XDG_CONFIG_HOME = join(dir, '.config')
  // O caminho automatico das outras IAs so mexe na casa de quem JA ligou o Trail: sem credencial,
  // instalar um gatilho que roda antes de cada pensada da IA seria cobrar um preco por nada.
  // Os DOIS nomes: o conector espelha TETHER_* e TRAIL_*, entao apagar so um deixaria a credencial
  // viva pelo outro e a casa "sem credencial" teria credencial.
  if (comCredencial) {
    process.env.TETHER_API_TOKEN = 'credencial-de-mentira'
    process.env.TRAIL_API_TOKEN = 'credencial-de-mentira'
  } else {
    delete process.env.TETHER_API_TOKEN
    delete process.env.TRAIL_API_TOKEN
    delete process.env.TETHER_API_AUTH
    delete process.env.TRAIL_API_AUTH
  }
  if (comClaude) mkdirSync(join(dir, '.claude'), { recursive: true })
  if (settings !== undefined) writeFileSync(join(dir, '.claude', 'settings.json'), settings)
  if (comGemini || geminiSettings !== undefined) {
    mkdirSync(join(dir, '.gemini'), { recursive: true })
    writeFileSync(join(dir, '.gemini', 'settings.json'), geminiSettings ?? '{}')
  }
  if (comAntigravity || mcpConfig !== undefined || agHooks !== undefined) {
    mkdirSync(join(dir, '.gemini', 'config'), { recursive: true })
    if (mcpConfig !== undefined) writeFileSync(join(dir, '.gemini', 'config', 'mcp_config.json'), mcpConfig)
    if (agHooks !== undefined) writeFileSync(join(dir, '.gemini', 'config', 'hooks.json'), agHooks)
  }
  return dir
}

// Import novo a cada casa: o modulo le HOME na hora da chamada, mas config.js tambem, entao
// recarregar mantem o teste honesto se isso mudar.
async function mod() {
  return await import(`../src/hooks-install.js?v=${Math.random()}`)
}

async function outras() {
  return await import(`../src/outras-ias.js?v=${Math.random()}`)
}

function lerJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
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

// O que o `status` responde sobre o gancho. Uma linha aqui poupa a caca de sete comandos que a IA
// faz quando alguem pergunta se o gancho esta configurado.
{
  const dir = casaNova({ comClaude: false })
  const { estadoDoGancho } = await mod()
  checa('status: sem Claude Code, diz que nao se aplica', estadoDoGancho() === 'sem-claude')
  void dir
}

{
  casaNova()
  const { estadoDoGancho, installHooksAuto } = await mod()
  checa('status: com Claude e sem gancho, diz ausente', estadoDoGancho() === 'ausente')
  installHooksAuto()
  checa('status: depois de instalar, diz ligado', estadoDoGancho() === 'ligado')
}

{
  casaNova({ settings: '{ quebrado' })
  const { estadoDoGancho } = await mod()
  checa('status: configuracao quebrada nao vira "ligado" por engano', estadoDoGancho() === 'ilegivel')
}

// Instalar NAO pode fabricar a configuracao do Claude Code na maquina de quem usa outra IA.
{
  const dir = casaNova({ comClaude: false })
  const { temClaudeCode } = await mod()
  const pathSemClaude = { ...process.env, PATH: '/nao-existe-em-lugar-nenhum' }
  const antes = process.env.PATH
  process.env.PATH = pathSemClaude.PATH
  checa('sem pasta e sem o programa no caminho, nao ha Claude Code', temClaudeCode({ olharPath: true }) === false)
  process.env.PATH = antes
  checa('e nada foi criado na casa', !existsSync(join(dir, '.claude')))
}

// ---------------------------------------------------------------------------
// #262 - o Trail entra na lista de ferramentas do Antigravity
// ---------------------------------------------------------------------------

console.log('\nO Trail na lista de ferramentas do Antigravity\n')

{
  const dir = casaNova({ comClaude: false, comGemini: true })
  const { registrarMcpAntigravity } = await outras()
  const r = registrarMcpAntigravity()
  checa(
    'sem Antigravity nesta maquina, nada e criado',
    r === 'sem-antigravity' && !existsSync(join(dir, '.gemini', 'config')),
    `devolveu ${r}`,
  )
}

{
  // O CASO REAL da maquina do dono: o arquivo existe com ZERO BYTE. Se isso contasse como
  // "quebrado", o registro nunca aconteceria em ninguem.
  const dir = casaNova({ comClaude: false, mcpConfig: '' })
  const { registrarMcpAntigravity } = await outras()
  const r = registrarMcpAntigravity()
  const cfg = lerJson(join(dir, '.gemini', 'config', 'mcp_config.json'))
  checa('arquivo de zero byte conta como vazio, e o registro acontece', r === 'registrado' && !!cfg?.mcpServers?.trail, `devolveu ${r}`)
  checa('e o registro chama o pacote publicado', JSON.stringify(cfg?.mcpServers?.trail).includes('usetrail@latest'), JSON.stringify(cfg))
}

{
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { registrarMcpAntigravity } = await outras()
  const r = registrarMcpAntigravity()
  checa('arquivo que nem existe: cria e registra', r === 'registrado' && !!lerJson(join(dir, '.gemini', 'config', 'mcp_config.json'))?.mcpServers?.trail, `devolveu ${r}`)
}

{
  const dir = casaNova({ comClaude: false, mcpConfig: '{ isto nao e json' })
  const { registrarMcpAntigravity } = await outras()
  const r = registrarMcpAntigravity()
  const cru = readFileSync(join(dir, '.gemini', 'config', 'mcp_config.json'), 'utf8')
  checa('configuracao quebrada: nao escreve nada por cima', r === 'ilegivel' && cru === '{ isto nao e json', `devolveu ${r}`)
}

{
  const dir = casaNova({ comClaude: false, mcpConfig: JSON.stringify({ mcpServers: { outro: { command: 'x' }, trail: { command: 'npx', args: ['-y', 'usetrail@latest'] } } }) })
  const { registrarMcpAntigravity } = await outras()
  const r = registrarMcpAntigravity()
  const cfg = lerJson(join(dir, '.gemini', 'config', 'mcp_config.json'))
  checa('ja registrado: nao duplica', r === 'ja-tinha' && Object.keys(cfg.mcpServers).length === 2, `devolveu ${r}`)
  checa('e o servidor da pessoa continua la', cfg.mcpServers.outro?.command === 'x')
}

{
  const dir = casaNova({ comClaude: false, mcpConfig: JSON.stringify({ mcpServers: { outro: { command: 'x' } }, algoDela: 1 }) })
  const { registrarMcpAntigravity } = await outras()
  registrarMcpAntigravity()
  const cfg = lerJson(join(dir, '.gemini', 'config', 'mcp_config.json'))
  checa('o que a pessoa ja tinha continua la', cfg.algoDela === 1 && cfg.mcpServers.outro?.command === 'x' && !!cfg.mcpServers.trail, JSON.stringify(cfg))
  checa('e sobrou copia de seguranca', existsSync(join(dir, '.gemini', 'config', 'mcp_config.json.tether-bak')))
}

// ---------------------------------------------------------------------------
// #263a - resumo de abertura no Gemini CLI
// ---------------------------------------------------------------------------

console.log('\nResumo de abertura no Gemini CLI\n')

{
  // A ARMADILHA: numa maquina so com Antigravity a pasta ~/.gemini EXISTE (eles dividem a pasta).
  // Reconhecer o Gemini CLI por ela faria o conector fabricar configuracao de um programa ausente.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoGemini } = await outras()
  const antes = process.env.PATH
  process.env.PATH = '/nao-existe-em-lugar-nenhum'
  const r = instalarGanchoGemini({ olharPath: true })
  process.env.PATH = antes
  checa(
    'so Antigravity na maquina: nao inventa configuracao do Gemini CLI',
    r === 'sem-gemini' && !existsSync(join(dir, '.gemini', 'settings.json')),
    `devolveu ${r}`,
  )
}

{
  const dir = casaNova({ comClaude: false, comGemini: true })
  const { instalarGanchoGemini } = await outras()
  const r = instalarGanchoGemini()
  const grupos = lerJson(join(dir, '.gemini', 'settings.json'))?.hooks?.SessionStart ?? []
  checa('com Gemini CLI: registra o resumo de abertura', r === 'instalado' && grupos.length === 1, `devolveu ${r}`)
  checa('o gancho roda o resumo de abertura', JSON.stringify(grupos).includes('hook context'), JSON.stringify(grupos))
  checa('e SEM filtro de origem, pra valer tambem ao retomar e ao limpar', !JSON.stringify(grupos).includes('matcher'), JSON.stringify(grupos))
}

{
  // O arquivo real do dono tem o registro de servidores do Gemini DENTRO dele.
  const dir = casaNova({ comClaude: false, geminiSettings: JSON.stringify({ mcpServers: { trail: { command: 'npx', args: ['-y', 'usetrail@latest'] } }, security: { auth: 'x' } }) })
  const { instalarGanchoGemini } = await outras()
  instalarGanchoGemini()
  const s = lerJson(join(dir, '.gemini', 'settings.json'))
  checa('o registro de servidores no mesmo arquivo fica intocado', !!s.mcpServers?.trail && s.security?.auth === 'x', JSON.stringify(s))
  checa('e o resumo de abertura entrou junto', (s.hooks?.SessionStart ?? []).length === 1, JSON.stringify(s.hooks))
}

{
  const dir = casaNova({ comClaude: false, comGemini: true })
  const { instalarGanchoGemini } = await outras()
  instalarGanchoGemini()
  const r = instalarGanchoGemini()
  checa('segunda vez: nao duplica', r === 'ja-tinha' && (lerJson(join(dir, '.gemini', 'settings.json'))?.hooks?.SessionStart ?? []).length === 1, `devolveu ${r}`)
}

{
  const dir = casaNova({ comClaude: false, geminiSettings: '{ quebrado' })
  const { instalarGanchoGemini } = await outras()
  const r = instalarGanchoGemini()
  checa('configuracao quebrada: nao escreve nada por cima', r === 'ilegivel' && readFileSync(join(dir, '.gemini', 'settings.json'), 'utf8') === '{ quebrado', `devolveu ${r}`)
}

// ---------------------------------------------------------------------------
// #263b - resumo de abertura no Antigravity
// ---------------------------------------------------------------------------

console.log('\nResumo de abertura no Antigravity\n')

function ganchoAg(dir) {
  return lerJson(join(dir, '.gemini', 'config', 'hooks.json'))
}

{
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, atalhoPath } = await outras()
  const r = instalarGanchoAntigravity()
  const cfg = ganchoAg(dir)
  checa('com Antigravity: registra o gatilho', r === 'instalado' && !!cfg?.trail, `devolveu ${r}`)
  checa('no formato dele - mapa de nome, lista PLANA, sem filtro', Array.isArray(cfg?.trail?.PreInvocation) && !!cfg.trail.PreInvocation[0]?.command && cfg.trail.PreInvocation[0].matcher === undefined, JSON.stringify(cfg))
  checa('com tempo limite declarado (o gatilho trava o laco da IA)', cfg.trail.PreInvocation[0].timeout === 25, JSON.stringify(cfg))
  checa('e o atalho local foi escrito', existsSync(atalhoPath()))
  checa('o comando aponta pro Node em uso, entre aspas', cfg.trail.PreInvocation[0].command.startsWith(`"${process.execPath}"`), cfg.trail.PreInvocation[0].command)
}

{
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity } = await outras()
  instalarGanchoAntigravity()
  const r = instalarGanchoAntigravity()
  checa('segunda vez: nao duplica', r === 'ja-tinha' && Object.keys(ganchoAg(dir)).length === 1, `devolveu ${r}`)
}

{
  const dir = casaNova({ comClaude: false, agHooks: JSON.stringify({ meuGancho: { PreInvocation: [{ type: 'command', command: 'echo oi' }] } }) })
  const { instalarGanchoAntigravity } = await outras()
  instalarGanchoAntigravity()
  const cfg = ganchoAg(dir)
  checa('o gatilho que a pessoa ja tinha continua la', JSON.stringify(cfg.meuGancho).includes('echo oi') && !!cfg.trail, JSON.stringify(cfg))
}

{
  const dir = casaNova({ comClaude: false, agHooks: '{ quebrado' })
  const { instalarGanchoAntigravity } = await outras()
  const r = instalarGanchoAntigravity()
  checa('configuracao quebrada: nao escreve nada por cima', r === 'ilegivel' && readFileSync(join(dir, '.gemini', 'config', 'hooks.json'), 'utf8') === '{ quebrado', `devolveu ${r}`)
}

{
  // O CONSERTO. Ele NAO pode passar pelo portao da marca: gancho registrado que perdeu o atalho
  // ficaria morto pra sempre, com o arquivo la, parecendo instalado.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, consertarGanchoAntigravity, instalarOutrasIAsAuto, atalhoPath, estadoGanchoAntigravity } = await outras()
  instalarGanchoAntigravity()
  rmSync(atalhoPath())
  checa('atalho sumido: o status conta a verdade em vez de dizer "ligado"', estadoGanchoAntigravity() === 'quebrado', estadoGanchoAntigravity())
  const r = consertarGanchoAntigravity()
  checa('e o conserto reescreve o atalho', r === 'consertado' && existsSync(atalhoPath()), `devolveu ${r}`)
  // Agora com a marca ja gravada, que e o estado de uma maquina que ja rodou uma vez.
  rmSync(atalhoPath())
  instalarOutrasIAsAuto()
  checa('o conserto acontece mesmo depois da marca gravada', existsSync(atalhoPath()))
  void dir
}

{
  // Quem troca de versao do Node: o atalho continua la e com carimbo novo, mas o caminho gravado
  // no gatilho aponta pra um arquivo que sumiu. Sem esta checagem, gatilho morto pra sempre.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, consertarGanchoAntigravity } = await outras()
  instalarGanchoAntigravity()
  const p = join(dir, '.gemini', 'config', 'hooks.json')
  const cfg = lerJson(p)
  cfg.trail.PreInvocation[0].command = '"/opt/node-de-outra-versao/node" "/tmp/antigravity-hook.mjs"'
  writeFileSync(p, JSON.stringify(cfg, null, 2))
  const r = consertarGanchoAntigravity()
  checa('Node trocado de lugar: o conserto reescreve o comando', r === 'consertado' && lerJson(p).trail.PreInvocation[0].command.startsWith(`"${process.execPath}"`), `devolveu ${r}`)
}

{
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, desinstalarOutrasIAs, consertarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  desinstalarOutrasIAs()
  checa('desligar remove o gatilho e apaga o atalho', !ganchoAg(dir)?.trail && !existsSync(atalhoPath()))
  const r = consertarGanchoAntigravity()
  checa('e quem removeu de proposito nao ve o conserto ressuscitar nada', r === 'nada' && !existsSync(atalhoPath()), `devolveu ${r}`)
}

// ---------------------------------------------------------------------------
// O automatico, as marcas, e o que NAO pode acontecer
// ---------------------------------------------------------------------------

console.log('\nO automatico das tres IAs, e as marcas\n')

{
  const dir = casaNova({ comClaude: false, comGemini: true, comAntigravity: true })
  const { instalarOutrasIAsAuto } = await outras()
  const r = instalarOutrasIAsAuto()
  checa('maquina so com Gemini/Antigravity: NADA e criado na pasta do Claude Code', !existsSync(join(dir, '.claude')), JSON.stringify(r))
  checa('e as tres coisas das outras IAs acontecem', r.gemini === 'instalado' && r.mcp === 'registrado' && r.antigravity === 'instalado', JSON.stringify(r))
}

{
  // Sem credencial, o automatico nao encosta em nada. Quem tem Antigravity instalado mas nunca
  // ligou o Trail pagaria a partida de um processo em TODA pensada da IA, pra devolver vazio.
  const dir = casaNova({ comClaude: false, comGemini: true, comAntigravity: true, comCredencial: false })
  const { instalarOutrasIAsAuto } = await outras()
  instalarOutrasIAsAuto()
  checa(
    'quem nunca ligou o Trail nao ganha gatilho nenhum',
    !existsSync(join(dir, '.gemini', 'config', 'hooks.json')) && !existsSync(join(dir, '.gemini', 'config', 'mcp_config.json')),
  )
}

{
  // A MARCA DE CADA IA E UM ARQUIVO PROPRIO. Guardar todas num arquivo so, lendo-mesclando-
  // gravando, parece mais arrumado e e um defeito: cada sessao da IA sobe o seu conector, entao
  // ha varios processos gravando, e o leitor atrasado apaga a marca que o outro acabou de
  // escrever. Marca perdida = gancho que a pessoa removeu de proposito VOLTANDO sozinho.
  const dir = casaNova({ comGemini: true, comAntigravity: true })
  const { installHooksAuto } = await mod()
  const { instalarOutrasIAsAuto } = await outras()
  installHooksAuto()
  instalarOutrasIAsAuto()
  const marcas = join(dir, '.config', 'trail', 'marcas')
  checa('a marca do Claude Code continua sozinha no arquivo dela', !!lerJson(join(dir, '.config', 'trail', 'hooks.json'))?.auto)
  checa('e cada outra IA tem a propria marca, em arquivo separado', existsSync(join(marcas, 'gemini')) && existsSync(join(marcas, 'antigravity')) && existsSync(join(marcas, 'antigravity-mcp')))
}

{
  // Ninguem pode apagar a marca de ninguem: desligar numa IA nao pode fazer as outras voltarem.
  const dir = casaNova({ comGemini: true, comAntigravity: true })
  const { installHooksAuto, uninstallHooks } = await mod()
  const { instalarOutrasIAsAuto } = await outras()
  installHooksAuto()
  instalarOutrasIAsAuto()
  uninstallHooks()
  const marcas = join(dir, '.config', 'trail', 'marcas')
  checa('desligar no Claude Code nao apaga a marca das outras', existsSync(join(marcas, 'gemini')) && existsSync(join(marcas, 'antigravity')))
  // E a prova de comportamento: o gancho do Gemini removido a mao nao volta no automatico.
  const s = lerJson(join(dir, '.gemini', 'settings.json'))
  s.hooks.SessionStart = []
  writeFileSync(join(dir, '.gemini', 'settings.json'), JSON.stringify(s))
  instalarOutrasIAsAuto()
  checa('e o gancho removido a mao nao volta sozinho', (lerJson(join(dir, '.gemini', 'settings.json'))?.hooks?.SessionStart ?? []).length === 0)
}

// ---------------------------------------------------------------------------
// Configuracao alheia estranha: o que NAO pode acontecer
// ---------------------------------------------------------------------------

console.log('\nConfiguracao alheia estranha\n')

{
  // Outro servidor MCP apontando pra uma pasta chamada "trailhead" nao e o Trail. Achar que e
  // fazia o registro ser pulado, a pessoa ficar sem nenhuma ferramenta, e o status jurar que
  // estava tudo certo - o defeito do #262 de volta, com o diagnostico mentindo junto.
  const dir = casaNova({ comClaude: false, mcpConfig: JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/ana/dev/trailhead'] } } }) })
  const { registrarMcpAntigravity, estadoMcpAntigravity } = await outras()
  const r = registrarMcpAntigravity()
  checa('servidor alheio com "trail" no caminho nao passa por Trail', r === 'registrado', `devolveu ${r}`)
  checa('e agora o status diz a verdade', estadoMcpAntigravity() === 'ligado')
  checa('sem apagar o servidor da pessoa', !!lerJson(join(dir, '.gemini', 'config', 'mcp_config.json'))?.mcpServers?.filesystem)
}

{
  const dir = casaNova({ comClaude: false, geminiSettings: JSON.stringify({ hooks: { SessionStart: { hooks: [{ command: 'echo oi' }] } } }) })
  const { instalarGanchoGemini, estadoGanchoGemini } = await outras()
  const r = instalarGanchoGemini()
  const s = lerJson(join(dir, '.gemini', 'settings.json'))
  checa('campo com o tipo errado aborta em vez de apagar o que a pessoa tinha', r === 'ilegivel' && JSON.stringify(s).includes('echo oi'), `devolveu ${r}`)
  checa('e o status nao quebra na cara de quem pergunta', estadoGanchoGemini() === 'ilegivel' || estadoGanchoGemini() === 'ausente')
}

{
  const dir = casaNova({ comClaude: false, mcpConfig: JSON.stringify({ mcpServers: [{ name: 'meu-servidor' }] }) })
  const { registrarMcpAntigravity } = await outras()
  const r = registrarMcpAntigravity()
  checa('lista onde se esperava mapa: aborta sem destruir', r === 'ilegivel' && JSON.stringify(lerJson(join(dir, '.gemini', 'config', 'mcp_config.json'))).includes('meu-servidor'), `devolveu ${r}`)
}

{
  // Um gatilho que a PESSOA chamou de "trail". Reconhecer pelo nome fazia o conector reescrever o
  // comando dela pelo nosso, em toda abertura, sem avisar.
  const dir = casaNova({ comClaude: false, agHooks: JSON.stringify({ trail: { PreInvocation: [{ type: 'command', command: 'echo coisa-da-pessoa' }] } }) })
  const { consertarGanchoAntigravity } = await outras()
  const r = consertarGanchoAntigravity()
  checa('gatilho alheio chamado "trail" nao e sequestrado', r === 'nada' && JSON.stringify(ganchoAg(dir)).includes('echo coisa-da-pessoa'), `devolveu ${r}`)
}

{
  // A copia de seguranca guarda o ORIGINAL. Copiando a cada escrita, a segunda passada gravaria
  // por cima da copia o arquivo que NOS ja tinhamos mexido, e o original sumiria.
  const dir = casaNova({ comClaude: false, mcpConfig: JSON.stringify({ algoDela: 'original' }) })
  const { registrarMcpAntigravity } = await outras()
  registrarMcpAntigravity()
  const p = join(dir, '.gemini', 'config', 'mcp_config.json')
  writeFileSync(p, JSON.stringify({ algoDela: 'original', mcpServers: {} }))
  registrarMcpAntigravity()
  const bak = readFileSync(p + '.tether-bak', 'utf8')
  checa('a copia de seguranca continua sendo a de antes de o Trail encostar', !bak.includes('mcpServers'), bak)
}

// ---------------------------------------------------------------------------
// O status e o comando explicito contando a mesma historia
// ---------------------------------------------------------------------------

console.log('\nO remedio que o status manda tomar realmente age\n')

{
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, estadoGanchoAntigravity, atalhoPath, consertarGanchoAntigravity } = await outras()
  instalarGanchoAntigravity()
  rmSync(atalhoPath())
  checa('atalho sumido: o status diz "incompleto"', estadoGanchoAntigravity() === 'quebrado')
  // O que o `hooks install` faz hoje: tenta instalar (ja tinha) E conserta.
  instalarGanchoAntigravity()
  consertarGanchoAntigravity()
  checa('e rodar o comando que ele manda deixa o status "ligado"', estadoGanchoAntigravity() === 'ligado', estadoGanchoAntigravity())
  void dir
}

{
  // Quem tem gerenciador de versao de Node tem varios Nodes validos, e cada abertura resolve um.
  // Comparar com o Node de agora dava "incompleto" num gancho que funciona - e regravava o
  // arquivo da pessoa a cada abertura, sem necessidade.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, estadoGanchoAntigravity, consertarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  const p = join(dir, '.gemini', 'config', 'hooks.json')
  const cfg = lerJson(p)
  const outroNode = join(dir, 'outro-node')
  writeFileSync(outroNode, '')
  cfg.trail.PreInvocation[0].command = `"${outroNode}" "${atalhoPath()}"`
  writeFileSync(p, JSON.stringify(cfg, null, 2))
  checa('outro Node valido continua sendo "ligado"', estadoGanchoAntigravity() === 'ligado', estadoGanchoAntigravity())
  checa('e o conserto nao mexe no arquivo a toa', consertarGanchoAntigravity() === 'nada')
}

// ---------------------------------------------------------------------------
// O atalho rodando de verdade
// ---------------------------------------------------------------------------

console.log('\nO atalho do Antigravity rodando de verdade\n')

{
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  // Um "npx" de mentira no caminho do sistema: assim o exercicio e real (o atalho decide, chama o
  // que acha que e o conector, e repassa a resposta) sem tocar a rede.
  const binFalso = join(dir, 'binfalso')
  mkdirSync(binFalso, { recursive: true })
  const stub = join(binFalso, 'npx')
  writeFileSync(stub, '#!/bin/sh\ncat > /dev/null\nprintf \'%s\' \'{"injectSteps":[{"userMessage":"RESUMO-DE-MENTIRA"}]}\'\n')
  chmodSync(stub, 0o755)
  const rodar = (entrada) =>
    spawnSync(process.execPath, [atalhoPath()], {
      input: JSON.stringify(entrada),
      encoding: 'utf8',
      env: { ...process.env, TRAIL_ATALHO_NPX: stub, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') },
    }).stdout

  const a = rodar({ conversationId: 'conversa-1', workspacePaths: ['/x'] })
  checa('primeira pensada da conversa: o resumo sai', a.includes('RESUMO-DE-MENTIRA'), a)
  const b = rodar({ conversationId: 'conversa-1', workspacePaths: ['/x'] })
  checa('segunda pensada da MESMA conversa: sai calado', b.trim() === '{}', b)
  const c = rodar({ conversationId: 'conversa-2', workspacePaths: ['/x'] })
  checa('conversa nova: o resumo volta', c.includes('RESUMO-DE-MENTIRA'), c)
  const d = rodar({ workspacePaths: ['/x'], invocationNum: 7 })
  checa('sem identificar a conversa, no meio dela: sai calado', d.trim() === '{}', d)
  const e = rodar({ workspacePaths: ['/x'] })
  checa('sem nenhum dos dois sinais: sai calado', e.trim() === '{}', e)
  // Identificador que nao e texto nunca casaria na comparacao, e o resumo entraria em TODA pensada
  // da IA - o desastre que este desenho inteiro existe pra evitar.
  const f = rodar({ conversationId: { a: 1 }, workspacePaths: ['/x'], invocationNum: 5 })
  const g = rodar({ conversationId: [1, 2], workspacePaths: ['/x'], invocationNum: 9 })
  checa('identificador de conversa estranho nao vira resumo em toda pensada', f.trim() === '{}' && g.trim() === '{}', `${f} / ${g}`)
}

{
  // O conector pode terminar SEM ler a entrada (sem rede, registro fora do ar, pacote que nao
  // resolve). A falha de escrita chega depois, como evento: sem tratamento, o gatilho morria alto,
  // com rastro de pilha, dentro do laco da IA do cliente.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  const binFalso = join(dir, 'binfalso')
  mkdirSync(binFalso, { recursive: true })
  const stub = join(binFalso, 'npx')
  writeFileSync(stub, '#!/bin/sh\nexit 1\n')
  chmodSync(stub, 0o755)
  const r = spawnSync(process.execPath, [atalhoPath()], {
    input: JSON.stringify({ conversationId: 'c', workspacePaths: ['/x'] }),
    encoding: 'utf8',
    env: { ...process.env, TRAIL_ATALHO_NPX: stub, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') },
  })
  checa('conector que sai sem ler a entrada: gatilho sai limpo, sem erro na tela', r.status === 0 && r.stdout.trim() === '{}' && !r.stderr.includes('EPIPE'), `saida ${r.status}: ${r.stdout} ${r.stderr.slice(0, 120)}`)
}

{
  // Resumo grande com acentos. Somando pedaco a pedaco, um caractere de varios bytes que caisse na
  // fronteira virava lixo - e o JSON continuava valido, entao o texto estragado seguia pro modelo.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  const binFalso = join(dir, 'binfalso')
  mkdirSync(binFalso, { recursive: true })
  const stub = join(binFalso, 'npx')
  writeFileSync(
    stub,
    `#!/bin/sh\ncat > /dev/null\n"${process.execPath}" -e 'const t="\\u2026".repeat(100000);process.stdout.write(JSON.stringify({injectSteps:[{userMessage:t}]}))'\n`,
  )
  chmodSync(stub, 0o755)
  const r = spawnSync(process.execPath, [atalhoPath()], {
    input: JSON.stringify({ conversationId: 'c', workspacePaths: ['/x'] }),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, TRAIL_ATALHO_NPX: stub, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') },
  })
  let texto = ''
  try {
    texto = JSON.parse(r.stdout).injectSteps[0].userMessage
  } catch {
    /* fica vazio e a checagem reprova */
  }
  checa('resumo grande com acento chega inteiro, sem caractere estragado', texto.length === 100000 && !texto.includes('\uFFFD'), `${texto.length} caracteres`)
}

{
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  // Sem "npx" nenhum no caminho: o gatilho NAO pode travar nem falhar alto - ele bloqueia o laco
  // da IA do cliente.
  const r = spawnSync(process.execPath, [atalhoPath()], {
    input: JSON.stringify({ conversationId: 'c', workspacePaths: ['/x'] }),
    encoding: 'utf8',
    env: { ...process.env, TRAIL_ATALHO_NPX: join(dir, 'npx-que-nao-existe'), PATH: join(dir, 'vazio'), HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') },
  })
  checa('sem o conector instalado: devolve vazio e sai limpo', r.status === 0 && r.stdout.trim() === '{}', `saida ${r.status}: ${r.stdout}`)
  // E a conversa NAO pode ficar queimada por causa de uma falha passageira: sem rede, servidor
  // fora do ar, ou login feito com a conversa ja aberta, ela precisa poder receber o resumo depois.
  const pastaConversas = join(dir, '.config', 'trail', 'antigravity-conversas')
  const marcadas = existsSync(pastaConversas) ? readdirSync(pastaConversas) : []
  checa('e a conversa nao fica queimada: da pra tentar de novo', marcadas.length === 0, JSON.stringify(marcadas))
}

{
  // O gatilho BLOQUEIA o laco do agente. Se o Antigravity nao fechar a entrada, esperar pra sempre
  // deixaria a IA da pessoa parada. A trava tem que valer desde antes da leitura.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  // O `sleep` em segundo plano segura a ponta de escrita aberta: a entrada do atalho nunca termina.
  // O `sh` nao espera por ele, entao quem decide o fim aqui e o proprio atalho.
  const r = spawnSync('sh', ['-c', `{ sleep 60 & } | "${process.execPath}" "${atalhoPath()}"`], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), TRAIL_ATALHO_TRAVA_MS: '1500' },
  })
  checa('entrada que nunca fecha: o atalho se solta sozinho e responde vazio', r.status === 0 && r.stdout.trim() === '{}', `sinal ${r.signal}, saida "${r.stdout}"`)
}

{
  // O gatilho de verdade, pelo conector, com as duas grafias do campo da pasta e o plano C.
  const dir = casaNova({ comClaude: false, comAntigravity: true, comCredencial: false })
  const rodar = (entrada) =>
    spawnSync(process.execPath, [join(RAIZ, 'bin.js'), 'hook', 'antigravity'], {
      input: JSON.stringify(entrada),
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), TETHER_API_URL: 'http://127.0.0.1:1' },
    })
  for (const [nome, entrada] of [
    ['sem pasta nenhuma', { conversationId: 'c' }],
    ['com a grafia principal', { conversationId: 'c', workspacePaths: ['/tmp'] }],
    ['com a outra grafia', { conversationId: 'c', workspace_paths: ['/tmp'] }],
    ['com a pasta pelo plano C', { conversationId: 'c', cwd: '/tmp' }],
    ['com lista vazia', { conversationId: 'c', workspacePaths: [] }],
    ['com lixo na lista', { conversationId: 'c', workspacePaths: [null, 42] }],
    ['com o campo do tipo errado', { conversationId: 'c', workspacePaths: 'nao-e-lista' }],
  ]) {
    const r = rodar(entrada)
    let jsonOk = false
    try {
      JSON.parse(r.stdout)
      jsonOk = true
    } catch {
      /* fica false */
    }
    checa(`o gatilho ${nome}: sai 0 e devolve JSON valido`, r.status === 0 && jsonOk, `saida ${r.status}: ${JSON.stringify(r.stdout)}`)
  }
}

{
  // WINDOWS. La o gancho roda por interpretador de linha de comando, e a regra dele apaga a
  // primeira e a ultima aspa quando ha mais de duas - o que parte a linha em QUALQUER caminho, com
  // ou sem espaco. Sem o par externo, o Antigravity inteiro no Windows fica com "abertura ligado"
  // e zero resumo. E o produto de mesa do dono: e o caminho principal, nao um canto.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  const { instalarGanchoAntigravity, estadoGanchoAntigravity } = await outras()
  instalarGanchoAntigravity()
  const cmd = ganchoAg(dir).trail.PreInvocation[0].command
  const estado = estadoGanchoAntigravity()
  Object.defineProperty(process, 'platform', orig)
  // O par de aspas EXTERNO nao pode voltar. A regra do interpretador do Windows (apagar a primeira
  // e a ultima aspa quando ha mais de duas) e real, mas quem envelopa a linha e o proprio
  // Antigravity - um par nosso a mais deixava uma aspa colada no caminho do Node e o Windows
  // respondia que o programa nao existe. Custou uma versao publicada; nao volte.
  checa('no Windows o comando NAO leva par de aspas externo', !cmd.startsWith('""'), cmd)
  checa('e cada caminho vai entre aspas, um por vez', /^"[^"]+" "[^"]+"$/.test(cmd), cmd)
  checa('o status continua sabendo ler o Node de dentro dele', estado === 'ligado', estado)
}

{
  // Quem instalou na versao com o par a mais tem um comando que NUNCA roda. Como o Node gravado
  // existe, o conserto por "esta morto" nao pegaria - a maquina ficaria quebrada pra sempre.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, consertarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  const p = join(dir, '.gemini', 'config', 'hooks.json')
  const cfg = lerJson(p)
  cfg.trail.PreInvocation[0].command = `""${process.execPath}" "${atalhoPath()}""`
  writeFileSync(p, JSON.stringify(cfg, null, 2))
  const r = consertarGanchoAntigravity()
  const agora = lerJson(p).trail.PreInvocation[0].command
  checa('a forma antiga, com o par a mais, e consertada sozinha', r === 'consertado' && !agora.startsWith('""'), `devolveu ${r}: ${agora}`)
}

{
  // O caminho do npx tambem passa pelo interpretador no Windows, e a instalacao padrao do Node fica
  // numa pasta com espaco no nome. Sem aspas, o Windows tenta rodar so o pedaco antes do espaco.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  const fonte = readFileSync(atalhoPath(), 'utf8')
  checa('no Windows o atalho poe o caminho do npx entre aspas', /win32.*'"' \+ ao_lado \+ '"'/.test(fonte))
  checa('e fora do Windows nao poe (la nao ha interpretador no meio)', fonte.includes(": ao_lado"))
  void dir
}

{
  // `enabled: false` e o jeito documentado de desligar um gancho sem apagar. Dizer "ligado" pra
  // quem desligou de proposito e mentir na cara da pessoa.
  const dir = casaNova({ comClaude: false, agHooks: JSON.stringify({ trail: { enabled: false, PreInvocation: [{ type: 'command', command: '"/x/node" "/y/antigravity-hook.mjs"' }] } }) })
  const { estadoGanchoAntigravity } = await outras()
  checa('gatilho desligado na configuracao nao vira "ligado"', estadoGanchoAntigravity() === 'desligado', estadoGanchoAntigravity())
  void dir
}

{
  // Quem cola a credencial no comando de registro em vez de entrar pela conta deixa o token dentro
  // da configuracao de UMA IA. O conector que o Antigravity sobe nasceria sem ele: as ferramentas
  // apareceriam na lista e responderiam vazio. Entao o registro leva a credencial junto - no mesmo
  // tipo de lugar onde a pessoa ja a colocou, e sem gravar nada em outro canto.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { registrarMcpAntigravity } = await outras()
  registrarMcpAntigravity()
  const servidor = lerJson(join(dir, '.gemini', 'config', 'mcp_config.json'))?.mcpServers?.trail
  checa('credencial que veio so no ambiente vai junto no registro do Antigravity', servidor?.env?.TRAIL_API_TOKEN === 'credencial-de-mentira', JSON.stringify(servidor))
  checa('e nada de credencial foi gravado em outro lugar', !existsSync(join(dir, '.config', 'trail', 'token.json')))
}

{
  // Quem ja entrou na conta nao precisa da credencial repetida no arquivo: o conector a encontra.
  const dir = casaNova({ comClaude: false, comAntigravity: true, comCredencial: false })
  mkdirSync(join(dir, '.config', 'trail'), { recursive: true })
  writeFileSync(join(dir, '.config', 'trail', 'token.json'), JSON.stringify({ url: 'https://x', token: 'salvo' }))
  const { registrarMcpAntigravity } = await outras()
  registrarMcpAntigravity()
  const servidor = lerJson(join(dir, '.gemini', 'config', 'mcp_config.json'))?.mcpServers?.trail
  checa('quem ja entrou na conta nao ganha credencial repetida no arquivo', servidor && servidor.env === undefined, JSON.stringify(servidor))
}

{
  // Uma chave "trail" que NAO e nossa. Escrever por cima apagava o que a pessoa tinha configurado.
  const dir = casaNova({
    comClaude: false,
    agHooks: JSON.stringify({ trail: { PreInvocation: [{ type: 'command', command: 'echo coisa-da-pessoa' }] } }),
    mcpConfig: JSON.stringify({ mcpServers: { trail: { command: 'node', args: ['./meu-servidor.js'] } } }),
  })
  const { instalarGanchoAntigravity, registrarMcpAntigravity } = await outras()
  instalarGanchoAntigravity()
  registrarMcpAntigravity()
  const gan = lerJson(join(dir, '.gemini', 'config', 'hooks.json'))
  const mcp = lerJson(join(dir, '.gemini', 'config', 'mcp_config.json'))
  checa('gatilho alheio chamado "trail" nao e apagado', JSON.stringify(gan.trail).includes('echo coisa-da-pessoa'), JSON.stringify(gan))
  checa('e o nosso entra com outro nome', !!gan['trail-2'], JSON.stringify(Object.keys(gan)))
  checa('servidor alheio chamado "trail" nao e apagado', JSON.stringify(mcp.mcpServers.trail).includes('meu-servidor.js'), JSON.stringify(mcp))
  checa('e o nosso servidor entra com outro nome', JSON.stringify(mcp.mcpServers['trail-2']).includes('usetrail'), JSON.stringify(Object.keys(mcp.mcpServers)))
}

{
  // O status e o comando tem que CONCORDAR. Antes, o status dizia "ausente" (rode o comando), o
  // comando dizia "ilegivel" (nao escrevo), e a pessoa ficava nesse vaivem pra sempre.
  const dir = casaNova({ comClaude: false, geminiSettings: JSON.stringify({ hooks: { SessionStart: { hooks: [] } } }), mcpConfig: JSON.stringify({ mcpServers: [] }) })
  const { estadoGanchoGemini, estadoMcpAntigravity, instalarGanchoGemini, registrarMcpAntigravity } = await outras()
  checa('status e comando dizem a mesma coisa sobre o Gemini', estadoGanchoGemini() === 'ilegivel' && instalarGanchoGemini() === 'ilegivel', estadoGanchoGemini())
  checa('e sobre a lista de ferramentas do Antigravity', estadoMcpAntigravity() === 'ilegivel' && registrarMcpAntigravity() === 'ilegivel', estadoMcpAntigravity())
  void dir
}

{
  const { envelopeAntigravity } = await import(`../src/hook.js?v=${Math.random()}`)
  const env = JSON.parse(envelopeAntigravity('PENDENCIAS'))
  const texto = env.injectSteps[0].userMessage
  checa('o resumo injetado usa o passo que PERMANECE na conversa', typeof texto === 'string')
  checa('ele se apresenta como Trail, e nao como se a pessoa tivesse digitado', texto.startsWith('[Trail]'), texto.slice(0, 40))
  checa('e manda a IA nao responder a ele', texto.includes('Nao responda a esta mensagem'), texto.slice(-60))
  checa('com o resumo de verdade no meio', texto.includes('PENDENCIAS'))
}

{
  // CONCORRENCIA. O Antigravity pensa em paralelo, entao varios atalhos rodam ao mesmo tempo. Com
  // a marca das conversas dentro de UM arquivo (ler-mesclar-gravar), de 40 conversas simultaneas
  // 39 perdiam a marca e recebiam o resumo de novo - no meio da conversa, ja em andamento.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  const binFalso = join(dir, 'binfalso')
  mkdirSync(binFalso, { recursive: true })
  const stub = join(binFalso, 'npx')
  writeFileSync(stub, '#!/bin/sh\ncat > /dev/null\nprintf \'%s\' \'{"injectSteps":[{"userMessage":"R"}]}\'\n')
  chmodSync(stub, 0o755)
  const ambiente = { ...process.env, TRAIL_ATALHO_NPX: stub, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') }
  const umaVez = (conversa) =>
    new Promise((pronto) => {
      const p = spawn(process.execPath, [atalhoPath()], { env: ambiente })
      const saida = []
      p.stdout.on('data', (d) => saida.push(d))
      p.on('close', () => pronto(Buffer.concat(saida).toString('utf8')))
      p.stdin.end(JSON.stringify({ conversationId: conversa, workspacePaths: ['/x'] }))
    })

  const ids = Array.from({ length: 40 }, (_, i) => `conversa-${i}`)
  const primeira = await Promise.all(ids.map(umaVez))
  checa('40 conversas simultaneas: todas recebem o resumo uma vez', primeira.filter((r) => r.includes('"R"')).length === 40, `${primeira.filter((r) => r.includes('"R"')).length} de 40`)
  const marcas = readdirSync(join(dir, '.config', 'trail', 'antigravity-conversas'))
  checa('e as 40 marcas sobrevivem (nenhuma se atropela)', marcas.length === 40, `${marcas.length} marcas`)
  const segunda = await Promise.all(ids.map(umaVez))
  checa('na segunda rodada nenhuma fala de novo', segunda.every((r) => r.trim() === '{}'), segunda.filter((r) => !r.trim().startsWith('{}')).length + ' falaram')
}

{
  // A diferenca que decide o custo: resposta VAZIA E LIMPA (pasta sem projeto no Trail, sem login)
  // mantem a marca - insistir custaria a partida de um processo antes de cada pensada, pra sempre.
  // Ja o conector que NAO conseguiu responder (nao rodou, morreu, saiu com erro) desfaz a marca,
  // pra aquela conversa poder receber o resumo depois.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  const binFalso = join(dir, 'binfalso')
  mkdirSync(binFalso, { recursive: true })
  const contador = join(dir, 'chamadas.txt')
  const vazioLimpo = join(binFalso, 'npx-vazio')
  writeFileSync(vazioLimpo, `#!/bin/sh\ncat > /dev/null\necho x >> "${contador}"\nprintf '%s' '{}'\n`)
  chmodSync(vazioLimpo, 0o755)
  const quebrado = join(binFalso, 'npx-quebrado')
  writeFileSync(quebrado, '#!/bin/sh\ncat > /dev/null\nexit 3\n')
  chmodSync(quebrado, 0o755)
  const rodar = (npx, conversa) =>
    spawnSync(process.execPath, [atalhoPath()], {
      input: JSON.stringify({ conversationId: conversa, workspacePaths: ['/x'] }),
      encoding: 'utf8',
      env: { ...process.env, TRAIL_ATALHO_NPX: npx, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') },
    })

  for (let i = 0; i < 4; i++) rodar(vazioLimpo, 'sem-nada')
  const chamadas = existsSync(contador) ? readFileSync(contador, 'utf8').trim().split('\n').length : 0
  checa('pasta sem nada a dizer: o conector e chamado UMA vez, nao a cada pensada', chamadas === 1, `${chamadas} chamada(s)`)

  const pasta = join(dir, '.config', 'trail', 'antigravity-conversas')
  rodar(quebrado, 'deu-erro')
  const depois = existsSync(pasta) ? readdirSync(pasta) : []
  checa('conector que nao conseguiu responder: a conversa continua podendo receber depois', depois.length === 1, JSON.stringify(depois))
}

{
  // O QUE DECIDE E A RESPOSTA, NAO O CODIGO DE SAIDA. No Windows com Node 24 o npm quebra na
  // propria arrumacao final, DEPOIS de o resumo ja ter sido escrito - e sair pelo codigo jogava
  // fora um resumo perfeito, deixando a pessoa sem nada.
  const dir = casaNova({ comClaude: false, comAntigravity: true })
  const { instalarGanchoAntigravity, atalhoPath } = await outras()
  instalarGanchoAntigravity()
  const binFalso = join(dir, 'binfalso')
  mkdirSync(binFalso, { recursive: true })
  const stub = join(binFalso, 'npx')
  writeFileSync(stub, '#!/bin/sh\ncat > /dev/null\nprintf \'%s\' \'{"injectSteps":[{"userMessage":"R"}]}\'\nexit 7\n')
  chmodSync(stub, 0o755)
  const r = spawnSync(process.execPath, [atalhoPath()], {
    input: JSON.stringify({ conversationId: 'c', workspacePaths: ['/x'] }),
    encoding: 'utf8',
    env: { ...process.env, TRAIL_ATALHO_NPX: stub, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') },
  })
  checa('resumo escrito antes de o processo morrer feio: o resumo vale', r.stdout.includes('"R"'), r.stdout)
  const marcas = readdirSync(join(dir, '.config', 'trail', 'antigravity-conversas'))
  checa('e a conversa fica marcada, sem repetir na pensada seguinte', marcas.length === 1, JSON.stringify(marcas))
}

{
  // Sem credencial, o comando explicito registra o Trail na lista de ferramentas (isso e o que o
  // guia deixa faltando) mas NAO liga o gatilho - senao ele rodaria antes de cada pensada da IA
  // so pra descobrir que nao ha login.
  const dir = casaNova({ comClaude: false, comAntigravity: true, comCredencial: false })
  const r = spawnSync(process.execPath, [join(RAIZ, 'bin.js'), 'hooks', 'install'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') },
  })
  checa('sem credencial: o Trail entra na lista de ferramentas', r.stdout.includes('lista de ferramentas'), r.stdout + r.stderr)
  checa('mas o gatilho nao e ligado, e o comando diz por que', r.stdout.includes('falta entrar na conta') && !existsSync(join(dir, '.gemini', 'config', 'hooks.json')), r.stdout)
}

// ---------------------------------------------------------------------------
// O gatilho contra um Trail de verdade (nao um simulacro de resposta pronta)
// ---------------------------------------------------------------------------

console.log('\nO gatilho buscando o resumo de um Trail de verdade\n')

{
  // Um Trail de mentira, mas INTEIRO: ele responde as tres listas que o resumo usa e devolve o
  // nome do projeto que recebeu. Assim a prova exercita o caminho todo - achar a pasta, tirar o
  // nome do projeto dela, buscar, montar e embrulhar - em vez de so conferir que saiu um JSON.
  // Com o simulacro anterior (um "npx" de mentira devolvendo texto pronto), apagar as tres formas
  // de achar a pasta do projeto passava despercebido pela bateria inteira.
  const servidor = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const projeto = url.searchParams.get('project') ?? '?'
    const corpo = url.pathname.startsWith('/api/items')
      ? [{ id: 'itm_1', number: 7, type: 'feature', status: 'todo', priority: 'high', title: `ponto aberto de ${projeto}` }]
      : url.pathname.startsWith('/api/memory')
        ? [{ id: 'mem_1', category: 'gotcha', title: `memoria de ${projeto}`, body: 'acentuacao: ação, decisões', hint: 'abra antes', archived: false }]
        : []
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(corpo))
  })
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
  const porta = servidor.address().port

  const dir = casaNova({ comClaude: false, comCredencial: false })
  const projeto = join(dir, 'projeto-de-prova')
  mkdirSync(projeto, { recursive: true })
  // ASSINCRONO de proposito: chamar de forma sincrona bloquearia o laco deste mesmo processo, que
  // e quem esta servindo o Trail de mentira - as buscas do gatilho estourariam o tempo e a prova
  // passaria a medir o proprio bloqueio em vez do resumo.
  const rodar = (entrada) =>
    new Promise((pronto) => {
      const p = spawn(process.execPath, [join(RAIZ, 'bin.js'), 'hook', 'antigravity'], {
        cwd: RAIZ,
        env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), TETHER_API_URL: `http://127.0.0.1:${porta}`, TETHER_API_TOKEN: 'x' },
      })
      const saida = []
      p.stdout.on('data', (d) => saida.push(d))
      p.on('close', () => {
        const bruto = Buffer.concat(saida).toString('utf8')
        try {
          pronto(JSON.parse(bruto).injectSteps?.[0]?.userMessage ?? '')
        } catch {
          pronto('')
        }
      })
      p.stdin.end(JSON.stringify(entrada))
    })

  const principal = await rodar({ conversationId: 'a', workspacePaths: [projeto] })
  checa('o resumo de verdade chega, com os pontos abertos e a memoria', principal.includes('ponto aberto de projeto-de-prova') && principal.includes('memoria de projeto-de-prova'), principal.slice(0, 160))
  checa('e o projeto sai da PASTA da entrada, nao da pasta onde o processo roda', principal.includes('projeto-de-prova') && !principal.includes('tether-mcp'), principal.slice(0, 160))
  checa('com os acentos inteiros', principal.includes('ação, decisões'))
  const outra = await rodar({ conversationId: 'b', workspace_paths: [projeto] })
  checa('a outra grafia do campo da pasta chega no mesmo resumo', outra.includes('ponto aberto de projeto-de-prova'), outra.slice(0, 80))
  const planoC = await rodar({ conversationId: 'c', cwd: projeto })
  checa('e o plano C tambem', planoC.includes('ponto aberto de projeto-de-prova'), planoC.slice(0, 80))
  const semPasta = await rodar({ conversationId: 'd' })
  checa('e sem pasta nenhuma ele fica calado, sem inventar projeto', semPasta === '', semPasta.slice(0, 80))
  servidor.close()
}

// ---------------------------------------------------------------------------
// Os comandos que a pessoa digita, rodando de verdade
// ---------------------------------------------------------------------------

console.log('\nOs comandos que a pessoa digita\n')

{
  const dir = casaNova({ comClaude: false, comGemini: true, comAntigravity: true })
  const cli = (...args) =>
    spawnSync(process.execPath, [join(RAIZ, 'bin.js'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), TETHER_API_TOKEN: 'x' },
    })

  const antes = cli('status')
  checa('o status abre sem quebrar e fala das IAs encontradas', antes.status === 0 && antes.stdout.includes('gemini:') && antes.stdout.includes('antigravity:'), antes.stdout + antes.stderr)
  checa('e diz que ainda esta ausente', antes.stdout.includes('AUSENTE'), antes.stdout)

  const inst = cli('hooks', 'install')
  checa('instalar responde por cada IA e diz onde escreveu', inst.status === 0 && inst.stdout.includes('Gemini CLI -') && inst.stdout.includes('Antigravity -') && inst.stdout.includes('.gemini'), inst.stdout + inst.stderr)
  checa('e manda fechar e abrir a IA', inst.stdout.includes('Feche e abra'), inst.stdout)

  const depois = cli('status')
  checa('agora o status diz que esta ligado', depois.status === 0 && !depois.stdout.includes('AUSENTE'), depois.stdout)
  checa('e conta que o Trail esta na lista de ferramentas do Antigravity', depois.stdout.includes('esta na lista de ferramentas'), depois.stdout)

  const denovo = cli('hooks', 'install')
  checa('instalar de novo nao inventa que mudou alguma coisa', denovo.stdout.includes('Nada precisou mudar'), denovo.stdout)

  const desl = cli('hooks', 'uninstall')
  checa('desligar responde o que removeu', desl.status === 0 && desl.stdout.includes('removido'), desl.stdout + desl.stderr)
  const fim = cli('status')
  checa('e o status volta a dizer ausente', fim.stdout.includes('AUSENTE'), fim.stdout)
}

{
  // Uma IA com configuracao estragada nao pode impedir as outras de serem atendidas, e nao pode
  // fazer o comando afirmar que nao encontrou nada.
  const dir = casaNova({ comClaude: false, geminiSettings: '{ quebrado', comAntigravity: true })
  const cli = (...args) =>
    spawnSync(process.execPath, [join(RAIZ, 'bin.js'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), TETHER_API_TOKEN: 'x' },
    })
  const inst = cli('hooks', 'install')
  checa('configuracao estragada numa IA nao impede a outra', inst.status === 0 && inst.stdout.includes('ilegivel') && inst.stdout.includes('lista de ferramentas'), inst.stdout + inst.stderr)
  const desl = cli('hooks', 'uninstall')
  checa('e desligar avisa que nao mexeu na estragada, em vez de dizer que nao achou nada', desl.stdout.includes('ilegivel'), desl.stdout)
}

for (const d of casas) rmSync(d, { recursive: true, force: true })
console.log(falhas ? `\n${falhas} falha(s)\n` : '\nTudo passou\n')
process.exit(falhas ? 1 : 0)
