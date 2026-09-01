import { spawn } from 'node:child_process'
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
  out.write(`Conectando ao Trail em ${base}\n`)

  const startRes = await fetch(base + '/api/auth/device/start', { method: 'POST' })
  if (!startRes.ok) throw new Error(`nao consegui iniciar o login (device/start -> HTTP ${startRes.status})`)
  const d = await startRes.json()
  const verifyUrl = d.verification_url_complete || `${base}/conectar?code=${d.user_code}`

  out.write('\n')
  out.write('  1. Abra no navegador (ja logado no Trail):\n')
  out.write(`     ${verifyUrl}\n`)
  out.write(`  2. Confira o codigo:  ${d.user_code}\n`)
  out.write('\nAguardando a autorizacao no site...\n')
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
      out.write(`\nConectado. Token salvo em ${tokenPath()}\n`)
      // NAO diga "o Claude": daqui nao da pra saber qual IA esta rodando o comando, e quem ligou
      // pelo Antigravity/Codex lia o nome errado na propria confirmacao.
      out.write('A sua IA ja escreve no tracker como voce. Pode fechar a aba do navegador.\n')
      return
    }
    if (pr.status === 410) throw new Error('o codigo expirou; rode o login de novo')
    throw new Error(`falha no login (poll -> HTTP ${pr.status})`)
  }
  throw new Error('tempo esgotado esperando a autorizacao; rode o login de novo')
}
