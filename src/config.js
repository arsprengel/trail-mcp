import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { findTetherProject } from './tether-file.js'
import { PASTAS_DE_CONFIG, espelharAmbiente } from './nome-legado.js'

// Idempotente: bin.js ja chama, mas config.js tambem e importado direto em teste e em script solto.
espelharAmbiente()

// Sem endereco embutido de proposito: este repo e publico, mas o endereco do Trail e a conta
// sao privados da equipe. A URL vem do admin (env TETHER_API_URL no 1o login) e fica salva
// depois disso. A trava de acesso e o login do servidor, nao este codigo.

// Pasta onde a credencial fica salva. Escreve sempre na NOVA; le da antiga quando so ela existe,
// senao quem ja tinha login perderia o acesso no dia em que o produto mudou de nome.
export function configDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, PASTAS_DE_CONFIG[0])
}

// Todos os lugares onde a credencial PODE estar, na ordem de preferencia.
export function configDirsDeLeitura() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return PASTAS_DE_CONFIG.map((p) => join(base, p))
}

export function tokenPath() {
  return join(configDir(), 'token.json')
}

export function readSaved() {
  for (const dir of configDirsDeLeitura()) {
    try {
      return JSON.parse(readFileSync(join(dir, 'token.json'), 'utf8'))
    } catch {
      /* ausente ou ilegivel: tenta a proxima pasta */
    }
  }
  return null
}

export function writeSaved(data) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(tokenPath(), JSON.stringify(data, null, 2))
  // Token e credencial: so o dono le.
  try {
    chmodSync(tokenPath(), 0o600)
  } catch {
    /* windows/fs sem chmod: ignora */
  }
}

// Desconectar tem que apagar a credencial de TODAS as pastas possiveis: se so a nova fosse
// limpa, quem tem o token na pasta antiga clicava em desconectar e continuava conectado.
export function clearSaved() {
  let apagou = false
  for (const dir of configDirsDeLeitura()) {
    try {
      rmSync(join(dir, 'token.json'))
      apagou = true
    } catch {
      /* nao existia ali */
    }
  }
  return apagou
}

// Endereco do servico hospedado. E o default porque quem instala pelo registro publico chega
// SEM saber que existe variavel de ambiente - e, sem um padrao, o primeiro comando falha e a
// pessoa some. Quem roda um Trail proprio continua mandando no endereco por env ou pelo login
// ja salvo, que vencem este valor.
export const URL_HOSPEDADA = 'https://app.usetrail.dev'

// Resolve a config do server: env > token salvo (login) > servico hospedado.
// O project vem da PASTA ABERTA (ou TETHER_PROJECT): assim o Claude escreve no projeto
// certo no banco unico da nuvem, sem misturar projetos (Onboarding Parte C).
export function resolveConfig() {
  const saved = readSaved()
  const url = (process.env.TETHER_API_URL || saved?.url || URL_HOSPEDADA).replace(/\/$/, '')
  let token = process.env.TETHER_API_TOKEN || saved?.token || ''
  const authEnv = process.env.TETHER_API_AUTH
  if (!token && authEnv) token = authEnv.replace(/^Bearer\s+/i, '').trim()
  const project = process.env.TETHER_PROJECT || findTetherProject(process.cwd()) || basename(process.cwd())
  return { url, token, project }
}
