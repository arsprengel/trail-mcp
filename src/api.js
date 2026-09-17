// Cliente REST do tether (mesmos endpoints do dashboard). Fala HTTP com Bearer token.
// Injeta o project da pasta aberta como default (Onboarding Parte C); a IA pode sobrescrever
// passando project explicito para mexer em outro projeto.
export function createApiClient({ url, token, project }, fetchImpl = fetch) {
  const base = (url || '').replace(/\/$/, '')
  // x-tether-actor: quem escreve aqui e a IA, nunca a pessoa na mao. O AUTOR continua sendo a conta
  // do token (o servidor resolve); este header so separa "aberto pela IA" de "aberto no dashboard".
  const authHeaders = { authorization: `Bearer ${token}`, 'x-tether-actor': 'agent' }

  // Falha de rede (ou servidor reiniciando) chegava na IA como erro cru da 1a tentativa, e uma
  // gravacao se perdia por um soluco de segundos. Repete so o que da pra repetir sem duplicar:
  // ler, alterar campos e apagar levam ao MESMO estado se rodarem duas vezes; criar, nao - um POST
  // repetido viraria um item/lembrete/anexo a mais no tracker, entao ele nunca e repetido.
  const METODOS_REPETIVEIS = new Set(['GET', 'PATCH', 'DELETE'])
  const ESPERA_MS = [300, 900]

  const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

  async function req(method, path, body) {
    if (!base || !token) {
      throw new Error('nao conectado - rode: TETHER_API_URL=<url> node <pasta-do-conector>/bin.js login')
    }
    const headers = { ...authHeaders }
    const opt = { method, headers }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      opt.body = JSON.stringify(body)
    }
    const repetivel = METODOS_REPETIVEIS.has(method)
    let ultimoMotivo = ''
    for (let tentativa = 0; ; tentativa++) {
      const ultima = !repetivel || tentativa >= ESPERA_MS.length
      try {
        const r = await fetchImpl(base + path, opt)
        // 502/503/504 e servidor reiniciando ou proxy sem quem atender: esperar resolve. Os outros
        // erros sao resposta legitima do servidor e sobem na hora, com a mensagem dele.
        if (!ultima && (r.status === 502 || r.status === 503 || r.status === 504)) {
          ultimoMotivo = `HTTP ${r.status}`
        } else {
          return r
        }
      } catch (e) {
        ultimoMotivo = e instanceof Error ? e.message : String(e)
        if (ultima) {
          throw new Error(
            `o servidor do Trail nao respondeu (${ultimoMotivo})` +
              (repetivel ? ` - tentei ${ESPERA_MS.length + 1}x` : '') +
              '. A operacao pode NAO ter sido gravada: confira antes de seguir.',
          )
        }
      }
      await dormir(ESPERA_MS[tentativa])
    }
  }

  async function jsonOrThrow(r, ctx) {
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      let msg = t
      try {
        const j = JSON.parse(t)
        if (j && typeof j.error === 'string') msg = j.error
      } catch {
        /* corpo nao-JSON: usa o texto cru mesmo */
      }
      const detail = msg ? ': ' + msg.slice(0, 200) : ''
      throw new Error(`${ctx} -> HTTP ${r.status}${detail}`)
    }
    return r.json()
  }

  function qs(filter = {}) {
    const f = { project, ...filter } // filter (ex: project explicito da IA) sobrescreve o default
    const p = new URLSearchParams()
    for (const k of ['project', 'status', 'type', 'tag']) if (f[k]) p.set(k, String(f[k]))
    const s = p.toString()
    return s ? '?' + s : ''
  }

  return {
    async listItems(filter = {}) {
      return jsonOrThrow(await req('GET', '/api/items' + qs(filter)), 'list_items')
    },
    async getItem(id) {
      const r = await req('GET', `/api/items/${id}`)
      if (r.status === 404) return null
      return jsonOrThrow(r, 'get_item')
    },
    async addItem(input = {}) {
      const body = { project, ...input } // project da pasta; input.project (se houver) sobrescreve
      return jsonOrThrow(await req('POST', '/api/items', body), 'add_item')
    },
    async updateItem(id, patch = {}) {
      return jsonOrThrow(await req('PATCH', `/api/items/${id}`, patch), 'update_item')
    },
    async moveItem(id, index, filter = {}) {
      return jsonOrThrow(await req('POST', `/api/items/${id}/move` + qs(filter), { index }), 'move_item')
    },
    async getNext(filter = {}) {
      return jsonOrThrow(await req('GET', '/api/next' + qs(filter)), 'get_next')
    },
    async deleteItem(id) {
      const r = await req('DELETE', `/api/items/${id}`)
      if (r.status === 404) return false
      await jsonOrThrow(r, 'delete_item')
      return true
    },
    // MRP (Memoria Referencial de Projeto): conhecimento duravel por projeto (comandos,
    // deploy, gotchas, decisoes, contexto). Mesmos endpoints /api/memory do dashboard.
    async listMemory(filter = {}) {
      const f = { project, ...filter }
      const p = new URLSearchParams()
      for (const k of ['project', 'category']) if (f[k]) p.set(k, String(f[k]))
      if (f.include_archived) p.set('include_archived', '1')
      const s = p.toString()
      return jsonOrThrow(await req('GET', '/api/memory' + (s ? '?' + s : '')), 'list_memory')
    },
    async getMemory(id) {
      const r = await req('GET', `/api/memory/${id}`)
      if (r.status === 404) return null
      return jsonOrThrow(r, 'get_memory')
    },
    async addMemory(input = {}) {
      const body = { project, ...input } // project da pasta; input.project (se houver) sobrescreve
      return jsonOrThrow(await req('POST', '/api/memory', body), 'add_memory')
    },
    async updateMemory(id, patch = {}) {
      return jsonOrThrow(await req('PATCH', `/api/memory/${id}`, patch), 'update_memory')
    },
    // Faxina (item #171): fecha uma rodada inteira numa chamada. project do corpo, igual ao POST.
    async reviewMemory(input = {}) {
      const body = { project, ...input }
      return jsonOrThrow(await req('POST', '/api/memory/review', body), 'review_memory')
    },
    // Lembretes/Agendamentos (item #12): "me lembra no dia X de Y". Mesmos endpoints
    // /api/reminders do dashboard. O disparo (e-mail/SMS) e fase futura; por ora o Trail guarda.
    async listReminders(filter = {}) {
      const f = { project, ...filter }
      const p = new URLSearchParams()
      for (const k of ['project', 'status']) if (f[k]) p.set(k, String(f[k]))
      const s = p.toString()
      return jsonOrThrow(await req('GET', '/api/reminders' + (s ? '?' + s : '')), 'list_reminders')
    },
    async addReminder(input = {}) {
      const body = { project, ...input } // project da pasta; input.project (se houver) sobrescreve
      return jsonOrThrow(await req('POST', '/api/reminders', body), 'add_reminder')
    },
    async updateReminder(id, patch = {}) {
      return jsonOrThrow(await req('PATCH', `/api/reminders/${id}`, patch), 'update_reminder')
    },
    async deleteReminder(id) {
      const r = await req('DELETE', `/api/reminders/${id}`)
      if (r.status === 404) return false
      await jsonOrThrow(r, 'delete_reminder')
      return true
    },
    // Anexos (#72): mesmos endpoints do dashboard. addAttachment manda o arquivo em base64 no
    // corpo JSON (a rota tambem aceita multipart, mas o MCP nao tem File - so base64).
    async addAttachment(itemId, input = {}) {
      return jsonOrThrow(await req('POST', `/api/items/${itemId}/attachments`, input), 'add_attachment')
    },
    async getAttachment(id) {
      const r = await req('GET', `/api/attachments/${id}`)
      if (r.status === 404) return null
      return jsonOrThrow(r, 'get_attachment')
    },
    // Bytes crus (usado so quando o metadado pede - imagem pequena sem texto extraido).
    async downloadAttachment(id) {
      const r = await req('GET', `/api/attachments/${id}/download`)
      if (r.status === 404) return null
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        throw new Error(`get_attachment -> HTTP ${r.status}${t ? ': ' + t.slice(0, 200) : ''}`)
      }
      return new Uint8Array(await r.arrayBuffer())
    },
  }
}
