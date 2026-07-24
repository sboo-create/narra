import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import path from 'node:path'

const FORMAT_VERSION = 1
const MAX_FILE_BYTES = 64 * 1024 * 1024
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function emptyState() {
  return { version: FORMAT_VERSION, installations: {}, registration_budgets: {} }
}

function cleanText(value, max = 80) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function assertLoadedState(candidate) {
  if (
    !candidate ||
    candidate.version !== FORMAT_VERSION ||
    !candidate.installations ||
    typeof candidate.installations !== 'object' ||
    Array.isArray(candidate.installations) ||
    !candidate.registration_budgets ||
    typeof candidate.registration_budgets !== 'object' ||
    Array.isArray(candidate.registration_budgets)
  ) {
    throw new Error('installation registry has an unsupported or corrupt format')
  }
  for (const [installationId, record] of Object.entries(candidate.installations)) {
    if (
      !INSTALLATION_ID.test(installationId) ||
      !record ||
      !['active', 'revoked'].includes(record.status) ||
      !Number.isInteger(record.token_version) ||
      record.token_version < 1 ||
      typeof record.refresh_secret_hash !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.refresh_secret_hash)
    ) {
      throw new Error('installation registry contains an invalid installation record')
    }
  }
  for (const entry of Object.values(candidate.registration_budgets)) {
    if (
      !entry ||
      !Number.isSafeInteger(entry.used) ||
      entry.used < 0 ||
      !Number.isSafeInteger(entry.reset_at) ||
      entry.reset_at < 1
    ) {
      throw new Error('installation registry contains an invalid budget record')
    }
  }
  return candidate
}

function utcWindow(now, kind) {
  const date = new Date(now)
  if (kind === 'hour') {
    const start = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours()
    )
    return { start, resetAt: start + 60 * 60 * 1000 }
  }
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return { start, resetAt: start + 24 * 60 * 60 * 1000 }
}

function budgetKey(kind, start, metric, subject) {
  return `${kind}:${start}:${metric}:${subject}`
}

/**
 * A small, fail-closed registry for the single-instance Railway deployment.
 *
 * Installation records use an atomically-renamed snapshot. High-frequency
 * per-install/global reservations share one append-only journal entry, keeping
 * both counters crash-consistent without rewriting a growing snapshot.
 */
