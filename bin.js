#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, clearSaved, readSaved, URL_HOSPEDADA } from './src/config.js'
import { runServer } from './src/server.js'
import { runLogin } from './src/login.js'
import { runHook, envelopeAntigravity } from './src/hook.js'
import { healTetherIfRenamed } from './src/tether-heal.js'
import { installHooks, installHooksAuto, uninstallHooks, settingsPath, estadoDoGancho, temClaudeCode } from './src/hooks-install.js'
import {
  instalarOutrasIAsAuto,
  instalarGanchoGemini,
  registrarMcpAntigravity,
  instalarGanchoAntigravity,
  consertarGanchoAntigravity,
  desinstalarOutrasIAs,
  antigravityDir,
  temGeminiCli,
  temAntigravity,
  estadoGanchoGemini,
  estadoGanchoAntigravity,
  estadoMcpAntigravity,
  geminiSettingsPath,
  antigravityMcpPath,
  antigravityHooksPath,
  temPluginsAntigravity,
  marcarPluginAtivo,
  pluginJaCarregou,
  instalarPluginAntigravity,
  limparInstalacaoAntigaAntigravity,
  estadoPluginAntigravity,
  pluginDir,
} from './src/outras-ias.js'
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
    // As outras IAs seguem o mesmo caminho, com uma diferenca que vale ouro no Antigravity: alem do
    // resumo de abertura, e AQUI que o Trail entra na lista de ferramentas dele. O comando que o
    // guia ensina registra o Gemini CLI e nao alcanca o Antigravity - o registro dele mora em outro
    // arquivo, e sem esta linha a pessoa termina o guia achando que ligou.
    const outras = instalarOutrasIAsAuto()
    if (outras.mcp === 'registrado') {
      process.stdout.write('Antigravity encontrado: o Trail entrou na lista de ferramentas dele.\n')
    }
    if (outras.gemini === 'instalado' || outras.antigravity === 'instalado') {
      process.stdout.write('Resumo do projeto no inicio da conversa: ligado tambem na sua outra IA.\n')
    }
    // O QUE DEU ERRADO TEM QUE APARECER AQUI. Sem estas linhas, um registro que falhou por
    // configuracao quebrada saia calado, a pessoa lia so a frase afirmativa acima e fechava o
    // terminal achando que tinha terminado - que e exatamente o defeito que este trabalho corrige.
    for (const [oque, r] of [
      ['a lista de ferramentas do Antigravity', outras.mcp],
      ['o resumo de abertura do Gemini', outras.gemini],
      ['o resumo de abertura do Antigravity', outras.antigravity],
    ]) {
      if (r === 'ilegivel') process.stdout.write(`(nao mexi em ${oque}: a configuracao dessa IA esta ilegivel e eu nao sobrescrevo)\n`)
      else if (r === 'falhou') process.stdout.write(`(nao consegui ligar ${oque}; rode: usetrail hooks install)\n`)
    }
    // Sem esta linha, quem so tem Antigravity pedia algo na hora, nao encontrava ferramenta
    // nenhuma e concluia que nao tinha funcionado. So o Claude Code tinha esse aviso.
    if (outras.mcp === 'registrado' || outras.gemini === 'instalado' || outras.antigravity === 'instalado') {
      process.stdout.write('Feche e abra a sua IA para valer.\n')
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
    // Uma linha por IA ENCONTRADA nesta maquina. IA que a pessoa nao tem nao vira linha: o status
    // existe pra responder de primeira, e lista de programa ausente e ruido.
    const abertura = (ligadoTexto) => ({
      ligado: ligadoTexto,
      ausente: 'AUSENTE (rode: usetrail hooks install)',
      quebrado: 'registrado mas incompleto - rode: usetrail hooks install',
      desligado: 'registrado, mas desligado na configuracao dessa IA',
      ilegivel: 'nao consegui ler a configuracao dessa IA',
    })
    // A ressalva da pasta confiavel e SO do Gemini CLI: ele so roda gancho em pasta que a pessoa
    // marcou como confiavel (ele pergunta na primeira vez que abre ali). Repetir isso na linha do
    // Antigravity seria inventar uma regra que ele nao tem - e este trabalho inteiro nasceu de uma
    // frase que afirmava algo que nao era verdade.
    const aberturaGemini = abertura('ligado (entra sozinho na abertura, nas pastas que voce marcou como confiaveis no Gemini)')
    const aberturaAntigravity = abertura('ligado (o resumo entra sozinho na abertura da conversa)')
    if (temGeminiCli({ olharPath: true })) {
      process.stdout.write(`gemini:   ${aberturaGemini[estadoGanchoGemini()]}\n`)
    }
    if (temAntigravity()) {
      // Com o plugin, as duas metades (ferramentas e resumo) viraram uma coisa so, e uma linha so
      // conta a historia. A dupla de linhas antiga fica pra quem esta num Antigravity que ainda nao
      // conhece plugin - la o caminho antigo continua sendo o que funciona.
      const plugin = estadoPluginAntigravity()
      if (plugin !== 'ausente') {
        const dito = {
          ligado: 'ligado pelo plugin do Trail (ferramentas + resumo de abertura + regras, num pacote so)',
          'sem-resumo': 'ligado pelo plugin do Trail (ferramentas + regras); resumo de abertura AUSENTE - rode: usetrail hooks install',
          desligado: 'o plugin do Trail esta instalado, mas DESLIGADO no painel do Antigravity - ligue por la',
          quebrado: 'o plugin do Trail esta incompleto - rode: usetrail hooks install',
        }[plugin]
        process.stdout.write(`antigravity: ${dito}\n`)
        process.stdout.write(`  (pasta do plugin: ${pluginDir()})\n`)
        // Enquanto nao ha prova, as duas instalacoes convivem de proposito - e o status tem que
        // dizer isso, senao a pessoa que ve o Trail duplicado na lista de ferramentas acha que e bug.
        if (!pluginJaCarregou()) {
          process.stdout.write('  (o registro antigo continua ligado ate o Antigravity subir o Trail pelo pacote uma vez;\n')
          process.stdout.write('   ate la voce pode ver o Trail duas vezes na lista de ferramentas dele, e some sozinho)\n')
        }
      } else {
        const listado = {
          ligado: 'o Trail esta na lista de ferramentas dele',
          ausente: 'AUSENTE da lista de ferramentas - rode: usetrail hooks install',
          ilegivel: 'nao consegui ler a configuracao dele',
        }[estadoMcpAntigravity()]
        process.stdout.write(`antigravity: ${listado}; abertura ${aberturaAntigravity[estadoGanchoAntigravity()]}\n`)
      }
    }
    // O silencio sobre o Antigravity e a pior resposta possivel pra quem o usa num perfil (Windows)
    // e digita o comando em outro (WSL, um container, outro usuario) - o caso do proprio dono, onde
    // o Gemini CLI APARECE e o Antigravity nao. Por isso a dica sai sempre que o Antigravity nao
    // foi encontrado, e nao so quando nenhuma das duas aparece. Dizendo ONDE se procurou, a pessoa
    // reconhece o proprio caso.
    if (!temAntigravity()) {
      process.stdout.write(`antigravity: nao encontrado em ${antigravityDir()}\n`)
      process.stdout.write('  (usa Antigravity em outro perfil, como Windows ao lado do WSL? rode este comando de la)\n')
    }
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
    // O gatilho do Antigravity. O diretorio de trabalho aqui e a pasta da CONFIGURACAO dele, nunca
    // o projeto - a pasta de verdade vem na entrada. Sem ela, silencio: escrever no projeto errado
    // seria pior do que nao falar.
    if (sub === 'antigravity') {
      // Duas grafias e um plano C. A entrada vem de programa de terceiro como JSON cru: se o nome
      // do campo mudar, o gatilho ficaria mudo pra sempre sem ninguem descobrir.
      const lista = input.workspacePaths ?? input.workspace_paths
      const pasta = (Array.isArray(lista) ? lista.find((p) => typeof p === 'string' && p) : null) ?? input.cwd ?? null
      let payload = '{}'
      if (typeof pasta === 'string' && pasta) {
        await healTetherIfRenamed(pasta)
        const r = await runHook('context', { cwd: pasta }).catch(() => ({ exitCode: 0 }))
        try {
          const resumo = JSON.parse(r.stdout ?? '').hookSpecificOutput?.additionalContext
          if (resumo) payload = envelopeAntigravity(resumo)
        } catch {
          /* pasta sem nada rastreado, sem login ou sem rede: sai calado */
        }
      }
      process.stdout.write(payload, () => process.exit(0))
      return
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
    } else if (process.argv.includes('--texto')) {
      process.exit(outcome.exitCode)
    } else {
      // Envelope VAZIO em vez de nada. O Gemini CLI, quando a saida do gancho nao e JSON, cai no
      // canal de erro e mostra aquilo como mensagem de sistema pra pessoa - entao "nao ter nada a
      // dizer" precisa ser dito em JSON, senao qualquer ruido de terminal vira recado do Trail.
      process.stdout.write('{}', () => process.exit(outcome.exitCode))
    }
    return
  }
  if (cmd === 'hooks') {
    const sub = process.argv[3]
    if (sub === 'install' || sub === 'uninstall') {
      const forcar = process.argv.includes('--forcar')
      const claude = temClaudeCode({ olharPath: true })
      const gemini = temGeminiCli({ olharPath: true })
      const antigravity = temAntigravity()
      // Instalar NUNCA cria a configuracao de um programa que a pessoa nao tem. Ja aconteceu de
      // verdade: a IA do dono, perguntada se o gancho estava configurado, rodou este comando numa
      // maquina sem Claude Code e fabricou a pasta e o arquivo dele do zero.
      if (sub === 'install' && !claude && !gemini && !antigravity && !forcar) {
        process.stdout.write(
          [
            'Nenhuma IA compativel encontrada nesta maquina - nada foi criado.',
            'O resumo de abertura hoje existe para Claude Code, Gemini CLI e Antigravity.',
            'Acabou de instalar o Claude Code e ele ainda nao rodou? Repita com --forcar.',
            '(As outras duas criam a pasta de configuracao delas na primeira vez que abrem;',
            ' abra a sua uma vez e rode isto de novo.)',
            '',
          ].join('\n'),
        )
        return
      }
      // Cada IA no seu proprio try: uma configuracao estragada numa delas nao pode impedir as
      // outras de serem atendidas. Ja aconteceu de o comando morrer inteiro no Gemini e nunca
      // chegar no Antigravity - que e justamente o motivo desta versao existir.
      const results = []
      const tentar = (rotulo, fn) => {
        try {
          for (const r of fn()) results.push(rotulo ? `${rotulo} - ${r}` : r)
        } catch (e) {
          results.push(`${rotulo} - falhou, e a configuracao ficou intacta: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (sub === 'install') {
        if (claude || forcar) {
          tentar('Claude Code', () => [...installHooks(), `arquivo: ${settingsPath()} (backup .tether-bak ao lado)`])
        }
        // As respostas 'sem-gemini'/'sem-antigravity' nao viram linha: IA que a pessoa nao tem nao
        // precisa aparecer no relatorio de uma instalacao.
        // "Mexeu" e o que MUDOU, nao o que existe. Sem isto, o comando mandava fechar e abrir a IA
        // mesmo quando tudo ja estava no lugar e nada foi tocado.
        let mexeu = (claude || forcar) && estadoDoGancho() !== 'ligado'
        const frase = (feito, arquivo, r) => {
          if (r === 'instalado' || r === 'registrado') {
            mexeu = true
            return `${feito} em ${arquivo} (backup .tether-bak ao lado)`
          }
          return { 'ja-tinha': 'ja estava, nada a fazer', ilegivel: 'configuracao ilegivel: NADA foi escrito', falhou: 'nao consegui escrever' }[r]
        }
        // O arquivo entra na frase de cada IA porque cada uma guarda isso num lugar diferente - e
        // era justamente por nao saber ONDE olhar que este trabalho existe.
        //
        // O RESUMO DE ABERTURA SO E LIGADO COM CREDENCIAL. Sem ela o gatilho rodaria antes de cada
        // pensada da IA pra descobrir que nao ha login e devolver vazio: preco cobrado da pessoa em
        // toda mensagem, por nada. O registro do Trail na lista de ferramentas do Antigravity nao
        // tem esse problema e acontece de qualquer jeito - e ele que o guia deixa faltando hoje.
        const temCredencial = !!resolveConfig().token
        // O Antigravity que conhece plugin recebe TUDO num pacote so, e o caminho antigo e limpo
        // logo em seguida - sem isso ele subiria o Trail duas vezes. Sem o resumo quando falta a
        // credencial: o gatilho rodaria antes de cada pensada da IA so pra descobrir que nao ha
        // login, e o resto do pacote (ferramentas e regras) nao depende dela.
        if (temPluginsAntigravity()) {
          tentar('Antigravity', () => {
            const r = instalarPluginAntigravity({ comResumo: temCredencial })
            const linha = {
              instalado: `plugin do Trail instalado em ${pluginDir()}`,
              atualizado: `plugin do Trail atualizado em ${pluginDir()}`,
              'ja-tinha': 'plugin do Trail ja estava, nada a fazer',
              falhou: 'nao consegui escrever o plugin',
            }[r]
            if (r === 'instalado' || r === 'atualizado') mexeu = true
            const limpeza = limparInstalacaoAntigaAntigravity()
            if (limpeza === 'limpo') mexeu = true
            return [
              linha,
              limpeza === 'limpo' ? 'a instalacao antiga, espalhada em tres arquivos, foi removida (backup .tether-bak ao lado)' : null,
              limpeza === 'esperando-prova' ? 'o registro antigo FICA ate o Antigravity subir o Trail pelo pacote pelo menos uma vez - assim voce nao fica sem Trail se ele ignorar o pacote' : null,
              limpeza === 'ilegivel' ? 'nao consegui ler a configuracao antiga dele - ela ficou onde estava' : null,
              temCredencial ? null : 'resumo de abertura: NAO entrou ainda - falta entrar na conta (rode: usetrail login)',
            ].filter(Boolean)
          })
        }
        // Sem a prova de que o pacote carrega, o caminho antigo tambem e escrito: e ele que
        // sustenta o Trail nessa maquina ate o pacote se provar (ou nao).
        if (!temPluginsAntigravity() || !pluginJaCarregou()) {
          tentar('Antigravity', () => [frase('entrou na lista de ferramentas dele', antigravityMcpPath(), registrarMcpAntigravity())].filter(Boolean))
        }
        if (!temCredencial) {
          results.push('Resumo de abertura: NAO liguei ainda - falta entrar na conta (rode: usetrail login)')
        } else {
          tentar('Gemini CLI', () => {
            const existia = existsSync(geminiSettingsPath())
            const linha = frase('resumo de abertura registrado', geminiSettingsPath(), instalarGanchoGemini({ olharPath: true }))
            // Transparencia: se o arquivo nao existia, o comando ACABOU de cria-lo. Numa maquina
            // onde o Gemini CLI foi achado so pelo programa no caminho do sistema (por exemplo, o
            // do Windows visto de dentro do WSL), a pessoa precisa saber que apareceu arquivo novo.
            return [linha, !existia && existsSync(geminiSettingsPath()) ? 'esse arquivo nao existia e foi criado agora' : null].filter(Boolean)
          })
          // O conserto entra aqui tambem, e nao so no caminho automatico: sem ele, quem viu o
          // status dizer "registrado mas incompleto" rodava este comando, ouvia "ja estava" e
          // continuava quebrado - o remedio anunciado nao agia. So no caminho antigo: onde ha
          // plugin, o pacote inteiro ja foi escrito (e conferido) acima.
          if (!temPluginsAntigravity() || !pluginJaCarregou()) {
            tentar('Antigravity', () => {
              const linha = frase('resumo de abertura registrado', antigravityHooksPath(), instalarGanchoAntigravity())
              const reparo = consertarGanchoAntigravity() === 'consertado'
              if (reparo) mexeu = true
              return [linha, reparo ? 'resumo de abertura reparado' : null].filter(Boolean)
            })
          }
        }
        if (mexeu) results.push('Feche e abra a sua IA para valer.')
        else results.push('Nada precisou mudar.')
      } else {
        tentar('Claude Code', () => uninstallHooks())
        tentar('', () => {
          const r = desinstalarOutrasIAs()
          return r.length ? r : ['Gemini CLI / Antigravity: nada do Trail encontrado']
        })
      }
      process.stdout.write(results.map((r) => `  ${r}`).join('\n') + '\n')
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
        '  usetrail status     mostra url, projeto, se ha token e, para cada IA encontrada nesta',
        '                        maquina, se ela esta ligada e se o resumo de abertura esta ligado',
        '  usetrail doctor     acha a instalacao nesta maquina, diz a versao e destrava a',
        '                        atualizacao automatica quando ela parou (aceita um caminho)',
        '  usetrail hooks install|uninstall   registra/remove o resumo de abertura de conversa',
        '                        (tracker + MRP no contexto desde a primeira mensagem) em cada IA',
        '                        encontrada aqui - Claude Code, Gemini CLI e Antigravity. No',
        '                        Antigravity tambem poe o Trail na lista de ferramentas dele. O',
        '                        login ja faz sozinho - isto e pra quem removeu e quer de volta',
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
  // A PROVA de que o pacote do Antigravity carrega nesta maquina: quando ELE nos sobe, o registro
  // dele traz um carimbo no ambiente. Isto tem que vir ANTES da linha abaixo, porque e essa marca
  // que libera a remocao do caminho antigo - e, sem ela, o antigo fica de proposito.
  marcarPluginAtivo()
  // Mesma coisa para Gemini CLI e Antigravity. No Antigravity este e o caminho que MAIS importa:
  // e por aqui que o Trail entra na lista de ferramentas dele, porque o comando que o guia ensina
  // grava num arquivo que ele nao le. Tambem e aqui que o atalho do gatilho e consertado quando
  // some ou envelhece. Calado por construcao: aqui o stdout e do protocolo.
  instalarOutrasIAsAuto()
  // Auto-heal do .tether antes de resolver o projeto da sessao.
  await healTetherIfRenamed()
  await runServer(resolveConfig())
}

main().catch((err) => {
  process.stderr.write('[trail] ' + (err instanceof Error ? err.message : String(err)) + '\n')
  process.exit(1)
})
