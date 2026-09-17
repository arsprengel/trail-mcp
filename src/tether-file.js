import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { ARQUIVOS_DE_PASTA } from './nome-legado.js'

// Vinculo por pasta: um arquivo .tether na pasta (ou em qualquer ancestral) diz qual projeto
// do Trail essa pasta representa, independente do nome da pasta. Espelha o mesmo resolver do
// repo tether (src/core/tether-file.ts). Prioridade de resolucao do projeto no MCP/hooks:
// TETHER_PROJECT (env) > .tether (mais proximo subindo) > nome da pasta (basename).

// Le o conteudo de um .tether e devolve o nome do projeto (ou null). Tolerante: ignora linhas
// em branco e comentarios (#...); prefere uma linha `project: nome` (ou `project=nome`); senao
// usa a 1a linha util.
export function parseTetherFile(content) {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
  for (const line of lines) {
    const m = line.match(/^project\s*[:=]\s*(.+)$/i)
    if (m) {
      const captured = m[1].trim()
      if (captured) return captured
    }
  }
  return lines[0] ?? null
}

// Sobe da startDir ate a raiz procurando o 1o .tether LEGIVEL e devolve { path, name } (name pode
// ser null se vazio/so-comentario). O path e usado pelo auto-heal (reescrever o nome quando o
// projeto foi renomeado). Espelha tether/src/core/tether-file.ts.
export function findTetherFile(startDir) {
  let dir = startDir
  for (;;) {
    // Na MESMA pasta o arquivo novo (.trail) vence o antigo (.tether) - mas o antigo continua
    // valendo pra sempre, e sozinho ele manda.
    for (const nome of ARQUIVOS_DE_PASTA) {
      const file = join(dir, nome)
      if (!existsSync(file)) continue
      let content = null
      try {
        content = readFileSync(file, 'utf8')
      } catch {
        content = null // ilegivel -> trata como se nao houvesse arquivo aqui, tenta o proximo
      }
      if (content !== null) return { path: file, name: parseTetherFile(content) }
    }
    const parent = dirname(dir)
    if (parent === dir) return null // chegou na raiz
    dir = parent
  }
}

// Compat: so o nome do projeto do .tether mais proximo (ou null).
export function findTetherProject(startDir) {
  const f = findTetherFile(startDir)
  return f ? f.name : null
}

// Copia de trabalho separada (worktree do git): a mesma pasta de projeto aberta duas vezes, uma
// por branch, cada uma com o NOME DA BRANCH. Como o nome do projeto sai do nome da pasta, a sessao
// aberta numa dessas copias pedia ao servidor um projeto que nao existe e voltava com tracker e
// MRP vazios - sem erro nenhum, parecendo projeto novo. Daqui em diante a copia separada responde
// pelo projeto da copia PRINCIPAL. Tudo resolvido lendo arquivo, sem chamar o git.
// Espelha tether/src/core/tether-file.ts.

// Ponteiro .git de uma pasta: pasta = repositorio normal; arquivo com `gitdir: X` = copia separada.
function lerPonteiroGit(dir) {
  const dotGit = join(dir, '.git')
  let info
  try {
    info = statSync(dotGit)
  } catch {
    return null
  }
  if (info.isDirectory()) return { gitdir: dotGit, separada: false }
  if (!info.isFile()) return null
  let content
  try {
    content = readFileSync(dotGit, 'utf8')
  } catch {
    return null
  }
  const alvo = content.match(/^\s*gitdir\s*[:=]\s*(.+?)\s*$/m)?.[1]
  return alvo ? { gitdir: resolve(dir, alvo), separada: true } : null
}

// Pasta .git COMUM (a do repositorio principal) a partir do gitdir da copia separada. O git deixa
// isso escrito num arquivo `commondir`; sem ele, o proprio caminho .../.git/worktrees/<nome> diz.
function pastaGitComum(gitdir) {
  try {
    const c = readFileSync(join(gitdir, 'commondir'), 'utf8').trim()
    if (c) return resolve(gitdir, c)
  } catch {
    /* copia antiga sem commondir: cai na leitura do caminho */
  }
  return gitdir.match(/^(.*)[/\\]worktrees[/\\][^/\\]+$/)?.[1] ?? null
}

// A pasta que REPRESENTA o projeto. So muda de resposta dentro de uma copia de trabalho separada;
// em pasta comum (com ou sem git) devolve a pasta aberta, igual a sempre.
export function pastaDoProjeto(startDir) {
  let dir = startDir
  for (;;) {
    const ponteiro = lerPonteiroGit(dir)
    if (ponteiro) {
      if (!ponteiro.separada) return startDir
      const comum = pastaGitComum(ponteiro.gitdir)
      const raiz = comum ? dirname(comum) : null
      // Repositorio bare (sem copia de trabalho principal) nao tem pasta pra emprestar o nome, e
      // ponteiro quebrado tambem nao: melhor manter a pasta aberta do que apontar pro lugar errado.
      return raiz && existsSync(join(raiz, '.git')) ? raiz : startDir
    }
    const parent = dirname(dir)
    if (parent === dir) return startDir
    dir = parent
  }
}

// O arquivo de pasta mais proximo, e - so quando a pasta aberta e uma copia separada - o da copia
// principal, que a subida a partir do worktree nao alcanca quando ele fica fora da arvore.
function acharArquivoDePasta(cwd, pasta) {
  const perto = findTetherFile(cwd)
  if (perto?.name) return perto
  if (pasta !== cwd) {
    const principal = findTetherFile(pasta)
    if (principal?.name) return principal
  }
  return perto
}

// A regra unica de escolha do projeto, num lugar so: TETHER_PROJECT > arquivo de pasta > nome da
// pasta. Devolve tambem o arquivo (pro auto-heal e pro aviso de amarracao) e a pasta que deu o nome.
export function resolverProjeto(cwd, env = process.env) {
  const pasta = pastaDoProjeto(cwd)
  const arquivo = env.TETHER_PROJECT ? null : acharArquivoDePasta(cwd, pasta)
  const project = env.TETHER_PROJECT || arquivo?.name || basename(pasta)
  return { project, arquivo, pasta }
}

// Troca o NOME no conteudo do .tether preservando comentarios/estrutura. Prefere a linha
// `project: X` (mantendo o prefixo); senao a 1a linha util (mantendo indentacao); se so havia
// comentarios/branco, anexa o nome. Funcao pura.
export function replaceTetherName(content, newName) {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*project\s*[:=]\s*)(.+?)(\s*)$/i)
    if (m) {
      lines[i] = m[1] + newName
      return lines.join('\n')
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.length > 0 && !t.startsWith('#')) {
      const indent = lines[i].match(/^(\s*)/)?.[1] ?? ''
      lines[i] = indent + newName
      return lines.join('\n')
    }
  }
  return content + (content.endsWith('\n') || content === '' ? '' : '\n') + newName + '\n'
}

// Reescreve o nome no arquivo .tether em `path` (best-effort).
export function rewriteTetherFile(path, newName) {
  const content = readFileSync(path, 'utf8')
  writeFileSync(path, replaceTetherName(content, newName))
}
