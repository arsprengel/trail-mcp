#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, clearSaved, readSaved } from './src/config.js'
import { runServer } from './src/server.js'
import { runLogin } from './src/login.js'
import { runHook } from './src/hook.js'
import { healTetherIfRenamed } from './src/tether-heal.js'
import { installHooks, uninstallHooks, settingsPath } from './src/hooks-install.js'
import { runDoctor } from './src/doctor.js'
import { espelharAmbiente } from './src/nome-legado.js'

// Nome antigo (Tether) continua valendo em toda configuracao ja existente - ver nome-legado.js.
espelharAmbiente()

const cmd = process.argv[2]

const DIR = dirname(fileURLToPath(import.meta.url))
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

// Auto-atualizacao "na proxima inicializacao": quando instalado por clone (tem .git),
// dispara um git pull ff-only DESANEXADO em background, no maximo a cada 6h. A sessao
// atual segue com a versao ja carregada; a proxima ja sobe atualizada - ninguem precisa
// rodar git pull na mao. Fail-silent por construcao: sem rede, com conflito, sem git ou
// instalado via npx (sem .git), nada acontece e o server sobe normal.
function maybeSelfUpdate() {
  try {
    if (process.platform === 'win32') return
    if (!existsSync(join(DIR, '.git'))) return
    const stamp = join(DIR, '.last-pull')
    try {
      if (Date.now() - statSync(stamp).mtimeMs < UPDATE_INTERVAL_MS) return
    } catch {
      /* sem stamp ainda: primeira vez, segue */
    }
    writeFileSync(stamp, String(Date.now()))
    // O `npm install` reescreve o campo version do package-lock e deixa a arvore SUJA. Sem a
    // limpeza abaixo, o `pull --ff-only` seguinte e recusado, o fail-silent engole o erro e a
    // maquina congela NAQUELA versao para sempre - sem nada aparecer pra ninguem. Limpamos antes
    // (destrava quem ja esta preso) e depois (nao deixa preso pra proxima). O arquivo so existe
    // pra ser sobrescrito pelo install, entao descartar mudanca local nele nunca perde trabalho.
    const log = join(DIR, '.last-pull.log')
    const agora = 'date -u +%Y-%m-%dT%H:%M:%SZ'
    const sh = [
      '{',
      `  git -C "${DIR}" checkout -- package-lock.json 2>/dev/null`,
      `  if git -C "${DIR}" pull --ff-only --quiet; then`,
      `    npm --prefix "${DIR}" install --omit=dev --silent --no-audit --no-fund`,
      `    git -C "${DIR}" checkout -- package-lock.json 2>/dev/null`,
      `    echo "ok $(${agora}) versao $(git -C "${DIR}" rev-parse --short HEAD)"`,
      '  else',
      `    echo "FALHOU $(${agora}) - segue em $(git -C "${DIR}" rev-parse --short HEAD). Rode: git -C ${DIR} status"`,
      '  fi',
      `} > "${log}" 2>&1`,
    ].join('\n')
    spawn('sh', ['-c', sh], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* atualizacao nunca pode atrapalhar o server */
  }
}

async function main() {
  if (cmd === 'login') {
    const url = process.env.TETHER_API_URL || readSaved()?.url
    if (!url) {
      process.stderr.write(
        'Defina o endereco do Trail no 1o login (o admin te passa), ex:\n' +
          `  TETHER_API_URL=https://SEU-TETHER node ${join(DIR, 'bin.js')} login\n`,
      )
      process.exit(1)
    }
    await runLogin(url)
    return
  }
  if (cmd === 'doctor') {
    // Destrava a atualizacao automatica de uma maquina que parou. Roda por npx (codigo sempre
    // novo), acha a pasta da instalacao sozinho e aceita um caminho explicito como argumento.
    process.exit(runDoctor(process.argv[3]))
  }
  if (cmd === 'logout') {
    process.stdout.write(clearSaved() ? 'Token removido.\n' : 'Nenhum token salvo.\n')
    return
  }
  if (cmd === 'status') {
    const cfg = resolveConfig()
    process.stdout.write(`url:     ${cfg.url}\n`)
    process.stdout.write(`project: ${cfg.project}\n`)
    process.stdout.write(`token:   ${cfg.token ? 'presente' : 'AUSENTE (rode: tether-mcp login)'}\n`)
    return
  }
  if (cmd === 'hook') {
    // Chamado pelo gancho de inicio de sessao da ferramenta de IA (no Claude Code, SessionStart).
    // Nunca pode derrubar a sessao: qualquer erro inesperado vira exit 0 silencioso, e nada aqui
    // sai por exit != 0. Com `--texto`, imprime o resumo puro em vez do envelope do Claude Code.
    const sub = process.argv[3]
    let input = {}
    try {
      const chunks = []
      for await (const c of process.stdin) chunks.push(c)
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw) {
        const v = JSON.parse(raw)
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) input = v
      }
    } catch {
      /* stdin ruim: segue com input vazio */
    }
    // So "context" faz trabalho; "reconcile" (hook de Stop dos settings antigos) sai calado aqui,
    // sem nem resolver config ou tocar a rede - ele roda a cada fim de turno.
    if (sub !== 'context') process.exit(0)
    // Auto-heal do .tether ANTES de ler (pega renames; nunca derruba o hook).
    await healTetherIfRenamed(input.cwd ?? process.cwd())
    const outcome = await runHook(sub, input).catch(() => ({ exitCode: 0 }))
    let payload = outcome.stdout ?? outcome.stderr
    // O envelope JSON e o contrato do Claude Code. Ferramenta que injeta a saida do gancho como
    // TEXTO (Gemini e afins) mostraria o JSON cru, entao `--texto` devolve so o conteudo.
    if (payload && outcome.stdout && process.argv.includes('--texto')) {
      try {
        payload = JSON.parse(payload).hookSpecificOutput?.additionalContext ?? payload
      } catch {
        /* saida que nao e o envelope conhecido: manda como veio */
      }
    }
    if (payload) {
      const stream = outcome.stdout ? process.stdout : process.stderr
      stream.write(payload, () => process.exit(outcome.exitCode))
    } else {
      process.exit(outcome.exitCode)
    }
    return
  }
  if (cmd === 'hooks') {
    const sub = process.argv[3]
    if (sub === 'install' || sub === 'uninstall') {
      try {
        const results = sub === 'install' ? installHooks() : uninstallHooks()
        process.stdout.write(results.map((r) => `  ${r}`).join('\n') + '\n')
        process.stdout.write(`(arquivo: ${settingsPath()}; backup .tether-bak ao lado)\n`)
        if (sub === 'install') process.stdout.write('Reinicie as sessoes do Claude para valer.\n')
      } catch (e) {
        process.stderr.write(`hooks ${sub} falhou (settings.json intacto): ${e instanceof Error ? e.message : String(e)}\n`)
        process.exit(1)
      }
      return
    }
    process.stderr.write('uso: tether-mcp hooks <install|uninstall>\n')
    process.exit(1)
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(
      [
        'tether-mcp - MCP do Trail',
        '',
        'Uso:',
        '  tether-mcp            sobe o servidor MCP (stdio) - usado pelo Claude',
        '  tether-mcp login      conecta esta maquina ao Trail (login pelo site)',
        '  tether-mcp logout     apaga o token salvo',
        '  tether-mcp status     mostra url, projeto e se ha token',
        '  tether-mcp doctor     acha a instalacao nesta maquina, diz a versao e destrava a',
        '                        atualizacao automatica quando ela parou (aceita um caminho)',
        '  tether-mcp hooks install|uninstall   registra/remove o hook de abertura de sessao do Claude',
        '                        (tracker + MRP automaticos no inicio, lembrete no stop)',
        '',
        'Env: TRAIL_API_URL (endereco do Trail; obrigatorio no 1o login, o admin te passa),',
        '     TRAIL_PROJECT (default = nome da pasta atual).',
        '     Os nomes antigos (TETHER_*) continuam valendo, sem prazo pra acabar.',
        '',
      ].join('\n'),
    )
    return
  }
  // default (sem argumento): MCP server stdio
  maybeSelfUpdate()
  // Auto-heal do .tether antes de resolver o projeto da sessao.
  await healTetherIfRenamed()
  await runServer(resolveConfig())
}

main().catch((err) => {
  process.stderr.write('[tether-mcp] ' + (err instanceof Error ? err.message : String(err)) + '\n')
  process.exit(1)
})
