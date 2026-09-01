#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, clearSaved, readSaved, URL_HOSPEDADA } from './src/config.js'
import { runServer } from './src/server.js'
import { runLogin } from './src/login.js'
import { runHook } from './src/hook.js'
import { healTetherIfRenamed } from './src/tether-heal.js'
import { installHooks, installHooksAuto, uninstallHooks, settingsPath, estadoDoGancho, temClaudeCode } from './src/hooks-install.js'
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
    // Sem endereco escolhido, o login vai para o servico hospedado. Quem tem um Trail proprio
    // passa o endereco uma vez (TRAIL_API_URL) e ele fica salvo dali em diante.
    const url = process.env.TETHER_API_URL || readSaved()?.url || URL_HOSPEDADA
    await runLogin(url)
    // Entrar na conta e o momento em que a pessoa liga o Trail de proposito - e o unico momento
    // em que da pra registrar o gancho de abertura sem inventar um passo novo pra ela. Antes disto
    // o gancho so existia no instalador por clone, que saiu de cena: quem entrou pelo caminho de
    // hoje ficava sem o resumo automatico e nem sabia que existia um.
    const gancho = installHooksAuto()
    if (gancho === 'instalado') {
      process.stdout.write('Resumo do projeto no inicio da conversa: ligado. Feche e abra o Claude pra valer.\n')
    } else if (gancho === 'falhou') {
      process.stdout.write('(nao consegui ligar o resumo automatico de abertura; rode: usetrail hooks install)\n')
    }
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
    process.stdout.write(`token:   ${cfg.token ? 'presente' : 'AUSENTE (rode: usetrail login)'}\n`)
    // O resumo do projeto na abertura da conversa. Responder isto aqui e o que evita a caca de
    // sete comandos que a IA faz quando alguem pergunta "o gancho esta configurado?".
    const gancho = {
      ligado: 'ligado (o resumo do projeto entra sozinho quando a conversa abre)',
      ausente: 'AUSENTE (rode: usetrail hooks install)',
      'sem-claude': 'nao se aplica - Claude Code nao encontrado nesta maquina',
      ilegivel: 'nao consegui ler a configuracao do Claude Code',
    }[estadoDoGancho()]
    process.stdout.write(`abertura: ${gancho}\n`)
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
      // Sem Claude Code na maquina, instalar CRIAVA a pasta e o arquivo de configuracao dele do
      // zero - numa maquina de quem usa Codex ou Antigravity, isso e deixar lixo de um programa
      // que a pessoa nem tem. Aconteceu de verdade: a IA do dono, perguntada se o gancho estava
      // configurado, rodou este comando e fabricou a configuracao.
      if (sub === 'install' && !temClaudeCode({ olharPath: true }) && !process.argv.includes('--forcar')) {
        process.stdout.write(
          [
            'Claude Code nao encontrado nesta maquina - nada foi criado.',
            'O gancho de abertura hoje e so dele. Nas outras IAs o Trail se apresenta pelas',
            'proprias instrucoes do conector, e nao ha nada pra instalar aqui.',
            'Acabou de instalar o Claude Code e ele ainda nao rodou? Repita com --forcar.',
            '',
          ].join('\n'),
        )
        return
      }
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
    process.stderr.write('uso: usetrail hooks <install|uninstall>\n')
    process.exit(1)
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(
      [
        'usetrail - o conector do Trail',
        '',
        'Uso:',
        '  usetrail            sobe o servidor MCP (stdio) - e o que a sua IA usa',
        '  usetrail login      conecta esta maquina ao Trail (login pelo site)',
        '  usetrail logout     apaga o token salvo',
        '  usetrail status     mostra url, projeto, se ha token e se o resumo de abertura esta ligado',
        '  usetrail doctor     acha a instalacao nesta maquina, diz a versao e destrava a',
        '                        atualizacao automatica quando ela parou (aceita um caminho)',
        '  usetrail hooks install|uninstall   registra/remove o gancho de abertura de sessao do',
        '                        Claude (tracker + MRP no contexto desde a primeira mensagem). O',
        '                        login ja registra sozinho - isto e pra quem removeu e quer de volta',
        '',
        'Env: TRAIL_API_URL (so para Trail proprio; sem ela o login vai para o servico hospedado),',
        '     TRAIL_PROJECT (default = nome da pasta atual).',
        '     Os nomes antigos (TETHER_*) continuam valendo, sem prazo pra acabar.',
        '',
      ].join('\n'),
    )
    return
  }
  // default (sem argumento): MCP server stdio
  maybeSelfUpdate()
  // Quem cola a credencial no registro em vez de entrar pelo site nunca roda o login - e ficaria
  // sem o gancho pra sempre. A primeira subida do servidor cobre esse caminho. Roda uma vez so
  // (marca em ~/.config/tether/hooks.json), e calado: aqui o stdout e do protocolo.
  installHooksAuto()
  // Auto-heal do .tether antes de resolver o projeto da sessao.
  await healTetherIfRenamed()
  await runServer(resolveConfig())
}

main().catch((err) => {
  process.stderr.write('[trail] ' + (err instanceof Error ? err.message : String(err)) + '\n')
  process.exit(1)
})
