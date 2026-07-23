export function serviceUrl(
  name,
  raw,
  {
    allowPrivateHttp = false,
    allowInsecureHttp = false,
    allowedInsecureHosts = [],
    production = process.env.NODE_ENV === 'production'
  } = {}
) {
  const value = String(raw || '').trim().replace(/\/+$/, '')
  if (!value) return ''
  const url = new URL(value)
  const privateHttp =
    allowPrivateHttp &&
    url.protocol === 'http:' &&
    url.hostname.endsWith('.railway.internal')
  const explicitlyAllowedHttp =
    allowInsecureHttp &&
    url.protocol === 'http:' &&
    allowedInsecureHosts.includes(url.hostname)
  const localDev =
    !production &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(url.hostname)
  if (
    url.protocol !== 'https:' &&
    !privateHttp &&
    !explicitlyAllowedHttp &&
    !localDev
  ) {
    throw new Error(`${name} must use HTTPS`)
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${name} contains forbidden URL components`)
  }
  return value
}

export function isSecureServiceUrl(value) {
  if (!value) return false
  return new URL(value).protocol === 'https:'
}

export function insecureVideoEnvironmentAllowed({ production, analyticsEnvironment }) {
  return analyticsEnvironment === 'staging' ||
    (!production && ['development', 'test'].includes(analyticsEnvironment))
}
