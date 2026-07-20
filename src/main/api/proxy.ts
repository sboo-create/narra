import { app } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { getSettings } from '../store'
import type { ApiResult, LlmMessage, ProxyHealth } from '../../shared/types'

function base(): string {
  return getSettings().proxyUrl.replace(/\/+$/, '')
}

function noProxy(): ApiResult<never> {
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
  const msg = (e as Error)?.message || 'Сетевая ошибка'
  if (/abort/i.test(msg)) return { ok: false, error: 'Запрос отменён', code: 'UNKNOWN' }
  return { ok: false, error: `Нет связи с прокси: ${msg}`, code: 'NETWORK' }
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, done: () => clearTimeout(t) }
}

// ================= Health =================
export async function testProxy(): Promise<ApiResult<ProxyHealth>> {
  if (!base()) return noProxy()
  const { signal, done } = withTimeout(10000)
  try {
    const res = await fetch(`${base()}/health`, { signal })
    done()
    if (!res.ok) return parseErr(res)
    const data = (await res.json()) as ProxyHealth
    return { ok: true, data }
  } catch (e) {
    done()
    return netErr(e)
  }
}

// ================= GigaChat: стриминг =================
export async function chatStream(
  messages: LlmMessage[],
  onChunk: (delta: string) => void,
  signal: { aborted: boolean },
  temperature = 0.8
): Promise<ApiResult<{ text: string }>> {
  if (!base()) return noProxy()
  const ctrl = new AbortController()
  const iv = setInterval(() => {
    if (signal.aborted) ctrl.abort()
  }, 150)
  try {
    const res = await fetch(`${base()}/gigachat/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature }),
      signal: ctrl.signal
    })
    if (!res.ok || !res.body) {
      clearInterval(iv)
      return res.ok ? { ok: false, error: 'Пустой поток', code: 'NETWORK' } : await parseErr(res)
    }
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const obj = JSON.parse(payload)
          const delta: string = obj?.choices?.[0]?.delta?.content ?? ''
          if (delta) {
            full += delta
            onChunk(delta)
          }
        } catch {
          /* partial */
        }
      }
    }
    clearInterval(iv)
    return { ok: true, data: { text: full } }
  } catch (e) {
    clearInterval(iv)
    return netErr(e)
  }
}

// ================= GigaChat: обычный ответ =================
export async function chatComplete(
  messages: LlmMessage[],
  temperature = 0.7
): Promise<ApiResult<{ text: string }>> {
  if (!base()) return noProxy()
  const { signal, done } = withTimeout(120000)
  try {
    const res = await fetch(`${base()}/gigachat/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature }),
      signal
    })
    done()
    if (!res.ok) return parseErr(res)
    const j = (await res.json()) as { text: string }
    return { ok: true, data: { text: j.text || '' } }
  } catch (e) {
    done()
    return netErr(e)
  }
}

// ================= GigaChat: JSON-задача =================
export async function chatJson<T = unknown>(messages: LlmMessage[], attempts = 3): Promise<ApiResult<T>> {
  let lastErr = ''
  for (let i = 0; i < attempts; i++) {
    const r = await chatComplete(messages, 0.5)
    if (!r.ok) {
      if (r.code === 'NO_PROXY' || r.code === 'NO_KEY' || r.code === 'AUTH') return r as ApiResult<T>
      lastErr = r.error || 'ошибка'
      continue
    }
    const parsed = extractJson<T>(r.data!.text)
    if (parsed !== null) return { ok: true, data: parsed }
    lastErr = 'Модель вернула невалидный JSON'
  }
  return { ok: false, error: lastErr, code: 'PARSE' }
}

// ================= FusionBrain: изображения =================
function imagesDir(): string {
  return path.join(app.getPath('userData'), 'images')
}
function imgPath(key: string): string {
  return path.join(imagesDir(), `${key}.png`)
}

export async function getCachedImage(cacheKey: string): Promise<ApiResult<{ dataUrl: string }>> {
  try {
    const buf = await fs.readFile(imgPath(cacheKey))
    return { ok: true, data: { dataUrl: `data:image/png;base64,${buf.toString('base64')}` } }
  } catch {
    return { ok: false, error: 'not cached', code: 'UNKNOWN' }
  }
}

