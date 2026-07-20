import https from 'https'
import { URL } from 'url'

// Низкоуровневый HTTPS-запрос с настраиваемым TLS-агентом (сертификаты НУЦ Минцифры
// у Сбера) и поддержкой потокового чтения (SSE).
export function httpsRequest(urlStr, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 60000,
    insecure = false,
    onChunk,
    binary = false
  } = opts

  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(urlStr)
    } catch {
      reject(new Error(`Bad URL: ${urlStr}`))
      return
    }

    const agent = new https.Agent({ rejectUnauthorized: !insecure })
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
        const chunks = []
        if (!binary) res.setEncoding('utf8')
        res.on('data', (d) => {
          if (onChunk) onChunk(d)
          else chunks.push(binary ? d : Buffer.from(d))
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: onChunk ? null : binary ? Buffer.concat(chunks) : chunks.join(''),
            headers: res.headers
          })
        })
      }
    )

    req.setTimeout(timeoutMs, () => req.destroy(new Error('TIMEOUT')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
