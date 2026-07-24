import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

function forbiddenAddress(address) {
  const value = address.toLowerCase()
  if (value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : value
  if (isIP(mapped) !== 4) return false
  const [a, b] = mapped.split('.').map(Number)
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

export async function assertSafeImportUrl(input, allowedHosts, lookupImpl = lookup) {
  const url = input instanceof URL ? input : new URL(String(input))
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    throw Object.assign(new Error('Хост не поддерживается'), { status: 400, code: 'VALIDATION' })
  }
  if (url.username || url.password || url.port) {
    throw Object.assign(new Error('URL с credentials/port не поддерживается'), { status: 400, code: 'VALIDATION' })
  }
  const addresses = await lookupImpl(url.hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => forbiddenAddress(address))) {
    throw Object.assign(new Error('Адрес источника запрещён'), { status: 400, code: 'VALIDATION' })
  }
  return url
}

export async function fetchWithRedirectPolicy(
  input,
  { allowedHosts, headers, maxRedirects = 5, timeoutMs = 30_000, fetchImpl = fetch, lookupImpl = lookup, signal }
) {
  let url = await assertSafeImportUrl(input, allowedHosts, lookupImpl)
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const response = await fetchImpl(url, {
      headers,
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel().catch(() => {})
    const location = response.headers.get('location')
    if (!location || redirect === maxRedirects) {
      throw Object.assign(new Error('Слишком много перенаправлений'), { status: 502, code: 'NETWORK' })
    }
    url = await assertSafeImportUrl(new URL(location, url), allowedHosts, lookupImpl)
  }
  throw Object.assign(new Error('Перенаправление не удалось'), { status: 502, code: 'NETWORK' })
}

export async function readBoundedBody(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw Object.assign(new Error('Файл больше 30 МБ'), { status: 413, code: 'VALIDATION' })
  if (!response.body) return Buffer.alloc(0)
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    if (signal?.aborted) {
      await response.body.cancel().catch(() => {})
      throw signal.reason || Object.assign(new Error('Загрузка отменена'), { status: 499, code: 'CANCELLED' })
    }
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) {
      await response.body.cancel().catch(() => {})
      throw Object.assign(new Error('Файл больше 30 МБ'), { status: 413, code: 'VALIDATION' })
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, total)
}
