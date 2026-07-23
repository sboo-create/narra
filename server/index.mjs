import express from 'express'
import cors from 'cors'
import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import { httpsRequest } from './http.mjs'
import {
  parseAvatarBody,
  parseChatBody,
  parseImageBody,
  parsePortraitBody,
  parseSynthesisBody,
  validationErrors
} from './contracts.mjs'
import { llmRouteReadiness, requestChat } from './providers.mjs'
import { parseEventBatch } from './events.mjs'
import { createEventStore } from './event-store.mjs'
import { fetchWithRedirectPolicy, readBoundedBody } from './safe-fetch.mjs'
import { createConcurrencyGate, requestAbortSignal, withTimeout } from './concurrency.mjs'
import { analyticsRoute, completionProperties, providerAttemptProperties } from './analytics-properties.mjs'
import {
  createFixedWindowLimiter,
  createFixedWindowByteBudget,
  createTokenService,
  isInstallationId,
  requireGatewayAuth,
  resolveTokenSecret
} from './security.mjs'

// ================= Конфигурация =================
const PORT = process.env.PORT || 8787
const INSECURE = process.env.ALLOW_INSECURE_TLS === 'true'
const PRODUCTION = process.env.NODE_ENV === 'production'
if (PRODUCTION && INSECURE) throw new Error('ALLOW_INSECURE_TLS is forbidden in production')