export function createInstallationRegistry({
  dataDir,
  environment = 'production',
  maxInstallations = 10_000,
  registrationLimitPerHour = 1_000,
  registrationLimitPerDay = 250,
  inactiveRetentionDays = 30,
  touchFlushIntervalMs = 15 * 60 * 1000,
  beforeSnapshotCommit = async () => {},
  now = () => Date.now()
}) {
  const file = path.join(dataDir, `installations-${environment}.json`)
  let state = emptyState()
  let usageBudgets = {}
  let usageJournal = ''
  let usageJournalBytes = 0
  let initialized = false
  let storageVerified = false
  let dirtyTouches = false
  let touchTimer
  let chain = Promise.resolve()

  function serial(operation) {
    const pending = chain.then(operation, operation)
    chain = pending.catch(() => {})
    return pending
  }

  function pruneRegistrationBudgets(timestamp) {
    for (const [key, entry] of Object.entries(state.registration_budgets)) {
      if (entry.reset_at <= timestamp) delete state.registration_budgets[key]
    }
  }

  function applyUsageEntry(entry) {
    if (
      !entry ||
      !INSTALLATION_ID.test(entry.installation_id) ||
      typeof entry.metric !== 'string' ||
      !/^[a-z][a-z0-9_]{1,48}$/.test(entry.metric) ||
      !Number.isSafeInteger(entry.amount) ||
      entry.amount < 1 ||
      !Number.isSafeInteger(entry.window_start) ||
      !Number.isSafeInteger(entry.reset_at)
    ) {
      throw new Error('installation budget journal contains an invalid entry')
    }
    const installKey = budgetKey('day', entry.window_start, entry.metric, `installation:${entry.installation_id}`)
    const globalKey = budgetKey('day', entry.window_start, entry.metric, 'global')
    usageBudgets[installKey] = {
      used: (usageBudgets[installKey]?.used || 0) + entry.amount,
      reset_at: entry.reset_at
    }
    usageBudgets[globalKey] = {
      used: (usageBudgets[globalKey]?.used || 0) + entry.amount,
      reset_at: entry.reset_at
    }
  }

  async function loadUsageJournal(timestamp) {
    const day = utcWindow(timestamp, 'day')
    const dayKey = new Date(day.start).toISOString().slice(0, 10)
    usageJournal = path.join(dataDir, `installation-budgets-${environment}-${dayKey}.jsonl`)
    usageBudgets = {}
    try {
      const raw = await readFile(usageJournal, 'utf8')
      usageJournalBytes = Buffer.byteLength(raw)
      if (usageJournalBytes > MAX_FILE_BYTES) {
        throw new Error('installation budget journal exceeds its safety size limit')
      }
      for (const line of raw.split('\n').filter(Boolean)) {
        applyUsageEntry(JSON.parse(line))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      usageJournalBytes = 0
    }
    const prefix = `installation-budgets-${environment}-`
    for (const name of await readdir(dataDir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.jsonl') || name === path.basename(usageJournal)) continue
      const target = path.join(dataDir, name)
      const age = timestamp - (await stat(target)).mtimeMs
      if (age > 2 * 24 * 60 * 60 * 1000) await unlink(target)
    }
  }

  async function persist(candidate = state) {
    const temporary = `${file}.tmp`
    const payload = `${JSON.stringify(candidate)}\n`
    if (Buffer.byteLength(payload) > MAX_FILE_BYTES) {
      throw new Error('installation registry exceeds its safety size limit')
    }
    await beforeSnapshotCommit()
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
    state = candidate
  }

  async function verifyStorage() {
    const id = randomUUID()
    const temporary = path.join(dataDir, `.installation-storage-probe-${id}.tmp`)
    const committed = path.join(dataDir, `.installation-storage-probe-${id}.ok`)
    await writeFile(temporary, id, { encoding: 'utf8', mode: 0o600 })
    if ((await readFile(temporary, 'utf8')) !== id) throw new Error('installation storage write probe failed')
    await rename(temporary, committed)
    if ((await readFile(committed, 'utf8')) !== id) throw new Error('installation storage rename probe failed')
    await unlink(committed)
    storageVerified = true
  }

  async function flushTouches() {
    return serial(async () => {
      requireStarted()
      if (!dirtyTouches) return
      await persist(structuredClone(state))
      dirtyTouches = false
    })
  }

  async function start() {
    await serial(async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 })
      await verifyStorage()
      try {
        const raw = await readFile(file, 'utf8')
        if (Buffer.byteLength(raw) > MAX_FILE_BYTES) {
          throw new Error('installation registry exceeds its safety size limit')
        }
        state = assertLoadedState(JSON.parse(raw))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        state = emptyState()
      }
      pruneRegistrationBudgets(now())
      await loadUsageJournal(now())
      initialized = true
    })
    touchTimer = setInterval(() => void flushTouches().catch((error) => {
      console.error('[installation-registry] touch flush failed:', error?.message || error)
    }), touchFlushIntervalMs)
    touchTimer.unref?.()
  }

  function requireStarted() {
    if (!initialized) throw new Error('installation registry is not initialized')
  }

  async function register({ installationId, refreshSecretHash, appVersion, platform, arch }) {
    return serial(async () => {
      requireStarted()
      const timestamp = now()
      const existing = state.installations[installationId]
      if (existing?.status === 'revoked') {
        return { ok: false, code: 'REVOKED' }
      }
      if (existing) {
        if (!safeHashEqual(existing.refresh_secret_hash, refreshSecretHash)) {
          return { ok: false, code: 'INVALID_PROOF' }
        }
        existing.last_seen_at = timestamp
        existing.last_app_version = cleanText(appVersion)
        existing.platform = cleanText(platform)
        existing.arch = cleanText(arch)
        dirtyTouches = true
        return { ok: true, created: false, record: safeRecord(existing) }
      }
      const candidate = structuredClone(state)
      const inactiveBefore = timestamp - inactiveRetentionDays * 24 * 60 * 60 * 1000
      for (const [candidateId, record] of Object.entries(candidate.installations)) {
        if (record.status === 'active' && record.last_seen_at < inactiveBefore) {
          delete candidate.installations[candidateId]
        }
      }
      if (Object.keys(candidate.installations).length >= maxInstallations) {
        return { ok: false, code: 'REGISTRY_FULL' }
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(refreshSecretHash || '')) {
        return { ok: false, code: 'INVALID_PROOF' }
      }
      for (const [key, entry] of Object.entries(candidate.registration_budgets)) {
        if (entry.reset_at <= timestamp) delete candidate.registration_budgets[key]
      }
      const hour = utcWindow(timestamp, 'hour')
      const day = utcWindow(timestamp, 'day')
      const hourKey = budgetKey('hour', hour.start, 'registrations', 'global')
      const dayKey = budgetKey('day', day.start, 'registrations', 'global')
      const hourUsed = candidate.registration_budgets[hourKey]?.used || 0
      const dayUsed = candidate.registration_budgets[dayKey]?.used || 0
      if (hourUsed >= registrationLimitPerHour || dayUsed >= registrationLimitPerDay) {
        return {
          ok: false,
          code: 'REGISTRATION_BUDGET',
          resetAt: hourUsed >= registrationLimitPerHour ? hour.resetAt : day.resetAt
        }
      }
      candidate.registration_budgets[hourKey] = { used: hourUsed + 1, reset_at: hour.resetAt }
      candidate.registration_budgets[dayKey] = { used: dayUsed + 1, reset_at: day.resetAt }
      const record = {
        status: 'active',
        token_version: 1,
        refresh_secret_hash: refreshSecretHash,
        created_at: timestamp,
        last_seen_at: timestamp,
        first_app_version: cleanText(appVersion),
        last_app_version: cleanText(appVersion),
        platform: cleanText(platform),
        arch: cleanText(arch)
      }
      candidate.installations[installationId] = record
      await persist(candidate)
      dirtyTouches = false
      return { ok: true, created: true, record: safeRecord(record) }
    })
  }

  function authenticate(identity) {
    requireStarted()
    if (!identity) return null
    const record = state.installations[identity.sub]
    if (
      !record ||
      record.status !== 'active' ||
      identity.ver !== record.token_version
    ) {
      return null
    }
    return { ...identity }
  }

  async function refresh(installationId, refreshSecretHash) {
    return serial(async () => {
      requireStarted()
      const record = state.installations[installationId]
      if (!record) return { ok: false, code: 'NOT_FOUND' }
      if (record.status !== 'active') return { ok: false, code: 'REVOKED' }
      if (!safeHashEqual(record.refresh_secret_hash, refreshSecretHash)) {
        return { ok: false, code: 'INVALID_PROOF' }
      }
      record.last_seen_at = now()
      dirtyTouches = true
      return { ok: true, record: safeRecord(record) }
    })
  }

  async function revoke(installationId, reason = '') {
    return serial(async () => {
      requireStarted()
      const record = state.installations[installationId]
      if (!record) return null
      if (record.status !== 'revoked') {
        const candidate = structuredClone(state)
        candidate.installations[installationId] = {
          ...candidate.installations[installationId],
          status: 'revoked',
          revoked_at: now(),
          revoke_reason: cleanText(reason, 160),
          token_version: candidate.installations[installationId].token_version + 1
        }
        await persist(candidate)
        dirtyTouches = false
      }
      return safeRecord(state.installations[installationId])
    })
  }

  function get(installationId) {
    requireStarted()
    const record = state.installations[installationId]
    return record ? safeRecord(record) : null
  }

  async function reserve({
    installationId,
    metric,
    amount = 1,
    perInstallationLimit,
    globalLimit,
    windowKind = 'day'
  }) {
    return serial(async () => {
      requireStarted()
      if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('invalid budget amount')
      const timestamp = now()
      const window = utcWindow(timestamp, windowKind)
      if (windowKind !== 'day') throw new Error('usage budgets support UTC-day windows only')
      const installKey = budgetKey(windowKind, window.start, metric, `installation:${installationId}`)
      const globalKey = budgetKey(windowKind, window.start, metric, 'global')
      const expectedJournal = path.join(
        dataDir,
        `installation-budgets-${environment}-${new Date(window.start).toISOString().slice(0, 10)}.jsonl`
      )
      if (usageJournal !== expectedJournal) await loadUsageJournal(timestamp)
      const installationUsed = usageBudgets[installKey]?.used || 0
      const globalUsed = usageBudgets[globalKey]?.used || 0
      if (
        installationUsed + amount > perInstallationLimit ||
        globalUsed + amount > globalLimit
      ) {
        return {
          ok: false,
          resetAt: window.resetAt,
          installationRemaining: Math.max(0, perInstallationLimit - installationUsed),
          globalRemaining: Math.max(0, globalLimit - globalUsed),
          scope: installationUsed + amount > perInstallationLimit ? 'installation' : 'global'
        }
      }
      const entry = {
        installation_id: installationId,
        metric,
        amount,
        window_start: window.start,
        reset_at: window.resetAt
      }
      const line = `${JSON.stringify(entry)}\n`
      if (usageJournalBytes + Buffer.byteLength(line) > MAX_FILE_BYTES) {
        return {
          ok: false,
          resetAt: window.resetAt,
          installationRemaining: Math.max(0, perInstallationLimit - installationUsed),
          globalRemaining: 0,
          scope: 'global'
        }
      }
      await appendFile(usageJournal, line, { encoding: 'utf8', mode: 0o600 })
      usageJournalBytes += Buffer.byteLength(line)
      applyUsageEntry(entry)
      return {
        ok: true,
        resetAt: window.resetAt,
        installationRemaining: perInstallationLimit - installationUsed - amount,
        globalRemaining: globalLimit - globalUsed - amount
      }
    })
  }

  function status() {
    requireStarted()
    const records = Object.values(state.installations)
    return {
      active: records.filter((record) => record.status === 'active').length,
      revoked: records.filter((record) => record.status === 'revoked').length,
      max_installations: maxInstallations,
      persistent: true,
      storage_verified: storageVerified,
      capacity_remaining: Math.max(0, maxInstallations - records.length)
    }
  }

  async function stop() {
    if (touchTimer) clearInterval(touchTimer)
    touchTimer = undefined
    await flushTouches()
    await chain
  }

  return { start, stop, register, authenticate, refresh, revoke, get, reserve, status }
}

function safeHashEqual(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

function safeRecord(record) {
  const { refresh_secret_hash: _secret, ...visible } = record
  return { ...visible }
}
