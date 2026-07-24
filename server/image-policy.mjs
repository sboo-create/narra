const MODERATION_PATTERN =
  /(?:censor|moderation|safety|unsafe|blocked|bad[_ -]?\w*lemmas|ценз|запрещ|небезопас)/i

function providerError(code, provider, phase, status) {
  const error = new Error(
    `${provider}: ${code === 'CENSOR' ? 'запрос или результат отклонён политикой безопасности' : `ошибка ${phase}${status ? ` (${status})` : ''}`}`
  )
  error.code = code
  return error
}

export function imageUpstreamError({ provider, phase, status = 0, detail = '' }) {
  const text = String(detail || '').slice(0, 4_000)
  if (status === 422 || status === 451 || MODERATION_PATTERN.test(text)) {
    return providerError('CENSOR', provider, phase, status)
  }
  if (status === 401 || status === 403) return providerError('AUTH', provider, phase, status)
  if (status === 408) return providerError('TIMEOUT', provider, phase, status)
  if (status === 429) return providerError('RATE', provider, phase, status)
  if (status >= 400 && status < 500) return providerError('VALIDATION', provider, phase, status)
  if (status >= 500) return providerError('NETWORK', provider, phase, status)
  return providerError('UNKNOWN', provider, phase, status)
}

export function shouldFallbackAfterImageError(error) {
  return new Set(['AUTH', 'NO_KEY', 'NETWORK', 'RATE', 'TIMEOUT']).has(error?.code)
}
