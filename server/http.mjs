import https from 'https'
import { URL } from 'url'

export function createHttpsAgent({ insecure = false, ca } = {}) {
  return new https.Agent({
    rejectUnauthorized: !insecure,
    ...(Array.isArray(ca) && ca.length ? { ca } : {})
  })
}

export function createResponseBuffer({ binary = false, onChunk, maxResponseBytes } = {}) {
  const limit = maxResponseBytes === undefined ? Number.POSITIVE_INFINITY : Number(maxResponseBytes)
  if (!(limit > 0)) throw new Error('maxResponseBytes must be positive')
  const chunks = []
  let total = 0
  return {
    push(data) {
      total += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data)
      if (total > limit) {
        throw Object.assign(new Error('Upstream response exceeded the gateway limit'), {
          code: 'NETWORK',
          status: 502
        })
      }
      if (onChunk) onChunk(data)
      else chunks.push(binary ? data : Buffer.from(data))
    },
    value() {
      if (onChunk) return null
      return binary ? Buffer.concat(chunks) : chunks.join('')
    }
  }
}

export function consumeResponse(res, { binary = false, onChunk, maxResponseBytes } = {}) {
  return new Promise((resolve, reject) => {
    const accumulator = createResponseBuffer({ binary, onChunk, maxResponseBytes })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    if (!binary) res.setEncoding('utf8')
    res.on('data', (data) => {
      if (settled) return
      try {
        accumulator.push(data)
      } catch (error) {
        fail(error)
        res.destroy()
      }
    })
    res.on('error', fail)
    res.on('aborted', () => {
      fail(Object.assign(new Error('Upstream response was aborted'), {
        code: 'NETWORK',
        status: 502
      }))
    })
    res.on('end', () => {
      if (settled) return
      settled = true
      resolve(accumulator.value())
    })
  })
}

// Низкоуровневый HTTPS-запрос с настраиваемым TLS-агентом (сертификаты НУЦ Минцифры
// у Сбера) и поддержкой потокового чтения (SSE).
export function httpsRequest(urlStr, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 60000,
    insecure = false,
    ca,
    onChunk,
    binary = false,
    maxResponseBytes,
    signal
  } = opts

  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(urlStr)
    } catch {
      reject(new Error(`Bad URL: ${urlStr}`))
      return
    }

    const agent = createHttpsAgent({ insecure, ca })
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        agent
      },
      (res) => {
        consumeResponse(res, { binary, onChunk, maxResponseBytes })
          .then((body) => resolve({
            status: res.statusCode || 0,
            body,
            headers: res.headers
          }))
          .catch(reject)
      }
    )

    req.setTimeout(timeoutMs, () => req.destroy(new Error('TIMEOUT')))
    if (signal) {
      if (signal.aborted) req.destroy(signal.reason || new Error('ABORTED'))
      else signal.addEventListener('abort', () => req.destroy(signal.reason || new Error('ABORTED')), { once: true })
    }
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
