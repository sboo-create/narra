import { app } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'node:crypto'
import { clearGatewayToken, getGatewayIdentity, getSettings, setGatewayToken } from '../store'
import type { ApiResult, LlmMessage, LlmPurpose, ProxyHealth } from '../../shared/types'
import type { AnalyticsEvent } from '../../shared/analytics'
import { runLocalDataWrite } from '../local-data-barrier'
import { consumeOpenAiSse } from './sse-protocol'

function base(): string {
  return getSettings().proxyUrl.replace(/\/+$/, '')
}

let registration: Promise<string> | null = null
let registrationController: AbortController | null = null
let gatewayActivityController = new AbortController()
let localDataResetting = false

export function cancelGatewayActivity(): void {
  localDataResetting = true
  gatewayActivityController.abort(new Error('local data reset'))
  registrationController?.abort(new Error('local data reset'))
  registrationController = null
  registration = null
}

async function gatewayToken(): Promise<string> {
  const proxyUrl = base()
  const identity = getGatewayIdentity()
  if (identity.token && identity.tokenProxyUrl === proxyUrl) return identity.token
  if (registration) return registration
  registration = (async () => {
    const { signal, done } = withTimeout(10_000)
    registrationController = new AbortController()
    let response: Response
    try {
      response = await fetch(`${proxyUrl}/v2/installations/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installation_id: identity.installationId,
          app_version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          activation_token: process.env.NARRA_ACTIVATION_TOKEN || ''
        }),
        signal: AbortSignal.any([signal, registrationController.signal])
      })
    } finally {
      done()
    }
    if (!response.ok) throw new Error(`Регистрация gateway: ${response.status}`)
    const payload = (await response.json()) as { token?: string }
    if (!payload.token) throw new Error('Gateway не вернул installation token')
    setGatewayToken(payload.token, proxyUrl)
    return payload.token
  })()
  try {
    return await registration
  } finally {
    registration = null
    registrationController = null
  }
}

export async function gatewayFetch(
  pathname: string,
  init: RequestInit = {},
  retryAuth = true
): Promise<Response> {
  if (localDataResetting) throw new Error('local data reset in progress')
  const token = await gatewayToken()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  const suppliedSignal = init.signal
  const response = await fetch(`${base()}${pathname}`, {
    ...init,
    headers,
    signal: suppliedSignal
      ? AbortSignal.any([suppliedSignal, gatewayActivityController.signal])
      : gatewayActivityController.signal
  })
  if (response.status === 401 && retryAuth) {
    clearGatewayToken()
    return gatewayFetch(pathname, init, false)
  }
  return response
}

export async function sendTelemetryBatch(
  events: AnalyticsEvent[]
): Promise<ApiResult<{ accepted: number; rejected: Array<{ event_id: string }> }>> {
  if (!events.length) return { ok: true, data: { accepted: 0, rejected: [] } }
  try {
    const response = await gatewayFetch('/v2/events/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events })
    })
    if (!response.ok) return parseErr(response)
    return { ok: true, data: (await response.json()) as { accepted: number; rejected: Array<{ event_id: string }> } }
  } catch (error) {
    return netErr(error)
  }
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
  const code = (e as { code?: ApiResult<never>['code'] })?.code
  if (code && ['PARSE', 'CENSOR', 'VALIDATION', 'NETWORK'].includes(code)) {
    return { ok: false, error: msg, code }
  }
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
  temperature = 0.8,
  purpose: LlmPurpose = 'character_chat',
  requestId = randomRequestId()
): Promise<ApiResult<{ text: string }>> {
  if (!base()) return noProxy()
  const ctrl = new AbortController()
  const iv = setInterval(() => {
    if (signal.aborted) ctrl.abort()
  }, 150)
  try {
    const res = await gatewayFetch('/v2/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature, purpose, request_id: requestId }),
      signal: ctrl.signal
    })
    if (!res.ok || !res.body) {
      clearInterval(iv)
      return res.ok ? { ok: false, error: 'Пустой поток', code: 'NETWORK' } : await parseErr(res)
    }
    const full = await consumeOpenAiSse(
      res.body as unknown as AsyncIterable<Uint8Array>,
      onChunk
    )
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
  temperature = 0.7,
  purpose: LlmPurpose = 'structured_task',
  requestId = randomRequestId()
): Promise<ApiResult<{ text: string }>> {
  if (!base()) return noProxy()
  const { signal, done } = withTimeout(120000)
  try {
    const res = await gatewayFetch('/v2/ai/chat/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature, purpose, request_id: requestId }),
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
  const requestId = randomRequestId()
  for (let i = 0; i < attempts; i++) {
    const r = await chatComplete(messages, 0.5, 'structured_task', requestId)
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

function randomRequestId(): string {
  return randomUUID()
}

// ================= FusionBrain: изображения =================
function imagesDir(): string {
  return path.join(app.getPath('userData'), 'images')
}
function safeCacheKey(key: string): string {
  if (!/^[a-zA-Z0-9_-]{1,180}$/.test(key)) throw new Error('Некорректный ключ кэша')
  return key
}
function imgPath(key: string): string {
  return path.join(imagesDir(), `${safeCacheKey(key)}.png`)
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
    const res = await gatewayFetch('/v2/media/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, width, height, engine }),
      signal
    })
    done()
    if (!res.ok) return parseErr(res)
    const j = (await res.json()) as { image: string }
    if (!j.image) return { ok: false, error: 'Пустой результат', code: 'UNKNOWN' }
    if (cacheKey && !localDataResetting) {
      await runLocalDataWrite(async () => {
        await fs.mkdir(imagesDir(), { recursive: true })
        await fs.writeFile(imgPath(cacheKey), Buffer.from(j.image, 'base64'))
      })
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
  return path.join(audioDir(), `${safeCacheKey(key)}.wav`)
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
    const res = await gatewayFetch('/v2/speech/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    })
    done()
    if (!res.ok) return parseErr(res)
    const buf = Buffer.from(await res.arrayBuffer())
    if (cacheKey && !localDataResetting) {
      await runLocalDataWrite(async () => {
        await fs.mkdir(audioDir(), { recursive: true })
        await fs.writeFile(audioPath(cacheKey), buf)
      })
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
  return path.join(videoDir(), `${safeCacheKey(key)}.mp4`)
}

export async function deleteBookCache(bookId: string): Promise<void> {
  safeCacheKey(bookId)
  const belongsToBook = (filename: string) =>
    filename.includes(`-${bookId}-`) || filename.startsWith(`${bookId}-`)
  for (const directory of [imagesDir(), audioDir(), videoDir()]) {
    let entries: string[] = []
    try {
      entries = await fs.readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    await Promise.all(
      entries
        .filter(belongsToBook)
        .map(async (filename) => {
          try {
            await fs.unlink(path.join(directory, filename))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        })
    )
  }
}

export async function deleteCachedImage(cacheKey: string): Promise<ApiResult<{ ok: true }>> {
  try {
    await fs.unlink(imgPath(cacheKey))
  } catch {
    /* нет файла — ок */
  }
  return { ok: true, data: { ok: true } }
}

export async function saveCachedVideo(cacheKey: string, dataUrl: string): Promise<ApiResult<{ ok: true }>> {
  try {
    if (localDataResetting) throw new Error('local data reset in progress')
    await runLocalDataWrite(async () => {
      await fs.mkdir(videoDir(), { recursive: true })
      const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
      await fs.writeFile(videoPath(cacheKey), Buffer.from(b64, 'base64'))
    })
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
    const res = await gatewayFetch('/v2/media/avatar', {
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
    const video = j.video
    if (cacheKey && !localDataResetting) {
      await runLocalDataWrite(async () => {
        await fs.mkdir(videoDir(), { recursive: true })
        await fs.writeFile(videoPath(cacheKey), Buffer.from(video, 'base64'))
      })
    }
    return { ok: true, data: { dataUrl: `data:video/mp4;base64,${video}`, cached: false } }
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
    const res = await gatewayFetch('/v2/media/portrait-animation', {
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
    const video = j.video
    if (cacheKey && !localDataResetting) {
      await runLocalDataWrite(async () => {
        await fs.mkdir(videoDir(), { recursive: true })
        await fs.writeFile(videoPath(cacheKey), Buffer.from(video, 'base64'))
      })
    }
    return { ok: true, data: { dataUrl: `data:video/mp4;base64,${video}`, cached: false } }
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
    const res = await gatewayFetch('/v2/speech/recognize', {
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
