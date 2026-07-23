import { randomUUID } from 'node:crypto'

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])

function providerConfig(name, purpose, env) {
  if (name === 'openrouter') {
    return {
      name,
      baseUrl: String(env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
      apiKey: String(env.OPENROUTER_API_KEY || '').trim(),
      model: String(
        env[`OPENROUTER_MODEL_${purpose.toUpperCase()}`] || env.OPENROUTER_MODEL || ''
      ).trim(),
      headers: {
        ...(env.OPENROUTER_HTTP_REFERER ? { 'HTTP-Referer': env.OPENROUTER_HTTP_REFERER } : {}),
        ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {})
      }
    }
  }
  return {
    name: 'giga',
    baseUrl: (() => {
      const value = String(env.LLM_BASE_URL || '').replace(/\/+$/, '')
      if (!value) return ''
      return value.endsWith('/v1') ? value : `${value}/v1`
    })(),
    apiKey: String(env.LLM_API_KEY || '').trim(),
    model: String(env[`LLM_MODEL_${purpose.toUpperCase()}`] || env.LLM_MODEL || 'gigachat-3-ultra').trim(),
    headers: {}
  }
}

export function routeForPurpose(purpose, env = process.env) {
  const suffix = purpose.toUpperCase()
  const primary = String(env[`LLM_ROUTE_${suffix}`] || env.LLM_ROUTE_DEFAULT || 'giga').toLowerCase()
  const fallback = String(env[`LLM_FALLBACK_${suffix}`] || env.LLM_FALLBACK_DEFAULT || '').toLowerCase()
  if (!['giga', 'openrouter'].includes(primary)) throw new Error(`Unsupported provider route: ${primary}`)
  if (fallback && !['giga', 'openrouter'].includes(fallback)) throw new Error(`Unsupported fallback route: ${fallback}`)
  return [primary, fallback].filter((value, index, all) => value && all.indexOf(value) === index)
}

export async function requestChat({
  messages,
  temperature,
  purpose,
  stream,
  requestId,
  env = process.env,
  fetchImpl = fetch,
  onAttempt = async () => {}
}) {
  const id = requestId || randomUUID()
  const attempts = []
  let last
  for (const providerName of routeForPurpose(purpose, env)) {
    const config = providerConfig(providerName, purpose, env)
    const attemptId = randomUUID()
    const started = Date.now()
    if (!config.apiKey || !config.baseUrl || !config.model) {
      last = { status: 503, error: `${providerName}: provider is not configured`, code: 'NO_KEY' }
      attempts.push({ attempt_id: attemptId, provider: providerName, model: config.model, status: 'not_configured' })
      await onAttempt(attempts.at(-1))
      continue
    }
    try {
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          ...config.headers
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature,
          max_tokens: stream ? 1024 : 6000,
          stream
        }),
        signal: AbortSignal.timeout(stream ? 180_000 : 120_000)
      })
      const attempt = {
        attempt_id: attemptId,
        provider: providerName,
        model: config.model,
        status: response.ok ? 'completed' : 'failed',
        http_status: response.status,
        latency_ms: Date.now() - started
      }
      attempts.push(attempt)
      console.info(JSON.stringify({ type: 'provider_attempt', request_id: id, purpose, ...attempt }))
      await onAttempt(attempt)
      if (response.ok && response.body) return { response, requestId: id, attempts, provider: providerName, model: config.model }
      const detail = (await response.text().catch(() => '')).slice(0, 180)
      last = {
        status: response.status === 401 || response.status === 403 ? 502 : response.status,
        error: `${providerName} ${response.status}: ${detail}`,
        code: response.status === 429 ? 'RATE' : response.status === 401 || response.status === 403 ? 'AUTH' : 'NETWORK'
      }
      if (!RETRYABLE.has(response.status)) break
    } catch (error) {
      const attempt = {
        attempt_id: attemptId,
        provider: providerName,
        model: config.model,
        status: 'failed',
        error_code: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
        latency_ms: Date.now() - started
      }
      attempts.push(attempt)
      console.info(JSON.stringify({ type: 'provider_attempt', request_id: id, purpose, ...attempt }))
      await onAttempt(attempt)
      last = { status: error?.name === 'TimeoutError' ? 504 : 502, error: String(error?.message || error), code: attempt.error_code }
    }
  }
  const error = new Error(last?.error || 'No LLM route is configured')
  error.status = last?.status || 503
  error.code = last?.code || 'NO_KEY'
  error.requestId = id
  error.attempts = attempts
  throw error
}
