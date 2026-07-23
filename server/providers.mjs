import { randomUUID } from 'node:crypto'
import { withTimeout } from './concurrency.mjs'

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])
const PURPOSES = ['character_chat', 'structured_task', 'summary', 'scenario', 'memory']
const MODERATION_RESPONSE = /content.?filter|moderation|safety|unsafe|censor|blocked|bad_[a-z_]*lemmas|запрещ|цензур|безопасност/i

function httpErrorCode(status, detail) {
  if (MODERATION_RESPONSE.test(String(detail || ''))) return 'CENSOR'
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 408) return 'TIMEOUT'
  if (status === 429) return 'RATE'
  if (status >= 400 && status < 500 && ![404, 409].includes(status)) return 'VALIDATION'
  return 'NETWORK'
}

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

export function llmRouteReadiness(env = process.env) {
  const purposes = {}
  let ready = true
  for (const purpose of PURPOSES) {
    try {
      const route = routeForPurpose(purpose, env)
      const configured = route.filter((provider) => {
        const config = providerConfig(provider, purpose, env)
        return Boolean(config.apiKey && config.baseUrl && config.model)
      })
      purposes[purpose] = { route, configured, ready: configured.length > 0 }
      if (!configured.length) ready = false
    } catch (error) {
      purposes[purpose] = { route: [], configured: [], ready: false, error: String(error?.message || error) }
      ready = false
    }
  }
  return { ready, purposes }
}

export async function requestChat({
  messages,
  temperature,
  purpose,
  stream,
  requestId,
  env = process.env,
  fetchImpl = fetch,
  onAttempt = async () => {},
  signal
}) {
  const id = requestId || randomUUID()
  const attempts = []
  let last
  const route = routeForPurpose(purpose, env)
  for (const [retryIndex, providerName] of route.entries()) {
    const config = providerConfig(providerName, purpose, env)
    const attemptId = randomUUID()
    const started = Date.now()
    if (!config.apiKey || !config.baseUrl || !config.model) {
      last = { status: 503, error: `${providerName}: provider is not configured`, code: 'NO_KEY' }
      attempts.push({
        attempt_id: attemptId,
        event_id: randomUUID(),
        provider: providerName,
        model: config.model,
        status: 'not_configured',
        retry_index: retryIndex
      })
      await onAttempt(attempts.at(-1))
      continue
    }
    const startedAttempt = {
      attempt_id: attemptId,
      event_id: randomUUID(),
      provider: providerName,
      model: config.model,
      status: 'started',
      retry_index: retryIndex
    }
    await onAttempt(startedAttempt)
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
          stream,
          ...(stream && providerName === 'giga'
            ? { stream_options: { include_usage: true } }
            : {}),
          ...(providerName === 'openrouter'
            ? { provider: { zdr: true, data_collection: 'deny' } }
            : {})
        }),
        signal: withTimeout(signal, stream ? 180_000 : 120_000)
      })
      const terminalAttempt = {
        attempt_id: attemptId,
        provider: providerName,
        model: config.model,
        status: 'failed',
        http_status: response.status,
        latency_ms: Date.now() - started,
        retry_index: retryIndex
      }
      if (response.ok && response.body) {
        let finalized = false
        const finalizeAttempt = async ({ status = 'completed', error_code: errorCode } = {}) => {
          if (finalized) return
          finalized = true
          const attempt = {
            ...terminalAttempt,
            event_id: randomUUID(),
            status,
            ...(status === 'failed'
              ? { error_code: errorCode || 'NETWORK' }
              : { error_code: undefined }),
            latency_ms: Date.now() - started
          }
          attempts.push(attempt)
          console.info(JSON.stringify({ type: 'provider_attempt', request_id: id, purpose, ...attempt }))
          await onAttempt(attempt)
        }
        const responseCost = (() => {
          if (providerName !== 'giga') return undefined
          const value = Number(response.headers.get('x-litellm-response-cost'))
          return Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : undefined
        })()
        return {
          response,
          requestId: id,
          attempts,
          provider: providerName,
          model: config.model,
          responseCost,
          finalizeAttempt
        }
      }
      const detail = (await response.text().catch(() => '')).slice(0, 180)
      const errorCode = httpErrorCode(response.status, detail)
      const failedAttempt = {
        ...terminalAttempt,
        event_id: randomUUID(),
        error_code: errorCode
      }
      attempts.push(failedAttempt)
      console.info(JSON.stringify({ type: 'provider_attempt', request_id: id, purpose, ...failedAttempt }))
      await onAttempt(failedAttempt)
      last = {
        status: response.status === 401 || response.status === 403 ? 502 : response.status,
        error: errorCode === 'CENSOR'
          ? `${providerName}: response blocked by content safety`
          : `${providerName} ${response.status}: ${detail}`,
        code: errorCode
      }
      // Authentication and model availability failures belong to this provider;
      // a configured fallback may still be healthy. Other non-retryable 4xx
      // usually mean the shared request itself is invalid and must stop.
      if (!RETRYABLE.has(response.status) && ![401, 403, 404].includes(response.status)) break
    } catch (error) {
      const attempt = {
        attempt_id: attemptId,
        event_id: randomUUID(),
        provider: providerName,
        model: config.model,
        status: 'failed',
        error_code: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
        latency_ms: Date.now() - started,
        retry_index: retryIndex
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
