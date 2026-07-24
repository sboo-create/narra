import process from 'node:process'

const [, , action, installationId, ...reasonParts] = process.argv
const gateway = String(process.env.NARRA_OPERATOR_GATEWAY_URL || '').trim().replace(/\/+$/, '')
const token = String(process.env.INSTALLATION_OPERATOR_TOKEN || '').trim()

if (!['get', 'revoke'].includes(action) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId || '')) {
  throw new Error('Usage: node scripts/manage-installation.mjs get|revoke <installation-uuid> [reason]')
}
if (token.length < 32) throw new Error('INSTALLATION_OPERATOR_TOKEN must be set locally')
const url = new URL(gateway)
if (
  (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
) {
  throw new Error('NARRA_OPERATOR_GATEWAY_URL must be a clean HTTPS origin or local development URL')
}

const response = await fetch(
  `${gateway}/v2/admin/installations/${installationId}${action === 'revoke' ? '/revoke' : ''}`,
  {
    method: action === 'revoke' ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(action === 'revoke' ? { 'Content-Type': 'application/json' } : {})
    },
    ...(action === 'revoke'
      ? { body: JSON.stringify({ reason: reasonParts.join(' ').slice(0, 160) }) }
      : {}),
    signal: AbortSignal.timeout(10_000)
  }
)
const payload = await response.json().catch(() => ({}))
if (!response.ok) throw new Error(`Gateway returned ${response.status}: ${payload.error || 'unknown error'}`)
console.log(JSON.stringify(payload, null, 2))
