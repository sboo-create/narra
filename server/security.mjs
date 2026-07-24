import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_VERSION = 3
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function encode(value) {
  return Buffer.from(value).toString('base64url')
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString('utf8')
}

export function resolveTokenSecret(env = process.env) {
  const configured = String(env.GATEWAY_TOKEN_SECRET || '').trim()
  if (configured.length >= 32) return configured
  if (env.NODE_ENV === 'production') {
    throw new Error('GATEWAY_TOKEN_SECRET must contain at least 32 characters in production')
  }
  console.warn('[security] GATEWAY_TOKEN_SECRET is missing; tokens will reset on restart')
  return randomBytes(32).toString('hex')
}

export function createTokenService(secret, { ttlSeconds = 15 * 60 } = {}) {
  const sign = (body) => createHmac('sha256', secret).update(body).digest('base64url')

  return {
    issue(installationId, tokenVersion, now = Date.now()) {
      if (!INSTALLATION_ID.test(installationId)) throw new Error('invalid installation_id')
      if (!Number.isInteger(tokenVersion) || tokenVersion < 1) throw new Error('invalid token_version')
      const issuedAt = Math.floor(now / 1000)
      const body = encode(
        JSON.stringify({
          v: TOKEN_VERSION,
          sub: installationId,
          ver: tokenVersion,
          iat: issuedAt,
          exp: issuedAt + ttlSeconds
        })
      )
      return `nrv3.${body}.${sign(body)}`
    },

    verify(token, now = Date.now()) {
      if (typeof token !== 'string') return null
      const [prefix, body, signature, extra] = token.split('.')
      if (prefix !== 'nrv3' || !body || !signature || extra) return null
      const expected = Buffer.from(sign(body))
      const actual = Buffer.from(signature)
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
      try {
        const payload = JSON.parse(decode(body))
        if (
          payload.v !== TOKEN_VERSION ||
          !INSTALLATION_ID.test(payload.sub) ||
          !Number.isInteger(payload.ver) ||
          payload.ver < 1 ||
          !Number.isInteger(payload.iat) ||
          !Number.isInteger(payload.exp) ||
          payload.exp <= Math.floor(now / 1000)
        ) {
          return null
        }
        return payload
      } catch {
        return null
      }
    }
  }
}

export function bearerToken(header) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(header || ''))
  return match?.[1] || ''
}

export function hashInstallationSecret(secret, pepper) {
  if (
    typeof secret !== 'string' ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(secret) ||
    typeof pepper !== 'string' ||
    pepper.length < 32
  ) {
    return ''
  }
  return createHmac('sha256', pepper)
    .update('narra-installation-refresh-v1\0')
    .update(secret)
    .digest('base64url')
}

export function createFixedWindowLimiter({ windowMs, limit, key, now = () => Date.now() }) {
  const buckets = new Map()
  return (req, res, next) => {
    const bucketKey = key(req)
    const timestamp = now()
    const current = buckets.get(bucketKey)
    const bucket = !current || current.resetAt <= timestamp
      ? { count: 0, resetAt: timestamp + windowMs }
      : current
    bucket.count += 1
    buckets.set(bucketKey, bucket)
    res.setHeader('RateLimit-Limit', String(limit))
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)))
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)))
    if (bucket.count > limit) {
      return res.status(429).json({ error: 'Слишком много запросов', code: 'RATE' })
    }
    if (buckets.size > 10_000) {
      for (const [candidate, value] of buckets) {
        if (value.resetAt <= timestamp) buckets.delete(candidate)
      }
    }
    next()
  }
}

/**
 * Conservatively reserves a fixed number of bytes for every accepted request.
 * Failed/short requests still consume the reservation: this keeps the abuse
 * ceiling deterministic and avoids an attacker winning quota back with aborts.
 */
export function createFixedWindowByteBudget({ windowMs, maxBytes, reserveBytes, key, now = () => Date.now() }) {
  const buckets = new Map()
  return (req, res, next) => {
    const bucketKey = key(req)
    const timestamp = now()
    const current = buckets.get(bucketKey)
    const bucket = !current || current.resetAt <= timestamp
      ? { bytes: 0, resetAt: timestamp + windowMs }
      : current
    if (bucket.bytes + reserveBytes > maxBytes) {
      res.setHeader('RateLimit-Byte-Limit', String(maxBytes))
      res.setHeader('RateLimit-Byte-Remaining', String(Math.max(0, maxBytes - bucket.bytes)))
      return res.status(429).json({ error: 'Дневной лимит загрузок исчерпан', code: 'RATE' })
    }
    bucket.bytes += reserveBytes
    buckets.set(bucketKey, bucket)
    res.setHeader('RateLimit-Byte-Limit', String(maxBytes))
    res.setHeader('RateLimit-Byte-Remaining', String(Math.max(0, maxBytes - bucket.bytes)))
    if (buckets.size > 10_000) {
      for (const [candidate, value] of buckets) {
        if (value.resetAt <= timestamp) buckets.delete(candidate)
      }
    }
    next()
  }
}

export function requireGatewayAuth(tokenService, installationRegistry) {
  return (req, res, next) => {
    const verified = tokenService.verify(bearerToken(req.headers.authorization))
    const identity = installationRegistry.authenticate(verified)
    if (!identity) {
      res.setHeader(
        'WWW-Authenticate',
        'Bearer realm="narra-installation", error="invalid_token"'
      )
      res.setHeader('X-Narra-Auth-Error', 'installation_token')
      return res.status(401).json({ error: 'Нужен действующий installation token', code: 'AUTH' })
    }
    req.installation = identity
    next()
  }
}

export function requireOperatorAuth(secret) {
  return (req, res, next) => {
    const supplied = bearerToken(req.headers.authorization)
    const expected = Buffer.from(secret)
    const actual = Buffer.from(supplied)
    if (!secret || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return res.status(401).json({ error: 'Нужен operator token', code: 'AUTH' })
    }
    next()
  }
}

export function createPersistentBudgetMiddleware({
  registry,
  metric,
  perInstallationLimit,
  globalLimit,
  amount = () => 1
}) {
  return async (req, res, next) => {
    try {
      const reservation = await registry.reserve({
        installationId: req.installation.sub,
        metric,
        amount: amount(req),
        perInstallationLimit,
        globalLimit
      })
      res.setHeader('RateLimit-Daily-Limit', String(perInstallationLimit))
      res.setHeader('RateLimit-Daily-Remaining', String(reservation.installationRemaining))
      res.setHeader('RateLimit-Global-Remaining', String(reservation.globalRemaining))
      res.setHeader('RateLimit-Reset', String(Math.ceil(reservation.resetAt / 1000)))
      if (!reservation.ok) {
        return res.status(429).json({
          error: reservation.scope === 'global'
            ? 'Общий дневной бюджет сервиса исчерпан'
            : 'Дневной лимит установки исчерпан',
          code: 'RATE'
        })
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

export function isInstallationId(value) {
  return INSTALLATION_ID.test(String(value || ''))
}