function serviceUrl(name, raw, { allowPrivateHttp = false } = {}) {
  const value = String(raw || '').trim().replace(/\/+$/, '')
  if (!value) return ''
  const url = new URL(value)
  const privateHttp = allowPrivateHttp && url.protocol === 'http:' && url.hostname.endsWith('.railway.internal')
  const localDev = !PRODUCTION && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !privateHttp && !localDev) throw new Error(`${name} must use HTTPS`)
  if (url.username || url.password || url.hash) throw new Error(`${name} contains forbidden URL components`)
  return value
}
function envInt(name, fallback, max) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`)
  }
  return value
}
const REGISTRATION_LIMIT = envInt('REGISTRATION_LIMIT_PER_HOUR', 10, 1_000)
const API_LIMIT = envInt('API_LIMIT_PER_MINUTE', 120, 10_000)
const EVENT_LIMIT = envInt('EVENT_LIMIT_PER_MINUTE', 10, 1_000)
const AI_LIMIT = envInt('AI_LIMIT_PER_MINUTE', 30, 1_000)
const AI_DAILY_LIMIT = envInt('AI_LIMIT_PER_DAY', 500, 100_000)
const SPEECH_LIMIT = envInt('SPEECH_LIMIT_PER_MINUTE', 60, 2_000)
const SPEECH_DAILY_LIMIT = envInt('SPEECH_LIMIT_PER_DAY', 1_000, 100_000)
const IMAGE_LIMIT = envInt('IMAGE_LIMIT_PER_HOUR', 30, 2_000)
const IMAGE_DAILY_LIMIT = envInt('IMAGE_LIMIT_PER_DAY', 100, 10_000)
const VIDEO_LIMIT = envInt('VIDEO_LIMIT_PER_HOUR', 8, 500)
const VIDEO_DAILY_LIMIT = envInt('VIDEO_LIMIT_PER_DAY', 20, 2_000)
const IMPORT_LIMIT = envInt('IMPORT_LIMIT_PER_MINUTE', 6, 100)
const IMPORT_DAILY_LIMIT = envInt('IMPORT_LIMIT_PER_DAY', 20, 1_000)
const IMPORT_DAILY_BYTES_MB = envInt('IMPORT_LIMIT_MIB_PER_DAY', 300, 30_000)
const IMPORT_CONCURRENCY = envInt('IMPORT_CONCURRENCY', 2, 20)
const IMPORT_QUEUE_LIMIT = envInt('IMPORT_QUEUE_LIMIT', 2, 50)
const LLM_RESPONSE_MAX_BYTES = envInt('LLM_RESPONSE_MAX_MIB', 8, 64) * 1024 * 1024
const KANDINSKY_QUEUE_LIMIT = envInt('KANDINSKY_QUEUE_LIMIT', 6, 100)
const VIDEO_QUEUE_LIMIT = envInt('VIDEO_QUEUE_LIMIT', 4, 100)
const LLM_CONCURRENCY = envInt('LLM_CONCURRENCY', 8, 100)
const LLM_QUEUE_LIMIT = envInt('LLM_QUEUE_LIMIT', 16, 500)
const SPEECH_CONCURRENCY = envInt('SPEECH_CONCURRENCY', 8, 100)
const SPEECH_QUEUE_LIMIT = envInt('SPEECH_QUEUE_LIMIT', 16, 500)
const IMAGE_CONCURRENCY = envInt('IMAGE_CONCURRENCY', 4, 50)
const IMAGE_QUEUE_LIMIT = envInt('IMAGE_QUEUE_LIMIT', 12, 200)
const llmGate = createConcurrencyGate({ limit: LLM_CONCURRENCY, queueLimit: LLM_QUEUE_LIMIT, name: 'LLM' })
const speechGate = createConcurrencyGate({ limit: SPEECH_CONCURRENCY, queueLimit: SPEECH_QUEUE_LIMIT, name: 'Speech' })
const imageGate = createConcurrencyGate({ limit: IMAGE_CONCURRENCY, queueLimit: IMAGE_QUEUE_LIMIT, name: 'Image' })
const importGate = createConcurrencyGate({ limit: IMPORT_CONCURRENCY, queueLimit: IMPORT_QUEUE_LIMIT, name: 'Import' })
// Собирает Basic key из готового значения либо client id + secret.
function buildBasicKey(direct, clientId, clientSecret) {
  const d = (direct || '').trim()
  if (d) return d
  const id = (clientId || '').trim()
  const secret = (clientSecret || '').trim()
  if (id && secret) return Buffer.from(`${id}:${secret}`).toString('base64')
  return ''
}
// SaluteSpeech (speech.giga.chat): логин 'gigacons' + секрет → Basic base64(логин:секрет).
const SALUTE_CLIENT = (process.env.SBER_SALUTE_CLIENT || 'gigacons').trim()
const _saluteSecret = (process.env.SBER_SALUTE_AUTH_KEY || '').trim()
const SALUTE_KEY = _saluteSecret
  ? SALUTE_CLIENT
    ? Buffer.from(`${SALUTE_CLIENT}:${_saluteSecret}`).toString('base64')
    : _saluteSecret
  : buildBasicKey(
      process.env.SALUTESPEECH_AUTH_KEY,
      process.env.SALUTESPEECH_CLIENT_ID,
      process.env.SALUTESPEECH_CLIENT_SECRET
    )
// LiteLLM-шлюз для чата (уже держит ключи Сбера у команды).
const LLM_BASE_URL = serviceUrl('LLM_BASE_URL', process.env.LLM_BASE_URL, { allowPrivateHttp: true })
const LLM_API_KEY = (process.env.LLM_API_KEY || '').trim() // виртуальный ключ LiteLLM (sk-...)
const LLM_MODEL = (process.env.LLM_MODEL || 'gigachat-3-ultra').trim()

// Kandinsky 6.0 (studio.kandinskylab.ai) — один Bearer-токен
const KANDINSKY_TOKEN = (process.env.KANDINSKY_TOKEN || '').trim()
// SaluteSpeech — URL настраиваются через .env (у команды могут быть свои).
const SALUTE_OAUTH_URL = serviceUrl('SBER_SALUTE_OAUTH_URL', process.env.SBER_SALUTE_OAUTH_URL || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth')
const SALUTE_SYNTH_URL = serviceUrl('SBER_SALUTE_SYNTH_URL', process.env.SBER_SALUTE_SYNTH_URL || 'https://smartspeech.sber.ru/rest/v1/text:synthesize')
const SALUTE_RECOGNIZE_URL = serviceUrl('SBER_SALUTE_RECOGNIZE_URL', process.env.SBER_SALUTE_RECOGNIZE_URL || 'https://smartspeech.sber.ru/rest/v1/speech:recognize')
const SALUTE_RECOGNITION_MODEL = (process.env.SBER_SALUTE_RECOGNITION_MODEL || 'voice_messaging').trim()
const KANDINSKY_HOST = 'https://studio.kandinskylab.ai/api'
// Видео/аватар API (GigaAvatar: image + audio → говорящее видео)
const VIDEO_BASE_URL = serviceUrl('VIDEO_BASE_URL', process.env.VIDEO_BASE_URL, { allowPrivateHttp: true })
serviceUrl('OPENROUTER_BASE_URL', process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1')
const TRACTION_INGEST_URL = serviceUrl('TRACTION_INGEST_URL', process.env.TRACTION_INGEST_URL)
const TRACTION_INGEST_TOKEN = String(process.env.TRACTION_INGEST_TOKEN || '').trim()
const ANALYTICS_ENV = process.env.ANALYTICS_ENV || (PRODUCTION ? 'production' : 'development')
if (!['production', 'staging', 'development', 'test'].includes(ANALYTICS_ENV)) {
  throw new Error('ANALYTICS_ENV must be production, staging, development or test')
}
if (Boolean(TRACTION_INGEST_URL) !== Boolean(TRACTION_INGEST_TOKEN)) {
  throw new Error('TRACTION_INGEST_URL and TRACTION_INGEST_TOKEN must be configured together')
}
if (PRODUCTION && TRACTION_INGEST_TOKEN && TRACTION_INGEST_TOKEN.length < 32) {
  throw new Error('TRACTION_INGEST_TOKEN must contain at least 32 characters in production')
}
const REGISTRATION_ACTIVATION_SECRET = String(process.env.REGISTRATION_ACTIVATION_SECRET || '').trim()
if (PRODUCTION && REGISTRATION_ACTIVATION_SECRET.length < 32) {
  throw new Error('REGISTRATION_ACTIVATION_SECRET must contain at least 32 characters in production')
}

// ================= Токены (кэш ~30 мин) =================
const tokenCache = {} // scope -> { token, expiresAt }

async function getToken(scope, basicKey, oauthUrl) {
  if (!basicKey) throw httpErr('NO_KEY', `Не задан ключ для scope ${scope}`)
  const now = Date.now()
  const c = tokenCache[scope]
  if (c && c.expiresAt - 60_000 > now) return c.token

  const res = await httpsRequest(oauthUrl, {
    method: 'POST',
    insecure: INSECURE,
    timeoutMs: 20000,
    headers: {
      Authorization: `Basic ${basicKey}`,
      RqUID: randomUUID(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: `scope=${scope}`
  })
  if (res.status === 401 || res.status === 403) throw httpErr('AUTH', `OAuth отклонил ключ (${res.status}) для ${scope}`)
  if (res.status !== 200) throw httpErr('NETWORK', `OAuth статус ${res.status}: ${String(res.body).slice(0, 200)}`)
  const json = JSON.parse(res.body)
  const token = json.access_token || json.tok || json.token
  // exp у speech.giga.chat — в секундах; expires_at у Сбера — в мс
  const expiresAt = json.expires_at || (json.exp ? json.exp * 1000 : now + 25 * 60 * 1000)
  if (!token) throw httpErr('AUTH', 'OAuth: сервер не вернул токен')
  tokenCache[scope] = { token, expiresAt }
  return token
}

function httpErr(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}
function statusFor(code) {
  return { NO_KEY: 400, VALIDATION: 400, AUTH: 401, RATE: 429, TIMEOUT: 504, NETWORK: 502 }[code] || 500
}

// ================= Kandinsky 6.0 (kandinskylab) =================
// Стиль задаётся на клиенте (единая арт-дирекция), сервер не добавляет свой.
const STYLE_SUFFIX = ''

function kHeaders() {
  return { Authorization: `Bearer ${KANDINSKY_TOKEN}`, 'Content-Type': 'application/json' }
}

// подбираем поддерживаемое разрешение по ориентации
function resolutionFor(width, height) {
  if (height > width * 1.15) return '768x1280'
  if (width > height * 1.15) return '1280x768'
  return '1024x1024'
}

// Kandinsky не любит параллельных запросов — сериализуем и ретраим лимит.
let kandinskyChain = Promise.resolve()
let kandinskyPending = 0
function kandinskyQueued(prompt, width, height, signal) {
  if (kandinskyPending >= KANDINSKY_QUEUE_LIMIT) throw httpErr('RATE', 'Kandinsky: очередь переполнена')
  kandinskyPending += 1
  const run = kandinskyChain
    .then(() => {
      if (signal?.aborted) throw signal.reason || new Error('client disconnected')
      return kandinskyWithRetry(prompt, width, height, signal)
    })
    .finally(() => { kandinskyPending -= 1 })
  kandinskyChain = run.catch(() => {})
  return run
}
async function kandinskyWithRetry(prompt, width, height, signal, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await kandinskyGenerate(prompt, width, height, signal)
    } catch (e) {
      if (e.code === 'RATE' && i < attempts - 1) {
        console.error(`[kandinsky] лимит, жду 20с (попытка ${i + 2}/${attempts})`)
        await abortableDelay(20000, signal)
        continue
      }
      if (e.code === 'CENSOR' && i < attempts - 1) {
        // цензор смотрит на конкретный кадр — новая генерация обычно проходит
        console.error(`[kandinsky] цензор отклонил кадр, пробую ещё (попытка ${i + 2}/${attempts})`)
        continue
      }
      throw e
    }
  }
}

async function kandinskyGenerate(prompt, width = 768, height = 1024, signal) {
  const resolution = resolutionFor(width, height)
  // 1) создать задачу
  const runRes = await httpsRequest(`${KANDINSKY_HOST}/tasks/k6-image-t2i`, {
    method: 'POST',
    insecure: INSECURE,
    timeoutMs: 30000,
    signal,
    headers: kHeaders(),
    body: JSON.stringify({ params: { query: `${prompt}${STYLE_SUFFIX}`.slice(0, 950), resolution } })
  })
  if (runRes.status === 401 || runRes.status === 403) throw httpErr('AUTH', 'Kandinsky: токен отклонён')
  if (runRes.status === 429) throw httpErr('RATE', 'Kandinsky: лимит запросов')
  if (runRes.status >= 400) throw httpErr('NETWORK', `Kandinsky create ${runRes.status}: ${String(runRes.body).slice(0, 160)}`)
  const taskId = JSON.parse(runRes.body).task_id
  if (!taskId) throw httpErr('UNKNOWN', 'Kandinsky: нет task_id')

  // 2) поллинг статуса
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await abortableDelay(4000, signal)
    const st = await httpsRequest(`${KANDINSKY_HOST}/tasks/${taskId}`, {
      insecure: INSECURE,
      timeoutMs: 20000,
      signal,
      headers: kHeaders()
    })
    if (st.status >= 400) continue
    const status = String(JSON.parse(st.body).status || '').toLowerCase()
    if (status === 'done') break
    if (status === 'failed' || status === 'error') throw httpErr('UNKNOWN', 'Kandinsky: генерация не удалась')
    if (Date.now() >= deadline) throw httpErr('TIMEOUT', 'Kandinsky: таймаут (120с)')
  }

  // 3) забрать результат (бинарный PNG)
  const resImg = await httpsRequest(`${KANDINSKY_HOST}/tasks/${taskId}/result`, {
    insecure: INSECURE,
    timeoutMs: 30000,
    signal,
    binary: true,
    headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}` }
  })
  if (resImg.status === 422) {
    // выходной цензор: картинка нарисована, но заблокирована — ретрай даст новый кадр
    throw httpErr('CENSOR', 'Кандинский-цензор отклонил кадр')
  }
  if (resImg.status >= 400 || !resImg.body?.length) throw httpErr('UNKNOWN', 'Kandinsky: пустой результат')
  return resImg.body.toString('base64')
}

