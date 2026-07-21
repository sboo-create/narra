import { Browser } from '@capacitor/browser'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import type {
  ApiResult,
  BookContent,
  Chapter,
  Character,
  CharactersFile,
  Fanfic,
  LlmMessage,
  ProxyHealth,
  Settings
} from '@shared/types'
import type { NarraApi } from '../../preload'

const DEFAULT_PROXY =
  (import.meta.env.VITE_NARRA_PROXY_URL as string | undefined) ||
  'https://narra-proxy-production.up.railway.app'

const SETTINGS_KEY = 'narra:settings'
const STATE_KEY = 'narra:state'
const USER_BOOK_IDS_KEY = 'narra:userBookIds'
const USER_BOOKS_DIR = 'books'

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

function stripTags(t: string): string {
  return t
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function decodeBook(bytes: ArrayBuffer): string {
  const sample = new Uint8Array(bytes.slice(0, Math.min(bytes.byteLength, 60000)))
  const score = (t: string) =>
    (t.match(/[а-яёА-ЯЁ]/g)?.length || 0) - 10 * (t.match(/\uFFFD/g)?.length || 0)

  let best = 'utf-8'
  let bestScore = -Infinity
  for (const enc of ['utf-8', 'windows-1251', 'koi8-r']) {
    try {
      const text = new TextDecoder(enc, { fatal: false }).decode(sample)
      const currentScore = score(text)
      if (currentScore > bestScore) {
        best = enc
        bestScore = currentScore
      }
    } catch {
      /* encoding is not supported in this WebView */
    }
  }

  return new TextDecoder(best, { fatal: false }).decode(bytes)
}

function parseFb2(text: string): { title: string; author: string; chapters: Chapter[] } {
  const titleM = text.match(/<book-title>(.*?)<\/book-title>/s)
  const fnM = text.match(/<first-name>(.*?)<\/first-name>/s)
  const lnM = text.match(/<last-name>(.*?)<\/last-name>/s)
  const title = titleM ? stripTags(titleM[1]) : 'Без названия'
  const author = [fnM, lnM].map((m) => (m ? stripTags(m[1]) : '')).filter(Boolean).join(' ') || 'Неизвестный автор'
  const bodyStart = text.indexOf('<body')
  const body = bodyStart >= 0 ? text.slice(bodyStart).split('</body>')[0] : text
  const toks = body.split(/(<section[^>]*>|<\/section>)/)
  const stack: { buf: string[]; hasChild: boolean }[] = []
  const leaves: string[] = []

  for (const tok of toks) {
    if (tok.startsWith('<section')) {
      stack.push({ buf: [], hasChild: false })
    } else if (tok === '</section>') {
      const node = stack.pop()
      if (node && !node.hasChild) leaves.push(node.buf.join(''))
      if (stack.length) stack[stack.length - 1].hasChild = true
    } else if (stack.length) {
      stack[stack.length - 1].buf.push(tok)
    }
  }

  const chapters: Chapter[] = []
  for (const c of leaves) {
    const tm = c.match(/<title>(.*?)<\/title>/s)
    const secTitle = tm ? stripTags(tm[1]) : ''
    const bodytext = tm ? c.slice(c.indexOf(tm[0]) + tm[0].length) : c
    const paras = [...bodytext.matchAll(/<p>(.*?)<\/p>/gs)].map((m) => stripTags(m[1])).filter(Boolean)
    if (paras.length < 3) continue
    chapters.push({
      number: chapters.length + 1,
      title: secTitle || `Глава ${chapters.length + 1}`,
      summary: '',
      characters: [],
      text: paras.join('\n\n')
    })
  }

  return { title, author, chapters }
}

function parseTxt(text: string, fallbackTitle: string): { title: string; author: string; chapters: Chapter[] } {
  const norm = text.replace(/\r\n/g, '\n')
  const parts = norm.split(/\n(?=\s*(?:Глава|ГЛАВА|Chapter)\s+[\wIVXLC0-9])/)
  const chapters: Chapter[] = []

  if (parts.length > 2) {
    for (const p of parts) {
      const lines = p.trim().split('\n')
      const title = lines[0].trim().slice(0, 80)
      const body = lines.slice(1).join('\n').trim()
      if (body.split(/\s+/).length < 100) continue
      chapters.push({
        number: chapters.length + 1,
        title,
        summary: '',
        characters: [],
        text: body.replace(/\n{3,}/g, '\n\n')
      })
    }
  }

  if (chapters.length === 0) {
    const words = norm.split(/\s+/)
    for (let i = 0; i < words.length; i += 2500) {
      chapters.push({
        number: chapters.length + 1,
        title: `Часть ${chapters.length + 1}`,
        summary: '',
        characters: [],
        text: words.slice(i, i + 2500).join(' ')
      })
    }
  }

  return { title: fallbackTitle, author: 'Неизвестный автор', chapters }
}

function pickBookFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.fb2,.txt,text/plain,application/x-fictionbook+xml'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0] || null
        input.remove()
        resolve(file)
      },
      { once: true }
    )
    input.click()
  })
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

