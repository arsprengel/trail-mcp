import { spawn } from 'node:child_process'
import { t } from './idioma.js'
import { writeSaved, tokenPath } from './config.js'

// Abre a URL no navegador do usuario (best-effort; a URL impressa no terminal ja resolve).
function openBrowser(url) {
  const platform = process.platform
  const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* ignora: a URL no console resolve */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Device flow (Onboarding Parte A): pede um code, o usuario aprova logado no site, o CLI
// faz polling e salva o token. Estilo `gh auth login` - sem copiar/colar token a mao.
export async function runLogin(url, out = process.stdout) {
  const base = url.replace(/\/$/, '')
  out.write(t(`Conectando ao Trail em ${base}\n`, `Connecting to Trail at ${base}\n`))

  const startRes = await fetch(base + '/api/auth/device/start', { method: 'POST' })
  if (!startRes.ok) throw new Error(t(`nao consegui iniciar o login (device/start -> HTTP ${startRes.status})`, `could not start the sign-in (device/start -> HTTP ${startRes.status})`))
  const d = await startRes.json()
  const verifyUrl = d.verification_url_complete || `${base}/conectar?code=${d.user_code}`

  out.write('\n')
  out.write(t('  1. Abra no navegador (ja logado no Trail):\n', '  1. Open in your browser (already signed in to Trail):\n'))
  out.write(`     ${verifyUrl}\n`)
  out.write(t(`  2. Confira o codigo:  ${d.user_code}\n`, `  2. Check the code:  ${d.user_code}\n`))
  out.write(t('\nAguardando a autorizacao no site...\n', '\nWaiting for authorization on the site...\n'))
  openBrowser(verifyUrl)

  const interval = (d.interval || 2) * 1000
  const deadline = Date.now() + (d.expires_in || 600) * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    const pr = await fetch(base + '/api/auth/device/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: d.device_code }),
    })
    if (pr.status === 202) continue
    if (pr.status === 200) {
      const body = await pr.json()
      writeSaved({ url: base, token: body.token })
      // O caminho sai de quem GRAVA, nao escrito a mao: a pasta mudou de nome (tether -> trail) e a
      // frase ficou pra tras apontando pra pasta errada. Quem for procurar a propria credencial nao
      // pode ser mandado pro lugar errado, e agora nao ha como as duas divergirem de novo.
      out.write(t(`\nConectado. Token salvo em ${tokenPath()}\n`, `\nConnected. Token saved in ${tokenPath()}\n`))
      // NAO diga "o Claude": daqui nao da pra saber qual IA esta rodando o comando, e quem ligou
      // pelo Antigravity/Codex lia o nome errado na propria confirmacao.
      out.write(t('A sua IA ja escreve no tracker como voce. Pode fechar a aba do navegador.\n', 'Your AI now writes to the tracker as you. You can close the browser tab.\n'))
      return
    }
    if (pr.status === 410) throw new Error(t('o codigo expirou; rode o login de novo', 'the code expired; run the sign-in again'))
    throw new Error(t(`falha no login (poll -> HTTP ${pr.status})`, `sign-in failed (poll -> HTTP ${pr.status})`))
  }
  throw new Error(t('tempo esgotado esperando a autorizacao; rode o login de novo', 'timed out waiting for authorization; run the sign-in again'))
}