// ================= Видео (Kandinsky video API) =================
// Видеосервер не терпит параллельных запросов (429 LIMIT_EXHAUSTED) — очередь + ретраи.
let videoChain = Promise.resolve()
let videoPending = 0
function videoTask(taskType, params, signal) {
  if (videoPending >= VIDEO_QUEUE_LIMIT) throw httpErr('RATE', 'Видео: очередь переполнена')
  videoPending += 1
  const run = videoChain
    .then(() => {
      if (signal?.aborted) throw signal.reason || new Error('client disconnected')
      return videoTaskRetry(taskType, params, signal)
    })
    .finally(() => { videoPending -= 1 })
  videoChain = run.catch(() => {})
  return run
}
async function abortableDelay(milliseconds, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('client disconnected'))
    }, { once: true })
  })
}
async function videoTaskRetry(taskType, params, signal, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await videoTaskRaw(taskType, params, signal)
    } catch (e) {
      const msg = e.message || ''
      const isRate = e.code === 'RATE' || /LIMIT_EXHAUSTED|429/.test(msg)
      if (isRate && i < attempts - 1) {
        // 'concurrent' — заняты все GPU-слоты, освободятся через минуты; 'rate' — секунды
        const wait = /concurrent/.test(msg) ? 45000 : 10000
        console.error(`[video] лимит (${/concurrent/.test(msg) ? 'слоты заняты' : 'частота'}), жду ${wait / 1000}с (${i + 2}/${attempts})`)
        await abortableDelay(wait, signal)
        continue
      }
      throw e
    }
  }
}

