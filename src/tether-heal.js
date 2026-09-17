import { resolveConfig } from './config.js'
import { resolverProjeto, rewriteTetherFile } from './tether-file.js'

// Auto-heal do .tether: se a pasta aponta pra um projeto que foi RENOMEADO no Trail, reescreve o
// arquivo pro nome atual (silencioso, idempotente). So quando ha config (url+token) e o nome vem
// de um .tether real - TETHER_PROJECT env manda e nao mexe em arquivo. Best-effort: qualquer erro
// e engolido, nunca derruba nem atrasa de forma fatal quem chama (hook e MCP server).
// Espelha tether/src/core/tether-heal.ts.
export async function healTetherIfRenamed(cwd = process.cwd(), fetchImpl = fetch) {
  try {
    if (process.env.TETHER_PROJECT) return
    const cfg = resolveConfig()
    if (!cfg.url || !cfg.token) return
    // Mesma resolucao da leitura: numa copia de trabalho separada o arquivo mora na copia principal.
    const found = resolverProjeto(cwd).arquivo
    if (!found || !found.name) return
    const url = cfg.url + '/api/projects/' + encodeURIComponent(found.name) + '/resolve'
    const r = await fetchImpl(url, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) return
    const data = await r.json()
    if (data && data.renamed && data.name && data.name !== found.name) rewriteTetherFile(found.path, data.name)
  } catch {
    // heal e acessorio; nunca propaga
  }
}
