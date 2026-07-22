/*
 * Браузерная заглушка window.narra — позволяет открыть renderer в обычном
 * браузере (vite dev, localhost:5173) и проверять UI без Electron.
 * В Electron не активируется: там window.narra создаёт preload.
 * Картинки здесь — локальные плейсхолдеры (не тратим API), текст — через прокси.
 */

interface ChatHandlers {
  onChunk: (delta: string) => void
  onDone: (text: string) => void
  onError: (error: string, code?: string) => void
}

const PROXY = 'http://localhost:8787'
const mem = new Map<string, string>()

function lsGet(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem('narra-state') || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function placeholder(w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const x = c.getContext('2d')!
  const g = x.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#ecdcc0')
  g.addColorStop(1, '#cfa878')
  x.fillStyle = g
  x.fillRect(0, 0, w, h)
  x.fillStyle = 'rgba(60,45,25,.45)'
  x.font = `600 ${Math.round(w / 12)}px sans-serif`
  x.textAlign = 'center'
  x.textBaseline = 'middle'
  x.fillText('превью', w / 2, h / 2)
  return c.toDataURL('image/png')
}

function extractJson(text: string): unknown | null {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = t.search(/[[{]/)
  if (start === -1) return null
  try {
    return JSON.parse(t.slice(start))
  } catch {
    return null
  }
}

async function loadJson(rel: string): Promise<unknown> {
  const res = await fetch(new URL(`../../../content/${rel}`, import.meta.url))
  return res.json()
}

export function installDevShim(): void {
  const llmText = async (messages: unknown, temperature?: number) => {
    try {
      const r = await fetch(`${PROXY}/gigachat/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, temperature })
      })
      if (!r.ok) return { ok: false, error: `LLM ${r.status}`, code: 'NETWORK' }
      return { ok: true, data: await r.json() }
    } catch (e) {
      return { ok: false, error: String(e), code: 'NETWORK' }
    }
  }

  const api = {
    loadBooks: async () => {
      const pairs: [string, string][] = [
        ['fanfic.json', 'characters.json'],
        ['marcus.json', 'marcus-characters.json'],
        ['pikovaya.json', 'pikovaya-characters.json'],
        ['geroy.json', 'geroy-characters.json'],
        ['gwtw.json', 'gwtw-characters.json'],
        ['belye-nochi.json', 'belye-nochi-characters.json'],
        ['alye-parusa.json', 'alye-parusa-characters.json'],
        ['dama-s-sobachkoy.json', 'dama-s-sobachkoy-characters.json']
      ]
      const data: unknown[] = []
      for (const [f, c] of pairs) {
        try {
          const fanfic = (await loadJson(f)) as Record<string, unknown>
          const cf = (await loadJson(c)) as { narratorVoice: string; characters: unknown[] }
          data.push({ fanfic, narratorVoice: cf.narratorVoice, characters: cf.characters })
        } catch {
          /* нет пары — пропускаем */
        }
      }
      return { ok: true, data }
    },
    getSettings: async () => ({ proxyUrl: PROXY }),
    setSettings: async () => ({ proxyUrl: PROXY }),
    getState: async () => lsGet(),
    setState: async (next: Record<string, unknown>) => {
      localStorage.setItem('narra-state', JSON.stringify(next))
      return { ok: true }
    },
    testProxy: async () => {
      try {
        const r = await fetch(`${PROXY}/health`)
        if (!r.ok) throw new Error(String(r.status))
        return { ok: true, data: await r.json() }
      } catch {
        return { ok: false, error: 'нет связи с прокси', code: 'NETWORK' }
      }
    },
    llmText,
    llmJson: async (messages: unknown) => {
      const r = await llmText(messages, 0.5)
      if (!r.ok) return r
      const parsed = extractJson((r.data as { text: string }).text)
      return parsed === null
        ? { ok: false, error: 'невалидный JSON', code: 'PARSE' }
        : { ok: true, data: parsed }
    },
    generateImage: async (_prompt: string, cacheKey?: string, w = 768, h = 1024, _force?: boolean, _engine?: 'kandinsky') => {
      const key = cacheKey || `${w}x${h}`
      if (!mem.has(key)) mem.set(key, placeholder(w, h))
      return { ok: true, data: { dataUrl: mem.get(key)!, cached: false } }
    },
    getCachedImage: async (k: string) =>
      mem.has(k)
        ? { ok: true, data: { dataUrl: mem.get(k)! } }
        : { ok: false, error: 'not cached', code: 'UNKNOWN' },
    synthesize: async () => ({ ok: false, error: 'озвучка недоступна в браузерном превью', code: 'UNKNOWN' }),
    getCachedAudio: async () => ({ ok: false, error: 'not cached', code: 'UNKNOWN' }),
    generateAvatar: async () => ({ ok: false, error: 'видео недоступно в браузерном превью', code: 'UNKNOWN' }),
    getCachedVideo: async () => ({ ok: false, error: 'not cached', code: 'UNKNOWN' }),
    animatePortrait: async () => ({ ok: false, error: 'видео недоступно в браузерном превью', code: 'UNKNOWN' }),
    deleteCachedImage: async () => ({ ok: true, data: { ok: true } }),
    deleteCachedVideo: async () => ({ ok: true, data: { ok: true } }),
    saveCachedVideo: async () => ({ ok: true, data: { ok: true } }),
    checkAppUpdate: async () => ({ ok: true, data: { hasUpdate: false, version: '', url: '' } }),
    installUpdate: async () => ({ ok: false, error: 'только в приложении', code: 'UNKNOWN' }),
    deleteBook: async () => ({ ok: true, data: { builtin: true } }),
    bookExcerpt: async () => ({ ok: false, error: 'только в приложении', code: 'UNKNOWN' }),
    importBookFromUrl: async () => ({ ok: false, error: 'импорт по ссылке доступен только в приложении', code: 'UNKNOWN' }),
    recognize: async (base64: string, mime: string) => {
      try {
        const bin = atob(base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const r = await fetch(`${PROXY}/salutespeech/recognize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Type': mime },
          body: bytes
        })
        if (!r.ok) return { ok: false, error: `ASR ${r.status}`, code: 'NETWORK' }
        return { ok: true, data: await r.json() }
      } catch (e) {
        return { ok: false, error: String(e), code: 'NETWORK' }
      }
    },
    importBook: async () => ({ ok: false, error: 'Импорт доступен только в приложении', code: 'UNKNOWN' }),
    saveBookCharacters: async () => ({ ok: false, error: 'Импорт доступен только в приложении', code: 'UNKNOWN' }),
    chat: (messages: unknown, handlers: ChatHandlers, temperature?: number): (() => void) => {
      const ctrl = new AbortController()
      ;(async () => {
        try {
          const r = await fetch(`${PROXY}/gigachat/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, temperature }),
            signal: ctrl.signal
          })
          if (!r.ok || !r.body) {
            handlers.onError(`LLM ${r.status}`, 'NETWORK')
            return
          }
          const reader = r.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          let full = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop() || ''
            for (const line of lines) {
              const t = line.trim()
              if (!t.startsWith('data:')) continue
              const p = t.slice(5).trim()
              if (p === '[DONE]') continue
              try {
                const delta: string = JSON.parse(p)?.choices?.[0]?.delta?.content ?? ''
                if (delta) {
                  full += delta
                  handlers.onChunk(delta)
                }
              } catch {
                /* неполный кусок */
              }
            }
          }
          handlers.onDone(full)
        } catch (e) {
          handlers.onError(String(e), 'NETWORK')
        }
      })()
      return () => ctrl.abort()
    }
  }

  ;(window as unknown as { narra: unknown }).narra = api
  console.info('[narra] dev-shim активен: браузерное превью без Electron')
}