async function videoTaskRaw(taskType, params, signal) {
  if (!VIDEO_BASE_URL) throw httpErr('NO_KEY', 'Видео: VIDEO_BASE_URL не задан')
  const create = await fetch(`${VIDEO_BASE_URL}/tasks/${taskType}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ censor: false, params }),
    signal: withTimeout(signal, 30_000)
  })
  if (create.status === 401 || create.status === 403) throw httpErr('AUTH', 'Видео: токен отклонён')
  if (create.status === 429) {
    const t = await create.text().catch(() => '')
    throw httpErr('RATE', `video create 429: ${t.slice(0, 120)}`)
  }
  if (!create.ok) {
    const t = await create.text().catch(() => '')
    throw httpErr('NETWORK', `video create ${create.status}: ${t.slice(0, 140)}`)
  }
  const { task_id } = await create.json()
  if (!task_id) throw httpErr('UNKNOWN', 'Видео: сервер не вернул task_id')

  const deadline = Date.now() + 480_000
  while (Date.now() < deadline) {
    await abortableDelay(5000, signal)
    const st = await fetch(`${VIDEO_BASE_URL}/tasks/${task_id}`, {
      headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}` },
      signal: withTimeout(signal, 20_000)
    })
    if (!st.ok) continue
    const j = await st.json()
    const status = String(j.status || '').toLowerCase()
    if (status === 'done') {
      const r = await fetch(`${VIDEO_BASE_URL}/tasks/${task_id}/result`, {
        headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}` },
        signal: withTimeout(signal, 60_000)
      })
      if (!r.ok) throw httpErr('UNKNOWN', 'Видео: результат недоступен')
      return Buffer.from(await r.arrayBuffer()).toString('base64')
    }
    if (status === 'failed' || status === 'error') {
      console.error(`[video] ${taskType} задача провалилась:`, j.error || '(без деталей)')
      throw httpErr('UNKNOWN', j.error || 'Видео: генерация не удалась')
    }
  }
  console.error(`[video] ${taskType} таймаут 300с`)
  throw httpErr('TIMEOUT', 'Видео: таймаут (8 мин)')
}

// говорящая голова: портрет + аудио (с ретраем)
async function gigaAvatar(image, audio, query, signal) {
  const params = {
    query: query || 'talking character portrait, front view, natural facial motion, subtle head movement',
    image,
    audio
  }
  return videoTask('giga_avatar', params, signal)
}

// idle-анимация портрета (без звука). Бьютификатор отключён — он падает на воркере.
// С ретраем: видео-воркер иногда падает разово.
async function animatePortrait(image, query, quality, signal) {
  const model = quality === 'hd' ? 'k5-i2v-hd' : 'k5-i2v-lite'
  const params = {
    query: query || 'he stays still, only blinks slowly and breathes subtly, locked camera, fixed framing, no zoom',
    image,
    beautificator: 'disabled'
  }
  return videoTask(model, params, signal)
}


// Долгие задачи: отвечаем сразу и шлём keep-alive пробелы, чтобы fetch клиента
// не обрывался по таймауту (undici ждёт первых байт максимум 5 минут).
// JSON.parse спокойно терпит ведущие пробелы.
async function longJob(res, job) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  const ka = setInterval(() => res.write(' '), 15000)
  try {
    const data = await job()
    clearInterval(ka)
    res.end(JSON.stringify(data))
  } catch (e) {
    clearInterval(ka)
    res.end(JSON.stringify({ error: e.message, code: e.code || 'UNKNOWN' }))
  }
}

// ================= Express =================
const app = express()
const allowedOrigins = new Set(
  String(process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
)
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true)
      callback(new Error('Origin is not allowed'))
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Audio-Type'],
    maxAge: 3600
  })
)
const tokenSecret = resolveTokenSecret()
const tokenService = createTokenService(tokenSecret)
const analyticsSecret = String(process.env.ANALYTICS_HMAC_SECRET || (!PRODUCTION ? tokenSecret : ''))
if (PRODUCTION && analyticsSecret.length < 32) throw new Error(
  'ANALYTICS_HMAC_SECRET must be a separate stable secret of at least 32 characters in production'
)
if (PRODUCTION && analyticsSecret === tokenSecret) {
  throw new Error('ANALYTICS_HMAC_SECRET must differ from GATEWAY_TOKEN_SECRET in production')
}
const eventStore = createEventStore({
  dataDir: process.env.DATA_DIR || (process.env.NODE_ENV === 'production'
    ? '/data'
    : new URL('./.data', import.meta.url).pathname),
  environment: ANALYTICS_ENV,
  tractionUrl: TRACTION_INGEST_URL,
  tractionToken: TRACTION_INGEST_TOKEN
})
eventStore.start()

function actorIdFor(req) {
  return createHmac('sha256', analyticsSecret).update(req.installation.sub).digest('hex')
}

async function appendInternalEvent(req, eventName, properties, eventId = randomUUID()) {
  try {
    await eventStore.append([{
      event_id: eventId,
      event_name: eventName,
      actor_id: actorIdFor(req),
      occurred_at: new Date().toISOString(),
      received_at: new Date().toISOString(),
      session_id: null,
      schema_version: 1,
      properties
    }])
  } catch (error) {
    // Product requests must keep working if the analytics volume is degraded.
    console.error('[analytics] internal event was not persisted:', error?.message || error)
  }
}
const registrationLimit = createFixedWindowLimiter({
  windowMs: 60 * 60 * 1000,
  limit: REGISTRATION_LIMIT,
  key: (req) => req.ip
})
const apiLimit = createFixedWindowLimiter({
  windowMs: 60 * 1000,
  limit: API_LIMIT,
  key: (req) => req.installation?.sub || req.ip
})
const installationKey = (req) => req.installation?.sub || req.ip
const eventLimit = createFixedWindowLimiter({ windowMs: 60 * 1000, limit: EVENT_LIMIT, key: installationKey })
const aiLimit = createFixedWindowLimiter({
  windowMs: 60 * 1000,
  limit: AI_LIMIT,
  key: installationKey
})
const aiDailyLimit = createFixedWindowLimiter({ windowMs: 24 * 60 * 60 * 1000, limit: AI_DAILY_LIMIT, key: installationKey })
const imageLimit = createFixedWindowLimiter({
  windowMs: 60 * 60 * 1000,
  limit: IMAGE_LIMIT,
  key: installationKey
})
const videoLimit = createFixedWindowLimiter({
  windowMs: 60 * 60 * 1000,
  limit: VIDEO_LIMIT,
  key: installationKey
})
const videoDailyLimit = createFixedWindowLimiter({ windowMs: 24 * 60 * 60 * 1000, limit: VIDEO_DAILY_LIMIT, key: installationKey })
const speechLimit = createFixedWindowLimiter({
  windowMs: 60 * 1000,
  limit: SPEECH_LIMIT,
  key: installationKey
})
const speechDailyLimit = createFixedWindowLimiter({ windowMs: 24 * 60 * 60 * 1000, limit: SPEECH_DAILY_LIMIT, key: installationKey })
const imageDailyLimit = createFixedWindowLimiter({ windowMs: 24 * 60 * 60 * 1000, limit: IMAGE_DAILY_LIMIT, key: installationKey })
const importLimit = createFixedWindowLimiter({ windowMs: 60 * 1000, limit: IMPORT_LIMIT, key: installationKey })
const importDailyLimit = createFixedWindowLimiter({ windowMs: 24 * 60 * 60 * 1000, limit: IMPORT_DAILY_LIMIT, key: installationKey })
const importByteBudget = createFixedWindowByteBudget({
  windowMs: 24 * 60 * 60 * 1000,
  maxBytes: IMPORT_DAILY_BYTES_MB * 1024 * 1024,
  reserveBytes: 30 * 1024 * 1024,
  key: installationKey
})

app.get('/health', (_req, res) => {
  const llm = llmRouteReadiness()
  res.json({
    ok: true,
    services: {
      gigachat: llm.ready,
      salutespeech: !!SALUTE_KEY,
      kandinsky: !!KANDINSKY_TOKEN,
      video: !!KANDINSKY_TOKEN && !!VIDEO_BASE_URL
    },
    llm_routes: llm.purposes,
    analytics_delivery: eventStore.status(),
    concurrency: { llm: llmGate.status(), speech: speechGate.status(), image: imageGate.status(), import: importGate.status() }
  })
})

app.get('/ready', (_req, res) => {
  const llm = llmRouteReadiness()
  const ready = llm.ready && !!SALUTE_KEY && !!KANDINSKY_TOKEN && !!VIDEO_BASE_URL
  res.status(ready ? 200 : 503).json({ ok: ready, llm_routes: llm.purposes })
})

app.post('/v2/installations/register', registrationLimit, express.json({ limit: '16kb' }), (req, res) => {
  const body = req.body || {}
  const keys = Object.keys(body)
  if (keys.some((key) => !['installation_id', 'app_version', 'platform', 'arch', 'activation_token'].includes(key))) {
    return res.status(400).json({ error: 'Неизвестное поле регистрации', code: 'VALIDATION' })
  }
  if (REGISTRATION_ACTIVATION_SECRET) {
    if (typeof body.activation_token !== 'string' || body.activation_token.length > 200) {
      return res.status(403).json({ error: 'Активация Narra не подтверждена', code: 'AUTH' })
    }
    const expected = Buffer.from(REGISTRATION_ACTIVATION_SECRET)
    const actual = Buffer.from(String(body.activation_token || ''))
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return res.status(403).json({ error: 'Активация Narra не подтверждена', code: 'AUTH' })
    }
  }
  if (!isInstallationId(body.installation_id)) {
    return res.status(400).json({ error: 'Некорректный installation_id', code: 'VALIDATION' })
  }
  for (const key of ['app_version', 'platform', 'arch']) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 80)) {
      return res.status(400).json({ error: `Некорректное поле ${key}`, code: 'VALIDATION' })
    }
  }
  res.status(201).json({ token: tokenService.issue(body.installation_id), token_type: 'Bearer' })
})

// Public generic update feed. Integrity comes from electron-builder SHA-512
// metadata plus the required Developer ID signature of the macOS app. Keeping
// it before /v2 auth is required because electron-updater does not hold an
// installation bearer token.
app.use('/v2/updates/files', express.static(new URL('./updates', import.meta.url).pathname, {
  setHeaders(res, filePath) {
    res.setHeader('Cache-Control', filePath.endsWith('.yml') ? 'no-store' : 'public, max-age=31536000, immutable')
  }
}))
app.use('/v2/updates/files', (_req, res) => res.status(404).json({ error: 'Update artifact not found' }))

app.use('/v2', requireGatewayAuth(tokenService), apiLimit)
// Parsers deliberately live after bearer auth/rate limiting. Large unauthenticated
// bodies are rejected before Express buffers or parses them. Endpoint quotas
// are attached directly before each parser so Express path normalization cannot
// bypass them with case or trailing-slash variants.

app.post('/v2/events/batch', eventLimit, express.json({ limit: '1mb' }), async (req, res) => {
  try {
    if (
      !req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => key !== 'events') ||
      !Array.isArray(req.body.events) || req.body.events.length < 1 || req.body.events.length > 100
    ) {
      return res.status(400).json({ error: 'events: нужен массив из 1–100 событий', code: 'VALIDATION' })
    }
    const events = []
    const rejected = []
    for (const candidate of req.body.events) {
      try {
        events.push(parseEventBatch({ events: [candidate] })[0])
      } catch {
        rejected.push({
          event_id: typeof candidate?.eventId === 'string' ? candidate.eventId.slice(0, 36) : ''
        })
      }
    }
    const actorId = actorIdFor(req)
    const receivedAt = new Date().toISOString()
    if (events.length) {
      await eventStore.append(events.map((event) => ({
        ...event,
        actor_id: actorId,
        received_at: receivedAt
      })))
    }
    res.status(202).json({ accepted: events.length, rejected })
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'UNKNOWN' })
  }
})

// --- Чат: стриминг через LiteLLM-шлюз (OpenAI /v1/chat/completions) ---
app.post('/v2/ai/chat/stream', aiLimit, aiDailyLimit, express.json({ limit: '1mb' }), async (req, res) => {
  const startedAt = Date.now()
  const clientSignal = requestAbortSignal(req, res)
  let requestId
  let release
  try {
    release = await llmGate.acquire(clientSignal)
    const input = parseChatBody(req.body, { stream: true })
    requestId = input.requestId || randomUUID()
    await appendInternalEvent(req, 'ai_request_started', { request_id: requestId, purpose: input.purpose })
    const { response: upstream, provider, model } = await requestChat({
      ...input,
      requestId,
      stream: true,
      onAttempt: (attempt) => appendInternalEvent(
        req,
        `provider_attempt_${attempt.status}`,
        providerAttemptProperties(requestId, input.purpose, attempt),
        attempt.attempt_id
      ),
      signal: clientSignal
    })
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Request-Id', requestId)
    res.setHeader('X-Narra-Route', analyticsRoute(provider, model))
    let streamedBytes = 0
    for await (const chunk of upstream.body) {
      streamedBytes += Buffer.byteLength(chunk)
      if (streamedBytes > LLM_RESPONSE_MAX_BYTES) {
        await upstream.body.cancel().catch(() => {})
        throw Object.assign(new Error('LLM response exceeded the gateway limit'), { code: 'NETWORK', status: 502 })
      }
      res.write(chunk)
    }
    res.end()
    await appendInternalEvent(req, 'ai_request_completed', {
      request_id: requestId,
      purpose: input.purpose,
      route: analyticsRoute(provider, model),
      latency_ms: Date.now() - startedAt,
      success: true
    })
  } catch (e) {
    if (requestId) await appendInternalEvent(req, 'ai_request_failed', {
      request_id: requestId,
      latency_ms: Date.now() - startedAt,
      error_code: e.code || 'NETWORK',
      success: false
    }).catch(() => {})
    if (!res.headersSent) res.status(e.status || 502).json({ error: String(e.message), code: e.code || 'NETWORK', request_id: e.requestId })
    else res.end()
  } finally {
    release?.()
  }
})

// --- Чат: обычный ответ (для разметки/саммари/эмоций) ---
app.post('/v2/ai/chat/complete', aiLimit, aiDailyLimit, express.json({ limit: '1mb' }), async (req, res) => {
  const startedAt = Date.now()
  const clientSignal = requestAbortSignal(req, res)
  let requestId
  let release
  try {
    release = await llmGate.acquire(clientSignal)
    const input = parseChatBody(req.body)
    requestId = input.requestId || randomUUID()
    await appendInternalEvent(req, 'ai_request_started', { request_id: requestId, purpose: input.purpose })
    const { response: r, provider, model, attempts } = await requestChat({
      ...input,
      requestId,
      stream: false,
      onAttempt: (attempt) => appendInternalEvent(
        req,
        `provider_attempt_${attempt.status}`,
        providerAttemptProperties(requestId, input.purpose, attempt),
        attempt.attempt_id
      ),
      signal: clientSignal
    })
    const responseBytes = await readBoundedBody(r, LLM_RESPONSE_MAX_BYTES, clientSignal)
    const j = JSON.parse(responseBytes.toString('utf8'))
    await appendInternalEvent(req, 'ai_request_completed', completionProperties({
      requestId,
      purpose: input.purpose,
      provider,
      model,
      latencyMs: Date.now() - startedAt,
      usage: j?.usage
    }))
    res.json({
      text: j?.choices?.[0]?.message?.content ?? '',
      request_id: requestId,
      route: analyticsRoute(provider, model),
      usage: j?.usage || null,
      attempts: attempts.length
    })
  } catch (e) {
    if (requestId) await appendInternalEvent(req, 'ai_request_failed', {
      request_id: requestId,
      latency_ms: Date.now() - startedAt,
      error_code: e.code || 'NETWORK',
      success: false
    }).catch(() => {})
    res.status(e.status || 502).json({ error: String(e.message), code: e.code || 'NETWORK', request_id: e.requestId })
  } finally {
    release?.()
  }
})

// --- SaluteSpeech: синтез сегмента ---
app.post('/v2/speech/synthesize', speechLimit, speechDailyLimit, express.json({ limit: '1mb' }), async (req, res) => {
  const clientSignal = requestAbortSignal(req, res)
  let release
  try {
    release = await speechGate.acquire(clientSignal)
    const { text, ssml, voice } = parseSynthesisBody(req.body)
    const isSsml = !!ssml
    const payload = isSsml ? ssml : text || ''
    const token = await getToken('SALUTE_SPEECH_PERS', SALUTE_KEY, SALUTE_OAUTH_URL)
    const url = `${SALUTE_SYNTH_URL}?format=wav16&voice=${encodeURIComponent(voice)}_24000`
    const r = await httpsRequest(url, {
      method: 'POST',
      insecure: INSECURE,
      timeoutMs: 60000,
      signal: clientSignal,
      binary: true,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': isSsml ? 'application/ssml' : 'application/text'
      },
      body: Buffer.from(payload, 'utf8')
    })
    if (r.status === 401) {
      delete tokenCache['SALUTE_SPEECH_PERS']
      return res.status(401).json({ error: 'SaluteSpeech: токен отклонён', code: 'AUTH' })
    }
    if (r.status === 429) return res.status(429).json({ error: 'SaluteSpeech: лимит', code: 'RATE' })
    if (r.status !== 200) {
      return res.status(502).json({ error: `SaluteSpeech ${r.status}: ${r.body?.toString('utf8').slice(0, 160)}`, code: 'NETWORK' })
    }
    res.setHeader('Content-Type', 'audio/wav')
    res.send(r.body)
  } catch (e) {
    res.status(statusFor(e.code)).json({ error: e.message, code: e.code || 'UNKNOWN' })
  } finally {
    release?.()
  }
})

// gigachat-image через шлюз — мгновенно, тем же ключом, без рейт-лимита Кандинского.
async function gigachatImage(prompt, signal) {
  const r = await fetch(`${LLM_BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gigachat-image', prompt: String(prompt).slice(0, 1000) }),
    signal: withTimeout(signal, 90_000)
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw httpErr(r.status === 401 ? 'AUTH' : r.status === 429 ? 'RATE' : 'NETWORK', `gigachat-image ${r.status}: ${t.slice(0, 140)}`)
  }
  const j = await r.json()
  const b64 = j?.data?.[0]?.b64_json
  if (!b64) throw httpErr('UNKNOWN', 'gigachat-image: пустой результат')
  return b64
}

// --- SaluteSpeech: распознавание речи (ASR) ---
app.post(
  '/v2/speech/recognize',
  speechLimit,
  speechDailyLimit,
  express.raw({ type: () => true, limit: '25mb' }),
  async (req, res) => {
    if (!SALUTE_KEY) return res.status(400).json({ error: 'ASR: ключ не задан', code: 'NO_KEY' })
    const clientSignal = requestAbortSignal(req, res)
    let release
    try {
      release = await speechGate.acquire(clientSignal)
      const token = await getToken('SALUTE_SPEECH_PERS', SALUTE_KEY, SALUTE_OAUTH_URL)
      const ct = String(req.headers['x-audio-type'] || 'audio/x-pcm;bit=16;rate=16000')
      const url =
        SALUTE_RECOGNIZE_URL +
        (SALUTE_RECOGNITION_MODEL ? `?model=${encodeURIComponent(SALUTE_RECOGNITION_MODEL)}` : '')
      const r = await httpsRequest(url, {
        method: 'POST',
        insecure: INSECURE,
        timeoutMs: 60000,
        signal: clientSignal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': ct },
        body: req.body
      })
      if (r.status === 401) {
        delete tokenCache['SALUTE_SPEECH_PERS']
        return res.status(401).json({ error: 'ASR: токен отклонён', code: 'AUTH' })
      }
      if (r.status !== 200) {
        return res
          .status(502)
          .json({ error: `ASR ${r.status}: ${String(r.body).slice(0, 160)}`, code: 'NETWORK' })
      }
      const j = JSON.parse(r.body)
      const text = Array.isArray(j.result) ? j.result.join(' ') : j.result || j.text || ''
      res.json({ text })
    } catch (e) {
      res.status(statusFor(e.code)).json({ error: e.message, code: e.code || 'UNKNOWN' })
    } finally {
      release?.()
    }
  }
)

// --- Генерация изображения: gigachat-image (осн.), Kandinsky (фолбэк) ---
// Загрузка книг по ссылке (AO3 заблокирован в РФ — качаем сервером).
// Строгий белый список хостов, только https, лимит 30 МБ.
const IMPORT_HOSTS = new Set(['archiveofourown.org', 'download.archiveofourown.org', 'ficbook.net', 'www.ficbook.net'])
app.get('/v2/import/fetch', importLimit, importDailyLimit, importByteBudget, async (req, res) => {
  const clientSignal = requestAbortSignal(req, res)
  let release
  try {
    release = await importGate.acquire(clientSignal)
    const u = new URL(String(req.query.url || ''))
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/epub+zip,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Referer: `${u.protocol}//${u.hostname}/`
    }
    // сайты фанфиков режут частые запросы (403/429) — ждём и пробуем ещё
    let r = null
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetchWithRedirectPolicy(u, { allowedHosts: IMPORT_HOSTS, headers, signal: clientSignal })
      if (r.ok || (r.status !== 403 && r.status !== 429 && r.status < 500)) break
      await r.body?.cancel().catch(() => {})
      if (attempt < 2) await abortableDelay(4000 * (attempt + 1), clientSignal)
    }
    if (!r.ok) {
      const limited = r.status === 403 || r.status === 429
      await r.body?.cancel().catch(() => {})
      return res.status(502).json({
        error: limited
          ? 'Сайт временно ограничил загрузку (антифлуд). Подожди пару минут и попробуй снова.'
          : `Источник ответил ${r.status}`,
        code: limited ? 'RATE' : 'NETWORK'
      })
    }
    const buf = await readBoundedBody(r, 30 * 1024 * 1024, clientSignal)
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream')
    res.send(buf)
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e.message), code: e.code || 'NETWORK' })
  } finally {
    release?.()
  }
})

