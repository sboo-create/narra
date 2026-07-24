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

export function completionProperties({
  requestId, purpose, provider, model, latencyMs, usage, responseCost, origin = 'user'
}) {
  const properties = {
    request_id: requestId,
    purpose,
    route: analyticsRoute(provider, model),
    latency_ms: boundedNumber(latencyMs, { integer: true }),
    success: true,
    origin
  }
  const usageCost = boundedNumber(usage?.cost)
  const headerCost = boundedNumber(responseCost)
  const exactCost = usageCost ?? headerCost
  const numeric = {
    input_tokens: boundedNumber(usage?.prompt_tokens, { integer: true }),
    output_tokens: boundedNumber(usage?.completion_tokens, { integer: true }),
    total_tokens: boundedNumber(usage?.total_tokens, { integer: true }),
    exact_cost: exactCost
  }
  const costMetadata = exactCost === undefined
    ? {}
    : {
        cost_currency: 'USD',
        cost_source: usageCost !== undefined
          ? (provider === 'openrouter' ? 'openrouter_usage' : 'litellm_usage')
          : 'litellm_response_header'
      }
  return Object.fromEntries(
    Object.entries({ ...properties, ...numeric, ...costMetadata })
      .filter(([, value]) => value !== undefined)
  )
}

/**
 * Collects only the final usage object from an OpenAI-compatible SSE stream.
 * Content deltas are never retained after their line has been inspected.
 */
export function createSseUsageCollector({ maxBufferedBytes = 512 * 1024 } = {}) {
  const decoder = new TextDecoder()
  let buffered = ''
  let usage
  let sawJsonEvent = false
  let done = false

  const protocolError = (code, message, status = 502) => Object.assign(
    new Error(message),
    { code, status }
  )

  const consume = (flush = false) => {
    const lines = buffered.split(/\r?\n/)
    buffered = flush ? '' : lines.pop() || ''
    for (const line of lines) {
      const normalized = line.trimStart()
      if (!normalized.startsWith('data:')) continue
      const payload = normalized.slice(5).trim()
      if (done) throw protocolError('PARSE', 'LLM stream contained data after [DONE]')
      if (payload === '[DONE]') {
        done = true
        continue
      }
      if (!payload) throw protocolError('PARSE', 'LLM stream contained an empty data event')
      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch {
        throw protocolError('PARSE', 'LLM stream contained malformed JSON')
      }
      sawJsonEvent = true
      if (parsed?.error) {
        const fingerprint = `${parsed.error?.code || ''} ${parsed.error?.type || ''}`.toLowerCase()
        const moderation = /content.?filter|moderation|safety|unsafe|censor|blocked/.test(fingerprint)
        throw protocolError(
          moderation ? 'CENSOR' : 'NETWORK',
          moderation ? 'LLM stream was blocked by content safety' : 'LLM stream returned an upstream error',
          moderation ? 422 : 502
        )
      }
      if (
        Array.isArray(parsed?.choices) &&
        parsed.choices.some((choice) => choice?.finish_reason === 'content_filter')
      ) {
        throw protocolError('CENSOR', 'LLM stream was blocked by content safety', 422)
      }
      if (parsed && typeof parsed.usage === 'object' && !Array.isArray(parsed.usage)) {
        usage = parsed.usage
      }
    }
  }

  return {
    push(chunk) {
      buffered += decoder.decode(chunk, { stream: true })
      if (Buffer.byteLength(buffered) > maxBufferedBytes) {
        throw protocolError('PARSE', 'LLM stream event exceeded the parser limit')
      }
      consume()
    },
    value() {
      buffered += decoder.decode()
      consume(true)
      if (!sawJsonEvent) throw protocolError('PARSE', 'LLM stream did not contain a JSON event')
      if (!done) throw protocolError('PARSE', 'LLM stream ended before [DONE]')
      return usage
    }
  }
}
