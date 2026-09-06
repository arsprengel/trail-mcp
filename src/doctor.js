import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { t } from './idioma.js'

// `doctor`: acha a instalacao do conector nesta maquina, diz em que versao ela esta e destrava a
// atualizacao automatica quando ela parou.
//
// Existe porque o conserto do congelamento (v1.15.0) NAO alcanca quem ja estava preso: quem
// entregaria a correcao e justamente a atualizacao quebrada. Este comando roda por `npx`, que
// sempre baixa codigo novo - entao ele chega mesmo na maquina congelada. E acha a pasta sozinho,
// porque pedir "entre na pasta do conector" so funciona pra quem sabe onde ela esta.

const NOMES = ['trail-mcp', 'tether-mcp']

function ehInstalacao(dir) {
  try {
    if (!existsSync(join(dir, '.git'))) return false
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return NOMES.includes(pkg.name)
  } catch {
    return false
  }
}

// Procura em profundidade limitada a partir da casa do usuario. Nao varre a maquina inteira de
// proposito: em disco grande isso levaria minutos e a pessoa esta esperando na frente do terminal.
function procurar(raiz, profundidade, achados, visitados) {
  if (profundidade < 0 || achados.length >= 5) return
  let entradas
  try {
    entradas = readdirSync(raiz, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entradas) {
    if (!e.isDirectory()) continue
    const nome = e.name
    // pastas que nunca conteriam a instalacao e custam caro pra varrer
    if (nome === 'node_modules' || nome === '.git' || nome === '.cache' || nome === 'Library') continue
    if (nome.startsWith('.') && !NOMES.includes(nome)) continue
    const dir = join(raiz, nome)
    let real
    try {
      real = statSync(dir).ino + ':' + statSync(dir).dev
    } catch {
      continue
    }
    if (visitados.has(real)) continue
    visitados.add(real)
    if (ehInstalacao(dir)) {
      achados.push(dir)
      continue // nao desce dentro de uma instalacao
    }
    procurar(dir, profundidade - 1, achados, visitados)
  }
}

export function acharInstalacoes(dirExplicito) {
  if (dirExplicito) return ehInstalacao(dirExplicito) ? [dirExplicito] : []
  const casa = homedir()
  const provaveis = []
  for (const nome of NOMES) {
    for (const meio of ['', 'projects', 'dev', 'src', 'code', 'repos', 'git']) {
      provaveis.push(meio ? join(casa, meio, nome) : join(casa, nome))
    }
  }
  const achados = provaveis.filter(ehInstalacao)
  if (achados.length) return achados
  const varridos = []
  procurar(casa, 4, varridos, new Set())
  return varridos
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function consertar(dir) {
  const antes = git(dir, ['rev-parse', '--short', 'HEAD'])
  let sujo = git(dir, ['status', '--short'])
  // O package-lock e o unico arquivo que a propria atualizacao suja - descartar mudanca local
  // nele nunca perde trabalho de ninguem, e e o que destrava o pull.
  if (sujo.includes('package-lock.json')) git(dir, ['checkout', '--', 'package-lock.json'])
  let erro = null
  try {
    git(dir, ['pull', '--ff-only', '--quiet'])
  } catch (e) {
    erro = (e.stderr || e.message || '').toString().trim().split('\n')[0]
  }
  const depois = git(dir, ['rev-parse', '--short', 'HEAD'])
  sujo = git(dir, ['status', '--short'])
  let versao = '?'
  try {
    versao = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
  } catch {
    /* sem package.json legivel: segue com ? */
  }
  return { dir, antes, depois, versao, mudou: antes !== depois, erro, sujo }
}

export function runDoctor(dirExplicito, out = process.stdout) {
  const dirs = acharInstalacoes(dirExplicito)
  if (!dirs.length) {
    out.write(
      t(
        'Nenhuma instalação por cópia local encontrada nesta máquina.\n' +
          'Isso normalmente é boa notícia: quer dizer que você usa a instalação que baixa a versão\n' +
          'mais nova toda vez, e nunca fica para trás. Nada a fazer aqui.\n',
        'No local-copy installation found on this machine.\n' +
          'That is usually good news: it means you use the installation that fetches the newest\n' +
          'version every time, and never falls behind. Nothing to do here.\n',
      ),
    )
    return 0
  }
  let problemas = 0
  for (const dir of dirs) {
    const r = consertar(dir)
    out.write(`\n${r.dir}\n`)
    if (r.erro) {
      problemas++
      out.write(t(`  NÃO consegui atualizar: ${r.erro}\n`, `  Could NOT update: ${r.erro}\n`))
      out.write(t(`  segue na versão ${r.versao}. Mande esta saída para quem cuida do Trail.\n`, `  still on version ${r.versao}. Send this output to whoever looks after Trail.\n`))
    } else if (r.mudou) {
      out.write(t(`  destravada: estava em ${r.antes}, agora está em ${r.depois} (versão ${r.versao})\n`, `  unblocked: was on ${r.antes}, now on ${r.depois} (version ${r.versao})\n`))
    } else {
      out.write(t(`  já estava em dia (${r.depois}, versão ${r.versao})\n`, `  already up to date (${r.depois}, version ${r.versao})\n`))
    }
    if (r.sujo) out.write(t(`  aviso: sobraram mudanças locais nesta pasta:\n`, `  warning: local changes were left in this folder:\n`) + `${r.sujo.split('\n').map((l) => '    ' + l).join('\n')}\n`)
  }
  out.write(t('\nFeche e abra a sua ferramenta de IA para a versão nova valer.\n', '\nRestart your AI tool for the new version to take effect.\n'))
  return problemas ? 1 : 0
}
