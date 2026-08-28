#!/usr/bin/env node
// Prova de que o pacote PUBLICAVEL funciona - nao o repositorio, o pacote.
//
// Empacota como o registro empacotaria, instala num diretorio limpo e conversa com o conector
// pelo mesmo protocolo que a ferramenta de IA usa. Pega o que "olhar o codigo" nao pega:
// arquivo que ficou de fora da lista de publicacao, dependencia esquecida, e servidor que sobe
// mas nao responde. Roda sem credencial de proposito: e assim que a maquina de um desconhecido
// abre o conector pela primeira vez.
//
// Uso: node scripts/smoke.mjs        (da raiz do repositorio)

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8'))
const TOOLS_ESPERADAS = ['add_item', 'list_items', 'get_next', 'list_memory', 'get_memory', 'add_memory']

let temp = null
let falhas = 0

function passo(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${nome}`))
    .catch((e) => {
      falhas++
      console.log(`  FALHOU ${nome}\n         ${e instanceof Error ? e.message : String(e)}`)
    })
}

function precisa(condicao, msg) {
  if (!condicao) throw new Error(msg)
}

function rodar(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.error) throw r.error
  return r
}

// Uma conversa completa com o conector pelo canal de texto (stdio), linha a linha em JSON - o
// mesmo jeito que a ferramenta de IA fala com ele.
function conversar(binario, mensagens, { env = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(process.execPath, [binario], {
      env: { ...process.env, TETHER_PROJECT: 'smoke', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const respostas = []
    let buffer = ''
    let erro = ''
    const fim = setTimeout(() => {
      proc.kill('SIGKILL')
      rejectP(new Error(`o conector nao respondeu em ${timeoutMs / 1000}s. stderr: ${erro.slice(0, 400)}`))
    }, timeoutMs)

    proc.stderr.on('data', (d) => (erro += d.toString()))
    proc.stdout.on('data', (d) => {
      buffer += d.toString()
      const linhas = buffer.split('\n')
      buffer = linhas.pop() ?? ''
      for (const linha of linhas) {
        if (!linha.trim()) continue
        try {
          respostas.push(JSON.parse(linha))
        } catch {
          clearTimeout(fim)
          proc.kill('SIGKILL')
          rejectP(new Error(`o conector escreveu algo que nao e JSON no canal do protocolo: ${linha.slice(0, 200)}`))
          return
        }
      }
      // Toda mensagem com id espera resposta; notificacao nao.
      const esperadas = mensagens.filter((m) => m.id !== undefined).length
      if (respostas.length >= esperadas) {
        clearTimeout(fim)
        proc.kill('SIGTERM')
        resolveP({ respostas, erro })
      }
    })
    proc.on('error', (e) => {
      clearTimeout(fim)
      rejectP(e)
    })
    for (const m of mensagens) proc.stdin.write(JSON.stringify(m) + '\n')
  })
}

async function main() {
  console.log(`\nProva do pacote ${PKG.name}@${PKG.version}\n`)

  // 1. Empacota exatamente como o registro empacotaria.
  const pack = rodar('npm', ['pack', '--silent'], { cwd: RAIZ })
  precisa(pack.status === 0, `npm pack falhou: ${pack.stderr}`)
  const tarball = join(RAIZ, pack.stdout.trim().split('\n').pop().trim())

  // 2. Instala num diretorio limpo, como um desconhecido instalaria.
  temp = mkdtempSync(join(tmpdir(), 'smoke-usetrail-'))
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ name: 'smoke', private: true }, null, 2))
  const install = rodar('npm', ['install', tarball, '--no-audit', '--no-fund', '--silent'], { cwd: temp })
  precisa(install.status === 0, `instalar o pacote falhou: ${install.stderr}`)
  const binario = join(temp, 'node_modules', PKG.name, 'bin.js')

  await passo('a ficha do catalogo bate com o pacote', () => {
    const ficha = JSON.parse(readFileSync(join(RAIZ, 'server.json'), 'utf8'))
    precisa(ficha.name === PKG.mcpName, `a ficha se chama "${ficha.name}" e o pacote declara "${PKG.mcpName}"`)
    precisa(ficha.version === PKG.version, `ficha na versao ${ficha.version}, pacote na ${PKG.version}`)
    precisa(ficha.packages?.[0]?.identifier === PKG.name, 'a ficha aponta pra outro pacote')
    precisa(ficha.packages?.[0]?.version === PKG.version, 'a versao do pacote dentro da ficha ficou pra tras')
    precisa((ficha.description ?? '').length <= 100, 'a descricao passa do teto de 100 caracteres do catalogo')
  })

  await passo('a ajuda abre e cita os comandos', () => {
    const r = rodar(process.execPath, [binario, '--help'])
    precisa(r.status === 0, `saiu com codigo ${r.status}`)
    for (const c of ['login', 'logout', 'status', 'doctor', 'hooks']) {
      precisa(r.stdout.includes(c), `a ajuda nao cita o comando "${c}"`)
    }
  })

  await passo('sem credencial, aponta pro servico hospedado em vez de morrer', () => {
    const r = rodar(process.execPath, [binario, 'status'], { env: { ...process.env, TETHER_PROJECT: 'smoke' } })
    precisa(r.status === 0, `saiu com codigo ${r.status}`)
    precisa(r.stdout.includes('https://app.usetrail.dev'), 'nao caiu no endereco padrao do servico hospedado')
    precisa(r.stdout.includes('project: smoke'), 'nao respeitou o projeto informado')
  })

  await passo('o conector responde e se apresenta com a versao do pacote', async () => {
    const { respostas } = await conversar(binario, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
      },
    ])
    const info = respostas[0]?.result?.serverInfo
    precisa(info, `resposta inesperada: ${JSON.stringify(respostas[0]).slice(0, 300)}`)
    precisa(info.name === 'trail', `se apresentou como "${info.name}", nao como "trail"`)
    precisa(
      info.version === PKG.version,
      `anunciou a versao ${info.version}, mas o pacote e ${PKG.version} (versao escrita a mao em algum lugar)`,
    )
  })

  await passo('as ferramentas do tracker e da memoria estao la', async () => {
    const { respostas } = await conversar(binario, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])
    const lista = respostas.find((r) => r.id === 2)?.result?.tools
    precisa(Array.isArray(lista), `tools/list nao devolveu lista: ${JSON.stringify(respostas).slice(0, 300)}`)
    const nomes = lista.map((t) => t.name)
    for (const t of TOOLS_ESPERADAS) precisa(nomes.includes(t), `faltou a ferramenta "${t}"`)
    console.log(`       (${nomes.length} ferramentas)`)
  })

  rmSync(tarball, { force: true })
}

main()
  .catch((e) => {
    falhas++
    console.log(`\n  FALHOU antes das checagens\n         ${e instanceof Error ? e.message : String(e)}`)
  })
  .finally(() => {
    if (temp) rmSync(temp, { recursive: true, force: true })
    console.log(falhas === 0 ? '\nTudo passou.\n' : `\n${falhas} checagem(ns) falharam.\n`)
    process.exit(falhas === 0 ? 0 : 1)
  })
