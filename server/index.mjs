import express from 'express'
import { readFileSync } from 'node:fs'
import cors from 'cors'
import { createHmac, randomUUID } from 'crypto'
import { httpsRequest } from './http.mjs'
import {
  parseAvatarBody,
  parseChatBody,
  parseImageBody,
  parsePortraitBody,
  parseSynthesisBody,
  validationErrors
} from './contracts.mjs'
import { requestChat } from './providers.mjs'
import { parseEventBatch } from './events.mjs'
import { createEventStore } from './event-store.mjs'
import { fetchWithRedirectPolicy, readBoundedBody } from './safe-fetch.mjs'
import {
  createFixedWindowLimiter,
  createTokenService,
  isInstallationId,
  requireGatewayAuth,
  resolveTokenSecret
} from './security.mjs'

// ================= Конфигурация =================
const PORT = process.env.PORT || 8787
const INSECURE = process.env.ALLOW_INSECURE_TLS === 'true'
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
const LLM_BASE_URL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '')
const LLM_API_KEY = (process.env.LLM_API_KEY || '').trim() // виртуальный ключ LiteLLM (sk-...)
const LLM_MODEL = (process.env.LLM_MODEL || 'gigachat-3-ultra').trim()

// Kandinsky 6.0 (studio.kandinskylab.ai) — один Bearer-токен
const KANDINSKY_TOKEN = (process.env.KANDINSKY_TOKEN || '').trim()
// SaluteSpeech — URL настраиваются через .env (у команды могут быть свои).
const SALUTE_OAUTH_URL = (process.env.SBER_SALUTE_OAUTH_URL || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth').trim()
const SALUTE_SYNTH_URL = (process.env.SBER_SALUTE_SYNTH_URL || 'https://smartspeech.sber.ru/rest/v1/text:synthesize').trim()
const SALUTE_RECOGNIZE_URL = (process.env.SBER_SALUTE_RECOGNIZE_URL || 'https://smartspeech.sber.ru/rest/v1/speech:recognize').trim()
const SALUTE_RECOGNITION_MODEL = (process.env.SBER_SALUTE_RECOGNITION_MODEL || 'voice_messaging').trim()
const KANDINSKY_HOST = 'https://studio.kandinskylab.ai/api'
// Видео/аватар API (GigaAvatar: image + audio → говорящее видео)
const VIDEO_BASE_URL = (process.env.VIDEO_BASE_URL || '').replace(/\/+$/, '')

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
function kandinskyQueued(prompt, width, height) {
  const run = kandinskyChain.then(() => kandinskyWithRetry(prompt, width, height))
  kandinskyChain = run.catch(() => {})
  return run
}
async function kandinskyWithRetry(prompt, width, height, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await kandinskyGenerate(prompt, width, height)
    } catch (e) {
      if (e.code === 'RATE' && i < attempts - 1) {
        console.error(`[kandinsky] лимит, жду 20с (попытка ${i + 2}/${attempts})`)
        await new Promise((r) => setTimeout(r, 20000))
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

async function kandinskyGenerate(prompt, width = 768, height = 1024) {
  const resolution = resolutionFor(width, height)
  // 1) создать задачу
  const runRes = await httpsRequest(`${KANDINSKY_HOST}/tasks/k6-image-t2i`, {
    method: 'POST',
    insecure: INSECURE,
    timeoutMs: 30000,
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
    await new Promise((r) => setTimeout(r, 4000))
    const st = await httpsRequest(`${KANDINSKY_HOST}/tasks/${taskId}`, {
      insecure: INSECURE,
      timeoutMs: 20000,
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
function videoTask(taskType, params) {
  const run = videoChain.then(() => videoTaskRetry(taskType, params))
  videoChain = run.catch(() => {})
  return run
}
async function videoTaskRetry(taskType, params, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await videoTaskRaw(taskType, params)
    } catch (e) {
      const msg = e.message || ''
      const isRate = e.code === 'RATE' || /LIMIT_EXHAUSTED|429/.test(msg)
      if (isRate && i < attempts - 1) {
        // 'concurrent' — заняты все GPU-слоты, освободятся через минуты; 'rate' — секунды
        const wait = /concurrent/.test(msg) ? 45000 : 10000
        console.error(`[video] лимит (${/concurrent/.test(msg) ? 'слоты заняты' : 'частота'}), жду ${wait / 1000}с (${i + 2}/${attempts})`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw e
    }
  }
}

async function videoTaskRaw(taskType, params) {
  if (!VIDEO_BASE_URL) throw httpErr('NO_KEY', 'Видео: VIDEO_BASE_URL не задан')
  const create = await fetch(`${VIDEO_BASE_URL}/tasks/${taskType}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ censor: false, params })
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
    await new Promise((r) => setTimeout(r, 5000))
    const st = await fetch(`${VIDEO_BASE_URL}/tasks/${task_id}`, { headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}` } })
    if (!st.ok) continue
    const j = await st.json()
    const status = String(j.status || '').toLowerCase()
    if (status === 'done') {
      const r = await fetch(`${VIDEO_BASE_URL}/tasks/${task_id}/result`, { headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}` } })
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
async function gigaAvatar(image, audio, query) {
  const params = {
    query: query || 'talking character portrait, front view, natural facial motion, subtle head movement',
    image,
    audio
  }
  try {
    return await videoTask('giga_avatar', params)
  } catch (e) {
    console.error('[avatar] попытка 1 не удалась:', e.message, '— повтор')
    return await videoTask('giga_avatar', params)
  }
}

// idle-анимация портрета (без звука). Бьютификатор отключён — он падает на воркере.
// С ретраем: видео-воркер иногда падает разово.
async function animatePortrait(image, query, quality) {
  const model = quality === 'hd' ? 'k5-i2v-hd' : 'k5-i2v-lite'
  const params = {
    query: query || 'he stays still, only blinks slowly and breathes subtly, locked camera, fixed framing, no zoom',
    image,
    beautificator: 'disabled'
  }
  // lite: быстро (~1.5 мин), движение по характеру героя
  try {
    return await videoTask(model, params)
  } catch (e) {
    if (e.code === 'TIMEOUT') throw e
    console.error('[animate] попытка 1 не удалась:', e.message, '— повтор')
    return await videoTask(model, params)
  }
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
app.use(
  ['/v2/media/avatar', '/v2/media/portrait-animation'],
  express.json({ limit: '25mb' })
)
app.use(express.json({ limit: '1mb' }))

const tokenSecret = resolveTokenSecret()
const tokenService = createTokenService(tokenSecret)
const analyticsSecret = String(process.env.ANALYTICS_HMAC_SECRET || tokenSecret)
const eventStore = createEventStore({
  dataDir: process.env.DATA_DIR || (process.env.NODE_ENV === 'production'
    ? '/data'
    : new URL('./.data', import.meta.url).pathname),
  environment: process.env.ANALYTICS_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development')
})

function actorIdFor(req) {
  return createHmac('sha256', analyticsSecret).update(req.installation.sub).digest('hex')
}

async function appendInternalEvent(req, eventName, properties, eventId = randomUUID()) {
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
}
const registrationLimit = createFixedWindowLimiter({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.REGISTRATION_LIMIT_PER_HOUR || 10),
  key: (req) => req.ip
})
const apiLimit = createFixedWindowLimiter({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_LIMIT_PER_MINUTE || 120),
  key: (req) => req.installation?.sub || req.ip
})

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    services: {
      gigachat: !!(LLM_API_KEY || process.env.OPENROUTER_API_KEY),
      salutespeech: !!SALUTE_KEY,
      kandinsky: !!KANDINSKY_TOKEN,
      video: !!KANDINSKY_TOKEN && !!VIDEO_BASE_URL
    }
  })
})

app.get('/ready', (_req, res) => {
  const ready = !!(LLM_API_KEY || process.env.OPENROUTER_API_KEY) && !!SALUTE_KEY && !!KANDINSKY_TOKEN && !!VIDEO_BASE_URL
  res.status(ready ? 200 : 503).json({ ok: ready })
})

app.post('/v2/installations/register', registrationLimit, (req, res) => {
  const body = req.body || {}
  const keys = Object.keys(body)
  if (keys.some((key) => !['installation_id', 'app_version', 'platform', 'arch'].includes(key))) {
    return res.status(400).json({ error: 'Неизвестное поле регистрации', code: 'VALIDATION' })
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

app.use('/v2', requireGatewayAuth(tokenService), apiLimit)

app.post('/v2/events/batch', async (req, res) => {
  try {
    const events = parseEventBatch(req.body)
    const actorId = actorIdFor(req)
    const receivedAt = new Date().toISOString()
    await eventStore.append(events.map((event) => ({
      ...event,
      actor_id: actorId,
      received_at: receivedAt
    })))
    res.status(202).json({ accepted: events.length })
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'UNKNOWN' })
  }
})

// --- Чат: стриминг через LiteLLM-шлюз (OpenAI /v1/chat/completions) ---
app.post('/v2/ai/chat/stream', async (req, res) => {
  const startedAt = Date.now()
  let requestId
  try {
    const input = parseChatBody(req.body, { stream: true })
    requestId = input.requestId || randomUUID()
    await appendInternalEvent(req, 'ai_request_started', { request_id: requestId, purpose: input.purpose })
    const { response: upstream, provider, model } = await requestChat({
      ...input,
      requestId,
      stream: true,
      onAttempt: (attempt) => appendInternalEvent(req, `provider_attempt_${attempt.status}`, {
        request_id: requestId,
        purpose: input.purpose,
        provider: attempt.provider,
        model: attempt.model,
        latency_ms: attempt.latency_ms || 0,
        http_status: attempt.http_status || null,
        error_code: attempt.error_code || null
      }, attempt.attempt_id)
    })
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Request-Id', requestId)
    res.setHeader('X-Narra-Route', `${provider}:${model}`)
    for await (const chunk of upstream.body) res.write(chunk)
    res.end()
    await appendInternalEvent(req, 'ai_request_completed', {
      request_id: requestId,
      purpose: input.purpose,
      route: `${provider}:${model}`,
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
  }
})

// --- Чат: обычный ответ (для разметки/саммари/эмоций) ---
app.post('/v2/ai/chat/complete', async (req, res) => {
  const startedAt = Date.now()
  let requestId
  try {
    const input = parseChatBody(req.body)
    requestId = input.requestId || randomUUID()
    await appendInternalEvent(req, 'ai_request_started', { request_id: requestId, purpose: input.purpose })
    const { response: r, provider, model, attempts } = await requestChat({
      ...input,
      requestId,
      stream: false,
      onAttempt: (attempt) => appendInternalEvent(req, `provider_attempt_${attempt.status}`, {
        request_id: requestId,
        purpose: input.purpose,
        provider: attempt.provider,
        model: attempt.model,
        latency_ms: attempt.latency_ms || 0,
        http_status: attempt.http_status || null,
        error_code: attempt.error_code || null
      }, attempt.attempt_id)
    })
    const j = await r.json()
    await appendInternalEvent(req, 'ai_request_completed', {
      request_id: requestId,
      purpose: input.purpose,
      route: `${provider}:${model}`,
      latency_ms: Date.now() - startedAt,
      success: true,
      input_tokens: j?.usage?.prompt_tokens ?? null,
      output_tokens: j?.usage?.completion_tokens ?? null,
      total_tokens: j?.usage?.total_tokens ?? null,
      exact_cost: j?.usage?.cost ?? null
    })
    res.json({
      text: j?.choices?.[0]?.message?.content ?? '',
      request_id: requestId,
      route: `${provider}:${model}`,
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
  }
})

// --- SaluteSpeech: синтез сегмента ---
app.post('/v2/speech/synthesize', async (req, res) => {
  try {
    const { text, ssml, voice } = parseSynthesisBody(req.body)
    const isSsml = !!ssml
    const payload = isSsml ? ssml : text || ''
    const token = await getToken('SALUTE_SPEECH_PERS', SALUTE_KEY, SALUTE_OAUTH_URL)
    const url = `${SALUTE_SYNTH_URL}?format=wav16&voice=${encodeURIComponent(voice)}_24000`
    const r = await httpsRequest(url, {
      method: 'POST',
      insecure: INSECURE,
      timeoutMs: 60000,
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
  }
})

// gigachat-image через шлюз — мгновенно, тем же ключом, без рейт-лимита Кандинского.
async function gigachatImage(prompt) {
  const r = await fetch(`${LLM_BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gigachat-image', prompt: String(prompt).slice(0, 1000) })
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
  express.raw({ type: () => true, limit: '25mb' }),
  async (req, res) => {
    if (!SALUTE_KEY) return res.status(400).json({ error: 'ASR: ключ не задан', code: 'NO_KEY' })
    try {
      const token = await getToken('SALUTE_SPEECH_PERS', SALUTE_KEY, SALUTE_OAUTH_URL)
      const ct = String(req.headers['x-audio-type'] || 'audio/x-pcm;bit=16;rate=16000')
      const url =
        SALUTE_RECOGNIZE_URL +
        (SALUTE_RECOGNITION_MODEL ? `?model=${encodeURIComponent(SALUTE_RECOGNITION_MODEL)}` : '')
      const r = await httpsRequest(url, {
        method: 'POST',
        insecure: INSECURE,
        timeoutMs: 60000,
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
    }
  }
)

// --- Генерация изображения: gigachat-image (осн.), Kandinsky (фолбэк) ---
// --- Автообновление: версия и ссылка на свежий dmg (лежит рядом в updates/) ---
app.use('/v2/updates/files', express.static(new URL('./updates', import.meta.url).pathname))
// контент для команды (тексты, которые нельзя класть в публичный репозиторий);
// файлы лежат в updates/ с префиксом tc- — эта папка гарантированно доезжает до Railway
app.get('/v2/content/team/:file', (req, res) => {
  const f = String(req.params.file)
  if (!/^[a-z0-9-]+\.json$/.test(f)) return res.status(400).end()
  res.sendFile(new URL(`./updates/tc-${f}`, import.meta.url).pathname, (err) => {
    if (err) res.status(404).json({ error: 'нет такого файла' })
  })
})
// Загрузка книг по ссылке (AO3 заблокирован в РФ — качаем сервером).
// Строгий белый список хостов, только https, лимит 30 МБ.
const IMPORT_HOSTS = new Set(['archiveofourown.org', 'download.archiveofourown.org', 'ficbook.net', 'www.ficbook.net'])
app.get('/v2/import/fetch', async (req, res) => {
  try {
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
      r = await fetchWithRedirectPolicy(u, { allowedHosts: IMPORT_HOSTS, headers })
      if (r.ok || (r.status !== 403 && r.status !== 429 && r.status < 500)) break
      if (attempt < 2) await new Promise((ok) => setTimeout(ok, 4000 * (attempt + 1)))
    }
    if (!r.ok) {
      const limited = r.status === 403 || r.status === 429
      return res.status(502).json({
        error: limited
          ? 'Сайт временно ограничил загрузку (антифлуд). Подожди пару минут и попробуй снова.'
          : `Источник ответил ${r.status}`,
        code: limited ? 'RATE' : 'NETWORK'
      })
    }
    const buf = await readBoundedBody(r, 30 * 1024 * 1024)
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream')
    res.send(buf)
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e.message), code: e.code || 'NETWORK' })
  }
})

app.get('/v2/updates/latest', (_req, res) => {
  try {
    const j = JSON.parse(readFileSync(new URL('./updates/latest.json', import.meta.url), 'utf-8'))
    res.json(j)
  } catch {
    res.json({ version: '', url: '' })
  }
})

app.post('/v2/media/images', async (req, res) => {
  try {
    const { prompt, width, height, engine } = parseImageBody(req.body)
    // Вертикальные изображения (обложки) и явный engine='kandinsky' (сцены) — Kandinsky:
    // он соблюдает состав кадра, одежду и размер. Портреты — gigachat-image: быстро.
    // Взаимные фолбэки.
    const wantKandinsky = height > width || engine === 'kandinsky'
    if (wantKandinsky && KANDINSKY_TOKEN) {
      try {
        return res.json({ image: await kandinskyQueued(prompt, width, height) })
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
        return res.json({ image: await gigachatImage(prompt) })
      } catch (e) {
        console.error('[image] gigachat-image не удалось, фолбэк на Kandinsky:', e.message)
        if (!KANDINSKY_TOKEN) throw e
      }
    }
    if (!KANDINSKY_TOKEN) return res.status(400).json({ error: 'Нет ключей для картинок', code: 'NO_KEY' })
    res.json({ image: await kandinskyGenerate(prompt, width, height) })
  } catch (e) {
    res.status(statusFor(e.code)).json({ error: e.message, code: e.code || 'UNKNOWN' })
  }
})

// --- GigaAvatar: портрет + аудио → говорящее видео ---
app.post('/v2/media/avatar', async (req, res) => {
  try {
    const { image, audio, query } = parseAvatarBody(req.body)
    if (!KANDINSKY_TOKEN) return res.status(400).json({ error: 'Видео: токен не задан на сервере', code: 'NO_KEY' })
    longJob(res, async () => ({ video: await gigaAvatar(image, audio, query) }))
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'UNKNOWN' })
  }
})

// --- Idle-анимация портрета (image → короткое видео, без звука) ---
app.post('/v2/media/portrait-animation', async (req, res) => {
  try {
    const { image, query, quality } = parsePortraitBody(req.body)
    if (!KANDINSKY_TOKEN) return res.status(400).json({ error: 'Видео: токен не задан на сервере', code: 'NO_KEY' })
    longJob(res, async () => ({ video: await animatePortrait(image, query, quality) }))
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

app.listen(PORT, () => {
  console.log(`[narra-proxy] слушает :${PORT}`)
  console.log(`  чат(LLM): ${LLM_API_KEY ? 'ok' : '—'}  salutespeech: ${SALUTE_KEY ? 'ok' : '—'}  kandinsky: ${KANDINSKY_TOKEN ? 'ok' : '—'}`)
  console.log(`  шлюз: ${LLM_BASE_URL}  модель: ${LLM_MODEL}`)
})