export async function generateImage(
  prompt: string,
  cacheKey?: string,
  width = 768,
  height = 1024,
  force = false,
  engine?: 'kandinsky'
): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> {
  if (cacheKey && !force) {
    const c = await getCachedImage(cacheKey)
    if (c.ok) return { ok: true, data: { dataUrl: c.data!.dataUrl, cached: true } }
  }
  if (!base()) return noProxy()
  const { signal, done } = withTimeout(90000)
  try {
    const res = await fetch(`${base()}/kandinsky/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, width, height, engine }),
      signal
    })
    done()
    if (!res.ok) return parseErr(res)
    const j = (await res.json()) as { image: string }
    if (!j.image) return { ok: false, error: 'Пустой результат', code: 'UNKNOWN' }
    if (cacheKey) {
      await fs.mkdir(imagesDir(), { recursive: true })
      await fs.writeFile(imgPath(cacheKey), Buffer.from(j.image, 'base64'))
    }
    return { ok: true, data: { dataUrl: `data:image/png;base64,${j.image}`, cached: false } }
  } catch (e) {
    done()
    return netErr(e)
  }
}

// ================= SaluteSpeech: озвучка =================
function audioDir(): string {
  return path.join(app.getPath('userData'), 'audio')
}
function audioPath(key: string): string {
  return path.join(audioDir(), `${key}.wav`)
}

export async function getCachedAudio(cacheKey: string): Promise<ApiResult<{ dataUrl: string }>> {
  try {
    const buf = await fs.readFile(audioPath(cacheKey))
    return { ok: true, data: { dataUrl: `data:audio/wav;base64,${buf.toString('base64')}` } }
  } catch {
    return { ok: false, error: 'not cached', code: 'UNKNOWN' }
  }
}

export async function synthesize(
  payload: { text?: string; ssml?: string; voice: string },
  cacheKey?: string
): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> {
  if (cacheKey) {
    const c = await getCachedAudio(cacheKey)
    if (c.ok) return { ok: true, data: { dataUrl: c.data!.dataUrl, cached: true } }
  }
  if (!base()) return noProxy()
  const { signal, done } = withTimeout(60000)
  try {
    const res = await fetch(`${base()}/salutespeech/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    })
    done()
    if (!res.ok) return parseErr(res)
    const buf = Buffer.from(await res.arrayBuffer())
    if (cacheKey) {
      await fs.mkdir(audioDir(), { recursive: true })
      await fs.writeFile(audioPath(cacheKey), buf)
    }
    return { ok: true, data: { dataUrl: `data:audio/wav;base64,${buf.toString('base64')}`, cached: false } }
  } catch (e) {
    done()
    return netErr(e)
  }
}

// ================= GigaAvatar (говорящее видео) =================
function videoDir(): string {
  return path.join(app.getPath('userData'), 'video')
}
function videoPath(key: string): string {
  return path.join(videoDir(), `${key}.mp4`)
}

export async function saveCachedVideo(cacheKey: string, dataUrl: string): Promise<ApiResult<{ ok: true }>> {
  try {
    await fs.mkdir(videoDir(), { recursive: true })
    const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
    await fs.writeFile(videoPath(cacheKey), Buffer.from(b64, 'base64'))
    return { ok: true, data: { ok: true } }
  } catch (e) {
    return netErr(e)
  }
}

export async function deleteCachedVideo(cacheKey: string): Promise<ApiResult<{ ok: true }>> {
  try {
    await fs.unlink(videoPath(cacheKey))
  } catch {
    /* нет файла — ок */
  }
  return { ok: true, data: { ok: true } }
}

export async function getCachedVideo(cacheKey: string): Promise<ApiResult<{ dataUrl: string }>> {
  try {
    const buf = await fs.readFile(videoPath(cacheKey))
    return { ok: true, data: { dataUrl: `data:video/mp4;base64,${buf.toString('base64')}` } }
  } catch {
    return { ok: false, error: 'not cached', code: 'UNKNOWN' }
  }
}