async function readDataJson<T>(path: string): Promise<T> {
  const r = await Filesystem.readFile({ directory: Directory.Data, path })
  return JSON.parse(String(r.data)) as T
}

async function writeDataJson(path: string, value: unknown): Promise<void> {
  await Filesystem.mkdir({ directory: Directory.Data, path: USER_BOOKS_DIR, recursive: true }).catch(() => {})
  await Filesystem.writeFile({
    directory: Directory.Data,
    path,
    data: JSON.stringify(value)
  })
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

async function loadUserBooks(): Promise<BookContent[]> {
  const ids = await readJsonPref<string[]>(USER_BOOK_IDS_KEY, [])
  const books: BookContent[] = []

  for (const id of ids) {
    try {
      const [fanfic, cf] = await Promise.all([
        readDataJson<Fanfic>(`${USER_BOOKS_DIR}/${id}.json`),
        readDataJson<CharactersFile>(`${USER_BOOKS_DIR}/${id}-characters.json`)
      ])
      books.push({ fanfic, narratorVoice: cf.narratorVoice, characters: cf.characters })
    } catch {
      /* битая пара или удаленный файл — пропускаем */
    }
  }

  return books
}

async function loadBooks(): Promise<ApiResult<BookContent[]>> {
  const bundled = await loadBundledBooks()
  const user = await loadUserBooks()
  return { ok: true, data: [...(bundled.data || []), ...user] }
}

async function importBook(): Promise<ApiResult<{ id: string; title: string; author: string; chapters: number; words: number; excerpt: string }>> {
  const file = await pickBookFile()
  if (!file) return { ok: false, error: 'Отменено', code: 'UNKNOWN' }

  try {
    const low = file.name.toLowerCase()
    if (!low.endsWith('.fb2') && !low.endsWith('.txt')) {
      return { ok: false, error: 'На Android сейчас поддержаны .fb2 и .txt.', code: 'UNKNOWN' }
    }

    const text = decodeBook(await file.arrayBuffer())
    const base = file.name.replace(/\.(fb2|txt)$/i, '') || 'Моя книга'
    const parsed = low.endsWith('.fb2') ? parseFb2(text) : parseTxt(text, base)
    if (parsed.chapters.length === 0) return { ok: false, error: 'Не удалось найти главы в файле', code: 'PARSE' }

    const id = `u-${Date.now().toString(36)}`
    const words = parsed.chapters.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0)
    const book: Fanfic = {
      id,
      title: parsed.title,
      author: parsed.author,
      pairing: 'Загруженная книга',
      tags: ['Мои книги'],
      description: `${parsed.title} — ${parsed.author}. ${parsed.chapters.length} глав.`,
      coverPrompt: `обложка книги «${parsed.title}» (${parsed.author}), атмосферная, по духу произведения`,
      chapters: parsed.chapters
    }

    await writeDataJson(`${USER_BOOKS_DIR}/${id}.json`, book)
    await writeDataJson(`${USER_BOOKS_DIR}/${id}-characters.json`, { narratorVoice: 'Pon', characters: [] })
    await writeJsonPref(USER_BOOK_IDS_KEY, [...(await readJsonPref<string[]>(USER_BOOK_IDS_KEY, [])), id])

    const excerpt = parsed.chapters.slice(0, 2).map((c) => c.text).join('\n\n').slice(0, 9000)
    return { ok: true, data: { id, title: parsed.title, author: parsed.author, chapters: parsed.chapters.length, words, excerpt } }
  } catch (e) {
    return { ok: false, error: `Импорт не удался: ${(e as Error).message}`, code: 'UNKNOWN' }
  }
}

async function saveBookCharacters(bookId: string, charactersInput: unknown): Promise<ApiResult<{ ok: true }>> {
  try {
    const characters = Array.isArray(charactersInput) ? (charactersInput as Character[]) : []
    const book = await readDataJson<Fanfic>(`${USER_BOOKS_DIR}/${bookId}.json`)
    const stemsOf = (c: Character) =>
      [...new Set([c.name, ...c.fullName.split(/\s+/)])]
        .map((w) => w.toLowerCase().replace(/[аяйь]$/, ''))
        .filter((w) => w.length >= 4)
    const owners = new Map<string, number>()
    for (const c of characters) for (const st of new Set(stemsOf(c))) owners.set(st, (owners.get(st) || 0) + 1)

    for (const c of characters) {
      let unlock = 1
      const stems = stemsOf(c).filter((st) => owners.get(st) === 1)
      for (const ch of book.chapters) {
        const low = ch.text.toLowerCase()
        if (stems.some((st) => low.includes(st))) {
          unlock = ch.number
          break
        }
      }
      c.unlockChapter = unlock
    }

    await writeDataJson(`${USER_BOOKS_DIR}/${bookId}-characters.json`, { narratorVoice: 'Pon', characters })
    return { ok: true, data: { ok: true } }
  } catch (e) {
    return { ok: false, error: (e as Error).message, code: 'UNKNOWN' }
  }
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
    loadBooks,

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

    importBook,
    saveBookCharacters,

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
