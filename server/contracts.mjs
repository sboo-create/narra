import { voiceConfig } from './voices.mjs'

const PURPOSES = new Set(['character_chat', 'structured_task', 'summary', 'scenario', 'memory'])
const ROLES = new Set(['system', 'user', 'assistant'])
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fail(message) {
  const error = new Error(message)
  error.status = 400
  error.code = 'VALIDATION'
  throw error
}

function object(value, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name}: нужен объект`)
  return value
}

function onlyKeys(value, allowed, name = 'body') {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${name}.${key}: неизвестное поле`)
  }
}

function string(value, name, { min = 1, max }) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(`${name}: строка длиной ${min}–${max}`)
  }
  return value
}

export function parseChatBody(input, { stream = false } = {}) {
  const body = object(input)
  onlyKeys(body, new Set([
    'messages', 'temperature', 'purpose', 'request_id', 'origin', 'analytics_tier'
  ]))
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 64) {
    fail('messages: нужен массив из 1–64 сообщений')
  }
  let total = 0
  const messages = body.messages.map((candidate, index) => {
    const message = object(candidate, `messages[${index}]`)
    onlyKeys(message, new Set(['role', 'content']), `messages[${index}]`)
    if (!ROLES.has(message.role)) fail(`messages[${index}].role: недопустимая роль`)
    const content = string(message.content, `messages[${index}].content`, { max: 60_000 })
    total += content.length
    return { role: message.role, content }
  })
  if (total > 180_000) fail('messages: суммарный текст больше 180000 символов')
  const temperature = body.temperature === undefined ? (stream ? 0.8 : 0.7) : Number(body.temperature)
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) fail('temperature: число от 0 до 2')
  const defaultPurpose = stream ? 'character_chat' : 'structured_task'
  const purpose = body.purpose === undefined ? defaultPurpose : String(body.purpose)
  if (!PURPOSES.has(purpose)) fail('purpose: неизвестное назначение запроса')
  const requestId = body.request_id === undefined
    ? undefined
    : string(body.request_id, 'request_id', { max: 80 })
  if (requestId !== undefined && !UUID_V4.test(requestId)) fail('request_id: нужен UUID v4')
  const origin = body.origin === undefined ? 'user' : String(body.origin)
  if (!['user', 'background'].includes(origin)) fail('origin: допустимы user или background')
  const defaultTier = origin === 'background' ? 'none' : 'essential'
  const analyticsTier = body.analytics_tier === undefined
    ? defaultTier
    : String(body.analytics_tier)
  if (!['none', 'extended', 'essential'].includes(analyticsTier)) {
    fail('analytics_tier: неизвестный уровень')
  }
  if (origin === 'user' && analyticsTier !== 'essential') {
    fail('analytics_tier: user-запрос должен быть essential')
  }
  if (origin === 'background' && analyticsTier === 'essential') {
    fail('analytics_tier: background-запрос не может быть essential')
  }
  return { messages, temperature, purpose, requestId, origin, analyticsTier }
}

export function parseImageBody(input) {
  const body = object(input)
  onlyKeys(body, new Set(['prompt', 'width', 'height', 'engine']))
  const prompt = string(body.prompt, 'prompt', { max: 4_000 })
  const width = body.width === undefined ? 768 : Number(body.width)
  const height = body.height === undefined ? 1024 : Number(body.height)
  if (!Number.isInteger(width) || width < 256 || width > 2048) fail('width: целое число 256–2048')
  if (!Number.isInteger(height) || height < 256 || height > 2048) fail('height: целое число 256–2048')
  if (body.engine !== undefined && body.engine !== 'kandinsky') fail('engine: неизвестный движок')
  return { prompt, width, height, engine: body.engine }
}

export function parseSynthesisBody(input) {
  const body = object(input)
  onlyKeys(body, new Set(['text', 'ssml', 'voice']))
  if ((body.text === undefined) === (body.ssml === undefined)) fail('нужно ровно одно поле: text или ssml')
  const text = body.text === undefined ? undefined : string(body.text, 'text', { max: 12_000 })
  const ssml = body.ssml === undefined ? undefined : string(body.ssml, 'ssml', { max: 24_000 })
  const voice = body.voice === undefined ? 'Che' : string(body.voice, 'voice', { max: 24 })
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(voice)) fail('voice: недопустимое значение')
  const config = voiceConfig(voice)
  if (!config) fail('voice: голос не поддерживается')
  return {
    text,
    ssml,
    voice,
    providerVoice: config.providerVoice,
    sampleRate: config.sampleRate
  }
}

export function parseAvatarBody(input) {
  const body = object(input)
  onlyKeys(body, new Set(['image', 'audio', 'query']))
  return {
    image: string(body.image, 'image', { max: 18_000_000 }),
    audio: string(body.audio, 'audio', { max: 18_000_000 }),
    query: body.query === undefined ? undefined : string(body.query, 'query', { max: 2_000 })
  }
}

export function parsePortraitBody(input) {
  const body = object(input)
  onlyKeys(body, new Set(['image', 'query', 'quality']))
  const quality = body.quality === undefined ? 'lite' : String(body.quality)
  if (!['lite', 'hd'].includes(quality)) fail('quality: допустимы lite или hd')
  return {
    image: string(body.image, 'image', { max: 18_000_000 }),
    query: body.query === undefined ? undefined : string(body.query, 'query', { max: 2_000 }),
    quality
  }
}

export function validationErrors(error, _req, res, next) {
  if (error?.status === 400 || error?.type === 'entity.too.large') {
    const status = error.type === 'entity.too.large' ? 413 : 400
    return res.status(status).json({ error: error.message, code: 'VALIDATION' })
  }
  next(error)
}