app.post('/v2/media/images', imageLimit, imageDailyLimit, express.json({ limit: '1mb' }), async (req, res) => {
  const signal = requestAbortSignal(req, res)
  let release
  try {
    release = await imageGate.acquire(signal)
    const { prompt, width, height, engine } = parseImageBody(req.body)
    // Вертикальные изображения (обложки) и явный engine='kandinsky' (сцены) — Kandinsky:
    // он соблюдает состав кадра, одежду и размер. Портреты — gigachat-image: быстро.
    // Взаимные фолбэки.
    const wantKandinsky = height > width || engine === 'kandinsky'
    if (wantKandinsky && KANDINSKY_TOKEN) {
      try {
        return res.json({ image: await kandinskyQueued(prompt, width, height, signal) })
      } catch (e) {
        // сцены (engine=kandinsky) на gigachat-image не фолбэчим: он игнорирует
        // стиль и выдаёт фотореалистичные кинокадры — лучше честная ошибка и повтор
        if (engine === 'kandinsky') throw e
        console.error('[image] Kandinsky не удалось, фолбэк на gigachat-image:', e.message)
        if (!LLM_API_KEY) throw e
      }
    }
    if (LLM_API_KEY) {
      try {
        return res.json({ image: await gigachatImage(prompt, signal) })
      } catch (e) {
        console.error('[image] gigachat-image не удалось, фолбэк на Kandinsky:', e.message)
        if (!KANDINSKY_TOKEN) throw e
      }
    }
    if (!KANDINSKY_TOKEN) return res.status(400).json({ error: 'Нет ключей для картинок', code: 'NO_KEY' })
    res.json({ image: await kandinskyQueued(prompt, width, height, signal) })
  } catch (e) {
    res.status(statusFor(e.code)).json({ error: e.message, code: e.code || 'UNKNOWN' })
  } finally {
    release?.()
  }
})

