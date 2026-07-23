function terminalErrorCode(error) {
  if (error?.code === 'CANCELLED' || error?.name === 'AbortError') return 'CANCELLED'
  if (error?.code === 'CENSOR') return 'CENSOR'
  if (error?.code === 'VALIDATION') return 'VALIDATION'
  if (error?.code === 'PARSE' || error instanceof SyntaxError) return 'PARSE'
  if (error?.code === 'TIMEOUT' || error?.name === 'TimeoutError') return 'TIMEOUT'
  return 'NETWORK'
}

/**
 * A provider attempt becomes successful only after its response has been
 * consumed and parsed. The finalizer is idempotent, so callers may safely
 * surface the same downstream error without double-counting an attempt.
 */
export async function settleProviderResponse({ consume, finalizeAttempt }) {
  try {
    const value = await consume()
    await finalizeAttempt({ status: 'completed' })
    return value
  } catch (error) {
    await finalizeAttempt({ status: 'failed', error_code: terminalErrorCode(error) })
    throw error
  }
}

export function validateChatCompletionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('LLM returned an invalid completion payload'), {
      code: 'PARSE', status: 502
    })
  }
  if (payload.error) {
    const fingerprint = `${payload.error?.code || ''} ${payload.error?.type || ''}`.toLowerCase()
    const moderation = /content.?filter|moderation|safety|unsafe|censor|blocked/.test(fingerprint)
    throw Object.assign(
      new Error(moderation
        ? 'LLM completion was blocked by content safety'
        : 'LLM completion returned an upstream error'),
      { code: moderation ? 'CENSOR' : 'NETWORK', status: moderation ? 422 : 502 }
    )
  }
  if (
    !Array.isArray(payload.choices) ||
    payload.choices.length < 1 ||
    payload.choices.some((choice) => choice?.finish_reason === 'content_filter')
  ) {
    const censored = Array.isArray(payload.choices) &&
      payload.choices.some((choice) => choice?.finish_reason === 'content_filter')
    throw Object.assign(
      new Error(censored
        ? 'LLM completion was blocked by content safety'
        : 'LLM completion did not contain a choice'),
      { code: censored ? 'CENSOR' : 'PARSE', status: censored ? 422 : 502 }
    )
  }
  return payload
}

export { terminalErrorCode }
