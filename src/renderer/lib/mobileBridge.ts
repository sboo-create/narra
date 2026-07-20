import { Browser } from '@capacitor/browser'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import type { ApiResult, BookContent, LlmMessage, ProxyHealth, Settings } from '@shared/types'
import type { NarraApi } from '../../preload'

const DEFAULT_PROXY =
  (import.meta.env.VITE_NARRA_PROXY_URL as string | undefined) ||
  'https://narra-proxy-production.up.railway.app'

const SETTINGS_KEY = 'narra:settings'
const STATE_KEY = 'narra:state'

const BOOK_PAIRS: [string, string][] = [
  ['marcus.json', 'marcus-characters.json'],
  ['pikovaya.json', 'pikovaya-characters.json'],
  ['geroy.json', 'geroy-characters.json'],
  ['belye-nochi.json', 'belye-nochi-characters.json'],
  ['alye-parusa.json', 'alye-parusa-characters.json'],
  ['dama-s-sobachkoy.json', 'dama-s-sobachkoy-characters.json']
]

interface ChatHandlers {
  onChunk: (delta: string) => void
  onDone: (text: string) => void
  onError: (error: string, code?: string) => void
}

function b64FromBytes(bytes: Uint8Array): string {
  let out = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(out)
}

function bytesFromBase64(base64: string): Uint8Array {
  const raw = atob(base64.includes(',') ? base64.split(',')[1] : base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function arrayBufferFromBase64(base64: string): ArrayBuffer {
  const bytes = bytesFromBase64(base64)
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

function dataPart(dataUrl: string): string {
  return dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
}

async function readJsonPref<T>(key: string, fallback: T): Promise<T> {
  const { value } = await Preferences.get({ key })
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

async function writeJsonPref(key: string, value: unknown): Promise<void> {
  await Preferences.set({ key, value: JSON.stringify(value) })
}

async function getSettings(): Promise<Settings> {
  return readJsonPref<Settings>(SETTINGS_KEY, { proxyUrl: DEFAULT_PROXY })
}

async function proxyBase(): Promise<string> {
  return (await getSettings()).proxyUrl.replace(/\/+$/, '')
}

function noProxy<T = never>(): ApiResult<T> {
  return { ok: false, error: 'Не задан адрес прокси-сервера в настройках.', code: 'NO_PROXY' }
}

async function parseErr(res: Response): Promise<ApiResult<never>> {
  let msg = `Сервер вернул ${res.status}`
  let code: ApiResult<never>['code'] = 'NETWORK'
  try {
    const j = (await res.json()) as { error?: string; code?: ApiResult<never>['code'] }
    if (j.error) msg = j.error
    if (j.code) code = j.code
  } catch {
    /* ignore */
  }
  return { ok: false, error: msg, code }
}

function netErr(e: unknown): ApiResult<never> {
  return { ok: false, error: `Нет связи с прокси: ${(e as Error)?.message || String(e)}`, code: 'NETWORK' }
}

function extractJson<T>(text: string): T | null {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = t.search(/[[{]/)
  if (start === -1) return null
  const open = t[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1)) as T
        } catch {
          return null
        }
      }
    }
  }
  return null
}

async function readCache(kind: string, key: string, mime: string): Promise<ApiResult<{ dataUrl: string }>> {
  try {
    const r = await Filesystem.readFile({
      directory: Directory.Cache,
      path: `${kind}/${key}`
    })
    return { ok: true, data: { dataUrl: `data:${mime};base64,${r.data}` } }
  } catch {
    return { ok: false, error: 'not cached', code: 'UNKNOWN' }
  }
}

async function writeCache(kind: string, key: string, data: string): Promise<void> {
  await Filesystem.mkdir({
    directory: Directory.Cache,
    path: kind,
    recursive: true
  }).catch(() => {})
  await Filesystem.writeFile({
    directory: Directory.Cache,
    path: `${kind}/${key}`,
    data
  })
}

async function loadBundledBooks(): Promise<ApiResult<BookContent[]>> {
  const out: BookContent[] = []
  for (const [bookFile, charsFile] of BOOK_PAIRS) {
    try {
      const [fanfic, cf] = await Promise.all([
        fetch(`./content/${bookFile}`).then((r) => r.json()),
        fetch(`./content/${charsFile}`).then((r) => r.json())
      ])
      out.push({ fanfic, narratorVoice: cf.narratorVoice, characters: cf.characters })
    } catch {
      /* пара отсутствует или битая — пропускаем */
    }
  }
  return { ok: true, data: out }
}

async function llmText(messages: LlmMessage[], temperature = 0.7): Promise<ApiResult<{ text: string }>> {
  const base = await proxyBase()
  if (!base) return noProxy()
  try {
    const res = await fetch(`${base}/gigachat/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature })
    })
    if (!res.ok) return parseErr(res)
    const j = (await res.json()) as { text: string }
    return { ok: true, data: { text: j.text || '' } }
  } catch (e) {
    return netErr(e)
  }
}

export async function installMobileBridge(): Promise<void> {
  const api = {
    loadBooks: loadBundledBooks,

    getSettings,
    setSettings: async (next: Partial<Settings>) => {
      const merged = { ...(await getSettings()), ...next }
      await writeJsonPref(SETTINGS_KEY, merged)
      return merged
    },

    getState: () => readJsonPref<Record<string, unknown>>(STATE_KEY, {}),
    setState: async (next: Record<string, unknown>) => {
      await writeJsonPref(STATE_KEY, next)
      return { ok: true }
    },

    testProxy: async (): Promise<ApiResult<ProxyHealth>> => {
      const base = await proxyBase()
      if (!base) return noProxy()
      try {
        const res = await fetch(`${base}/health`)
        if (!res.ok) return parseErr(res)
        return { ok: true, data: (await res.json()) as ProxyHealth }
      } catch (e) {
        return netErr(e)
      }
    },

    llmText,
    llmJson: async <T = unknown>(messages: LlmMessage[]): Promise<ApiResult<T>> => {
      let lastErr = ''
      for (let i = 0; i < 3; i++) {
        const r = await llmText(messages, 0.5)
        if (!r.ok) {
          lastErr = r.error || 'ошибка'
          continue
        }
        const parsed = extractJson<T>(r.data!.text)
        if (parsed !== null) return { ok: true, data: parsed }
        lastErr = 'Модель вернула невалидный JSON'
      }
      return { ok: false, error: lastErr, code: 'PARSE' }
    },

    generateImage: async (
      prompt: string,
      cacheKey?: string,
      width = 768,
      height = 1024,
      force = false,
      engine?: 'kandinsky'
    ): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> => {
      const file = cacheKey ? `${cacheKey}.png` : ''
      if (file && !force) {
        const cached = await readCache('images', file, 'image/png')
        if (cached.ok) return { ok: true, data: { dataUrl: cached.data!.dataUrl, cached: true } }
      }
      const base = await proxyBase()
      if (!base) return noProxy()
      try {
        const res = await fetch(`${base}/kandinsky/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, width, height, engine })
        })
        if (!res.ok) return parseErr(res)
        const j = (await res.json()) as { image: string }
        if (!j.image) return { ok: false, error: 'Пустой результат', code: 'UNKNOWN' }
        if (file) await writeCache('images', file, j.image)
        return { ok: true, data: { dataUrl: `data:image/png;base64,${j.image}`, cached: false } }
      } catch (e) {
        return netErr(e)
      }
    },
    getCachedImage: (cacheKey: string) => readCache('images', `${cacheKey}.png`, 'image/png'),

    synthesize: async (
      payload: { text?: string; ssml?: string; voice: string },
      cacheKey?: string
    ): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> => {
      const file = cacheKey ? `${cacheKey}.wav` : ''
      if (file) {
        const cached = await readCache('audio', file, 'audio/wav')
        if (cached.ok) return { ok: true, data: { dataUrl: cached.data!.dataUrl, cached: true } }
      }
      const base = await proxyBase()
      if (!base) return noProxy()
      try {
        const res = await fetch(`${base}/salutespeech/synthesize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        if (!res.ok) return parseErr(res)
        const b64 = b64FromBytes(new Uint8Array(await res.arrayBuffer()))
        if (file) await writeCache('audio', file, b64)
        return { ok: true, data: { dataUrl: `data:audio/wav;base64,${b64}`, cached: false } }
      } catch (e) {
        return netErr(e)
      }
    },
    getCachedAudio: (cacheKey: string) => readCache('audio', `${cacheKey}.wav`, 'audio/wav'),

    generateAvatar: async (
      imageDataUrl: string,
      audioDataUrl: string,
      cacheKey?: string
    ): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> => {
      const file = cacheKey ? `${cacheKey}.mp4` : ''
      if (file) {
        const cached = await readCache('video', file, 'video/mp4')
        if (cached.ok) return { ok: true, data: { dataUrl: cached.data!.dataUrl, cached: true } }
      }
      const base = await proxyBase()
      if (!base) return noProxy()
      try {
        const res = await fetch(`${base}/avatar/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataPart(imageDataUrl), audio: dataPart(audioDataUrl) })
        })
        if (!res.ok) return parseErr(res)
        const j = (await res.json()) as { video?: string; error?: string; code?: string }
        if (j.error) return { ok: false, error: j.error, code: (j.code as never) || 'UNKNOWN' }
        if (!j.video) return { ok: false, error: 'Пустой результат', code: 'UNKNOWN' }
        if (file) await writeCache('video', file, j.video)
        return { ok: true, data: { dataUrl: `data:video/mp4;base64,${j.video}`, cached: false } }
      } catch (e) {
        return netErr(e)
      }
    },
    getCachedVideo: (cacheKey: string) => readCache('video', `${cacheKey}.mp4`, 'video/mp4'),
    animatePortrait: async (
      imageDataUrl: string,
      query: string,
      cacheKey?: string,
      quality?: 'lite' | 'hd'
    ): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> => {
      const file = cacheKey ? `${cacheKey}.mp4` : ''
      if (file) {
        const cached = await readCache('video', file, 'video/mp4')
        if (cached.ok) return { ok: true, data: { dataUrl: cached.data!.dataUrl, cached: true } }
      }
      const base = await proxyBase()
      if (!base) return noProxy()
      try {
        const res = await fetch(`${base}/animate/portrait`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataPart(imageDataUrl), query, quality })
        })
        if (!res.ok) return parseErr(res)
        const j = (await res.json()) as { video?: string; error?: string; code?: string }
        if (j.error) return { ok: false, error: j.error, code: (j.code as never) || 'UNKNOWN' }
        if (!j.video) return { ok: false, error: 'Пустой результат', code: 'UNKNOWN' }
        if (file) await writeCache('video', file, j.video)
        return { ok: true, data: { dataUrl: `data:video/mp4;base64,${j.video}`, cached: false } }
      } catch (e) {
        return netErr(e)
      }
    },
    deleteCachedVideo: async (cacheKey: string) => {
      await Filesystem.deleteFile({
        directory: Directory.Cache,
        path: `video/${cacheKey}.mp4`
      }).catch(() => {})
      return { ok: true, data: { ok: true } }
    },
    saveCachedVideo: async (cacheKey: string, dataUrl: string) => {
      await writeCache('video', `${cacheKey}.mp4`, dataPart(dataUrl))
      return { ok: true, data: { ok: true } }
    },

    checkAppUpdate: async () => ({ ok: true, data: { hasUpdate: false, version: '', url: '' } }),

    recognize: async (base64: string, mime: string): Promise<ApiResult<{ text: string }>> => {
      const base = await proxyBase()
      if (!base) return noProxy()
      try {
        const res = await fetch(`${base}/salutespeech/recognize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Type': mime },
          body: arrayBufferFromBase64(base64)
        })
        if (!res.ok) return parseErr(res)
        const j = (await res.json()) as { text: string }
        return { ok: true, data: { text: j.text || '' } }
      } catch (e) {
        return netErr(e)
      }
    },

    importBook: async () => ({
      ok: false,
      error: 'Импорт файлов на Android будет добавлен через системный выбор файла.',
      code: 'UNKNOWN'
    }),
    saveBookCharacters: async () => ({ ok: false, error: 'Импорт файлов на Android пока недоступен.', code: 'UNKNOWN' }),

    chat: (messages: LlmMessage[], handlers: ChatHandlers, temperature?: number): (() => void) => {
      const ctrl = new AbortController()
      ;(async () => {
        const base = await proxyBase()
        if (!base) {
          handlers.onError('Не задан адрес прокси-сервера в настройках.', 'NO_PROXY')
          return
        }
        try {
          const r = await fetch(`${base}/gigachat/chat`, {
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
                /* partial */
              }
            }
          }
          handlers.onDone(full)
        } catch (e) {
          if (!ctrl.signal.aborted) handlers.onError(String(e), 'NETWORK')
        }
      })()
      return () => ctrl.abort()
    }
  } satisfies NarraApi

  ;(window as unknown as { narra: NarraApi }).narra = api
  window.open = ((url?: string | URL) => {
    if (url) Browser.open({ url: String(url) })
    return null
  }) as typeof window.open
}
