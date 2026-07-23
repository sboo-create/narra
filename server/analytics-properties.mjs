const IDENTIFIER = /^[A-Za-z0-9_./:+-]{1,80}$/
const ERROR_CODES = new Set([
  'UNKNOWN', 'VALIDATION', 'NETWORK', 'AUTH', 'TIMEOUT', 'RATE',
  'NO_KEY', 'NO_PROXY', 'PARSE', 'CENSOR', 'CANCELLED'
])

function identifier(value, fallback = 'unreported') {
  const candidate = String(value || '')
  return IDENTIFIER.test(candidate) ? candidate : fallback
}

function boundedNumber(value, { integer = false, max = 1_000_000_000 } = {}) {
  if (value === null || value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > max || (integer && !Number.isInteger(number))) {
    return undefined
  }
  return number
}

export function analyticsRoute(provider, model) {
  return identifier(`${identifier(provider)}:${identifier(model)}`)
}

export function providerAttemptProperties(requestId, purpose, attempt) {
  const properties = {
    request_id: requestId,
    purpose,
    provider: identifier(attempt.provider),
    model: identifier(attempt.model),
    retry_index: boundedNumber(attempt.retry_index, { integer: true, max: 100 })
  }
  const latency = boundedNumber(attempt.latency_ms, { integer: true })
  const status = boundedNumber(attempt.http_status, { integer: true, max: 599 })
  if (latency !== undefined) properties.latency_ms = latency
  if (status !== undefined) properties.http_status = status
  const fallbackError = attempt.status === 'not_configured' ? 'NO_KEY' : undefined
  const errorCode = ERROR_CODES.has(attempt.error_code) ? attempt.error_code : fallbackError
  if (errorCode) properties.error_code = errorCode
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined))
}

export function completionProperties({ requestId, purpose, provider, model, latencyMs, usage }) {
  const properties = {
    request_id: requestId,
    purpose,
    route: analyticsRoute(provider, model),
    latency_ms: boundedNumber(latencyMs, { integer: true }),
    success: true
  }
  const numeric = {
    input_tokens: boundedNumber(usage?.prompt_tokens, { integer: true }),
    output_tokens: boundedNumber(usage?.completion_tokens, { integer: true }),
    total_tokens: boundedNumber(usage?.total_tokens, { integer: true }),
    exact_cost: boundedNumber(usage?.cost)
  }
  return Object.fromEntries(Object.entries({ ...properties, ...numeric }).filter(([, value]) => value !== undefined))
}
