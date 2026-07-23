type StreamErrorCode = 'PARSE' | 'CENSOR' | 'NETWORK'

function streamError(code: StreamErrorCode, message: string): Error & { code: StreamErrorCode } {
  return Object.assign(new Error(message), { code })
}

function errorCode(payload: unknown): StreamErrorCode {
  const code = String((payload as { error?: { code?: unknown } })?.error?.code || '').toUpperCase()
  if (code === 'CENSOR') return 'CENSOR'
  if (code === 'PARSE') return 'PARSE'
  return 'NETWORK'
}

export async function consumeOpenAiSse(
  body: AsyncIterable<Uint8Array>,
  onDelta: (delta: string) => void,
  maxBufferedBytes = 512 * 1024
): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let sawJsonEvent = false
  let done = false

  const processLine = (line: string): void => {
    const normalized = line.trimStart()
    if (!normalized.startsWith('data:')) return
    const data = normalized.slice(5).trim()
    if (done) throw streamError('PARSE', 'Поток LLM содержит данные после [DONE]')
    if (data === '[DONE]') {
      done = true
      return
    }
    if (!data) throw streamError('PARSE', 'Поток LLM содержит пустое data-событие')
    let payload: {
      error?: unknown
      choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>
    }
    try {
      payload = JSON.parse(data) as typeof payload
    } catch {
      throw streamError('PARSE', 'Поток LLM содержит повреждённый JSON')
    }
    sawJsonEvent = true
    if (payload?.error) {
      const code = errorCode(payload)
      throw streamError(
        code,
        code === 'CENSOR'
          ? 'Ответ заблокирован проверкой безопасности'
          : code === 'PARSE'
            ? 'Провайдер вернул повреждённый поток'
            : 'Провайдер сообщил об ошибке потока'
      )
    }
    if (
      Array.isArray(payload?.choices) &&
      payload.choices.some((choice) => choice?.finish_reason === 'content_filter')
    ) {
      throw streamError('CENSOR', 'Ответ заблокирован проверкой безопасности')
    }
    const delta = payload?.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) {
      full += delta
      onDelta(delta)
    }
  }

  const consumeBuffer = (flush = false): void => {
    const lines = buffer.split(/\r?\n/)
    buffer = flush ? '' : lines.pop() || ''
    for (const line of lines) processLine(line)
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    if (Buffer.byteLength(buffer) > maxBufferedBytes) {
      throw streamError('PARSE', 'Событие потока LLM превышает лимит')
    }
    consumeBuffer()
  }
  buffer += decoder.decode()
  consumeBuffer(true)
  if (!sawJsonEvent) throw streamError('PARSE', 'Поток LLM не содержит ответа')
  if (!done) throw streamError('PARSE', 'Поток LLM оборвался до [DONE]')
  return full
}