// --- GigaAvatar: портрет + аудио → говорящее видео ---
app.post('/v2/media/avatar', videoLimit, videoDailyLimit, express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const { image, audio, query } = parseAvatarBody(req.body)
    if (!KANDINSKY_TOKEN) return res.status(400).json({ error: 'Видео: токен не задан на сервере', code: 'NO_KEY' })
    const signal = requestAbortSignal(req, res)
    longJob(res, async () => ({ video: await gigaAvatar(image, audio, query, signal) }))
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'UNKNOWN' })
  }
})

// --- Idle-анимация портрета (image → короткое видео, без звука) ---
app.post('/v2/media/portrait-animation', videoLimit, videoDailyLimit, express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const { image, query, quality } = parsePortraitBody(req.body)
    if (!KANDINSKY_TOKEN) return res.status(400).json({ error: 'Видео: токен не задан на сервере', code: 'NO_KEY' })
    const signal = requestAbortSignal(req, res)
    longJob(res, async () => ({ video: await animatePortrait(image, query, quality, signal) }))
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'UNKNOWN' })
  }
})

app.use(validationErrors)
app.use((error, _req, res, _next) => {
  if (error?.message === 'Origin is not allowed') {
    return res.status(403).json({ error: 'Origin is not allowed', code: 'AUTH' })
  }
  console.error('[gateway]', error)
  res.status(500).json({ error: 'Внутренняя ошибка gateway', code: 'UNKNOWN' })
})

const httpServer = app.listen(PORT, () => {
  console.log(`[narra-proxy] слушает :${PORT}`)
  console.log(`  чат(LLM): ${LLM_API_KEY ? 'ok' : '—'}  salutespeech: ${SALUTE_KEY ? 'ok' : '—'}  kandinsky: ${KANDINSKY_TOKEN ? 'ok' : '—'}`)
  console.log(`  шлюз: ${LLM_BASE_URL}  модель: ${LLM_MODEL}`)
})

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[narra-proxy] ${signal}: draining HTTP and analytics outbox`)
  const force = setTimeout(() => process.exit(1), 25_000)
  force.unref?.()
  httpServer.close(async (error) => {
    try {
      await eventStore.stop()
      if (error) throw error
      clearTimeout(force)
      process.exit(0)
    } catch (shutdownError) {
      console.error('[narra-proxy] graceful shutdown failed', shutdownError)
      process.exit(1)
    }
  })
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