export async function generateAvatar(
  imageDataUrl: string,
  audioDataUrl: string,
  cacheKey?: string
): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> {
  if (cacheKey) {
    const c = await getCachedVideo(cacheKey)
    if (c.ok) return { ok: true, data: { dataUrl: c.data!.dataUrl, cached: true } }
  }
  if (!base()) return noProxy()
  const image = imageDataUrl.includes(',') ? imageDataUrl.split(',')[1] : imageDataUrl
  const audio = audioDataUrl.includes(',') ? audioDataUrl.split(',')[1] : audioDataUrl
  const { signal, done } = withTimeout(540000)
  try {
    const res = await fetch(`${base()}/avatar/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, audio }),
      signal
    })
    done()
    if (!res.ok) return parseErr(res)
    const j = (await res.json()) as { video?: string; error?: string; code?: string }
    if (j.error) return { ok: false, error: j.error, code: (j.code as never) || 'UNKNOWN' }
    if (!j.video) return { ok: false, error: 'Пустой результат', code: 'UNKNOWN' }
    if (cacheKey) {
      await fs.mkdir(videoDir(), { recursive: true })
      await fs.writeFile(videoPath(cacheKey), Buffer.from(j.video, 'base64'))
    }
    return { ok: true, data: { dataUrl: `data:video/mp4;base64,${j.video}`, cached: false } }
  } catch (e) {
    done()
    return netErr(e)
  }
}

export async function animatePortrait(
  imageDataUrl: string,
  query: string,
  cacheKey?: string,
  quality: 'lite' | 'hd' = 'lite'
): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> {
  if (cacheKey) {
    const c = await getCachedVideo(cacheKey)
    if (c.ok) return { ok: true, data: { dataUrl: c.data!.dataUrl, cached: true } }
  }
  if (!base()) return noProxy()
  const image = imageDataUrl.includes(',') ? imageDataUrl.split(',')[1] : imageDataUrl
  const { signal, done } = withTimeout(540000)
  try {
    const res = await fetch(`${base()}/animate/portrait`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, query, quality }),
      signal
    })
    done()
    if (!res.ok) return parseErr(res)
    const j = (await res.json()) as { video?: string; error?: string; code?: string }
    if (j.error) return { ok: false, error: j.error, code: (j.code as never) || 'UNKNOWN' }
    if (!j.video) return { ok: false, error: 'Пустой результат', code: 'UNKNOWN' }
    if (cacheKey) {
      await fs.mkdir(videoDir(), { recursive: true })
      await fs.writeFile(videoPath(cacheKey), Buffer.from(j.video, 'base64'))
    }
    return { ok: true, data: { dataUrl: `data:video/mp4;base64,${j.video}`, cached: false } }
  } catch (e) {
    done()
    return netErr(e)
  }
}

// ================= ASR (распознавание речи) =================
export async function recognize(base64: string, mime: string): Promise<ApiResult<{ text: string }>> {
  if (!base()) return noProxy()
  const { signal, done } = withTimeout(60000)
  try {
    const res = await fetch(`${base()}/salutespeech/recognize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Type': mime },
      body: Buffer.from(base64, 'base64'),
      signal
    })
    done()
    if (!res.ok) return parseErr(res)
    const j = (await res.json()) as { text: string }
    return { ok: true, data: { text: j.text || '' } }
  } catch (e) {
    done()
    return netErr(e)
  }
}

// ================= JSON extractor =================
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

/** Проверка обновления приложения: сравнивает версию с ${base()}/app/latest. */
export async function checkAppUpdate(
  current: string
): Promise<ApiResult<{ hasUpdate: boolean; version: string; url: string }>> {
  if (!base()) return noProxy()
  const { signal, done } = withTimeout(15000)
  try {
    const res = await fetch(`${base()}/app/latest`, { signal })
    done()
    if (!res.ok) return parseErr(res)
    const j = (await res.json()) as { version?: string; url?: string }
    const latest = (j.version || '').trim()
    const newer = (a: string, b: string) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true
        if ((pa[i] || 0) < (pb[i] || 0)) return false
      }
      return false
    }
    return {
      ok: true,
      data: { hasUpdate: !!latest && !!j.url && newer(latest, current), version: latest, url: j.url || '' }
    }
  } catch (e) {
    done()
    return netErr(e)
  }
}
