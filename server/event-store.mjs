import { mkdir, appendFile, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_AUDIT_ROTATE_BYTES = 32 * 1024 * 1024
const DEFAULT_AUDIT_FILES = 4
const DEFAULT_OUTBOX_BYTES = 128 * 1024 * 1024
const DEFAULT_DEAD_LETTER_BYTES = 16 * 1024 * 1024
const DEFAULT_DEAD_LETTER_FILES = 32
// Must remain comfortably below stats-narra's 512 KiB HTTP body limit after
// field mapping and JSON envelope overhead.
const OUTBOX_SEGMENT_BYTES = 256 * 1024
const OUTBOX_SEGMENT_EVENTS = 100

function linesFor(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

function tractionEvent(event) {
  return {
    event_id: event.event_id,
    ts: event.occurred_at,
    device_id: event.actor_id,
    name: event.event_name,
    session_id: event.session_id,
    schema_version: event.schema_version,
    properties: Object.fromEntries(
      Object.entries(event.properties || {}).filter(([, value]) => value !== null && value !== undefined)
    )
  }
}

/**
 * Bounded append-only audit log plus segmented at-least-once outbox.
 * Each delivery touches one small segment; backlog size never creates an
 * O(n²) rewrite or an unbounded in-memory read.
 */
export function createEventStore({
  dataDir,
  environment = 'production',
  tractionUrl = process.env.TRACTION_INGEST_URL || '',
  tractionToken = process.env.TRACTION_INGEST_TOKEN || '',
  fetchImpl = globalThis.fetch,
  auditRotateBytes = DEFAULT_AUDIT_ROTATE_BYTES,
  auditFiles = DEFAULT_AUDIT_FILES,
  outboxMaxBytes = DEFAULT_OUTBOX_BYTES,
  deadLetterMaxBytes = DEFAULT_DEAD_LETTER_BYTES,
  deadLetterMaxFiles = DEFAULT_DEAD_LETTER_FILES,
  flushIntervalMs = 10_000
}) {
  const file = path.join(dataDir, `events-${environment}.jsonl`)
  const outboxPrefix = `traction-outbox-${environment}`
  const currentOutbox = path.join(dataDir, `${outboxPrefix}.open`)
  let chain = Promise.resolve()
  let draining = false
  let timer
  let closed = false
  let retryMs = 1_000
  let nextAttemptAt = 0
  let lastSuccessAt = null
  let lastError = null
  let outboxBytes = null
  let currentOutboxBytes = 0
  let currentOutboxEvents = 0
  let overflowEvents = 0
  let deadLetterSegments = 0
  let deadLetterBytes = 0
  let auditSize = 0

  function serial(operation) {
    const pending = chain.then(operation, operation)
    chain = pending.catch(() => {})
    return pending
  }

  async function files() {
    try {
      return await readdir(dataDir)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  async function sizeOf(target) {
    try {
      return (await stat(target)).size
    } catch (error) {
      if (error?.code === 'ENOENT') return 0
      throw error
    }
  }

  async function initializeSizes() {
    if (outboxBytes !== null) return
    const names = await files()
    outboxBytes = 0
    for (const name of names) {
      if (name === `${outboxPrefix}.open` || (name.startsWith(`${outboxPrefix}.`) && name.endsWith('.ready'))) {
        outboxBytes += await sizeOf(path.join(dataDir, name))
      }
      if (name.startsWith(`traction-dead-letter-${environment}.`) && name.endsWith('.bad')) {
        deadLetterSegments += 1
        deadLetterBytes += await sizeOf(path.join(dataDir, name))
      }
    }
    currentOutboxBytes = await sizeOf(currentOutbox)
    if (currentOutboxBytes) {
      const raw = await readFile(currentOutbox, 'utf8')
      currentOutboxEvents = raw.split('\n').filter(Boolean).length
    }
    auditSize = await sizeOf(file)
  }

  async function rotateAudit() {
    if (auditSize < auditRotateBytes) return
    const rotated = `${file}.${Date.now()}-${randomUUID()}`
    await rename(file, rotated)
    auditSize = 0
    const auditNames = (await files())
      .filter((name) => name.startsWith(`events-${environment}.jsonl.`))
      .sort()
    for (const stale of auditNames.slice(0, Math.max(0, auditNames.length - auditFiles))) {
      await unlink(path.join(dataDir, stale))
    }
  }

  async function sealCurrent() {
    const size = await sizeOf(currentOutbox)
    if (!size) return null
    const ready = path.join(dataDir, `${outboxPrefix}.${Date.now()}-${randomUUID()}.ready`)
    await rename(currentOutbox, ready)
    currentOutboxBytes = 0
    currentOutboxEvents = 0
    return ready
  }

  function outboxChunks(events) {
    const chunks = []
    let current = []
    let bytes = 0
    for (const event of events) {
      const line = `${JSON.stringify(event)}\n`
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > OUTBOX_SEGMENT_BYTES) throw new Error('single analytics event exceeds outbox segment limit')
      if (current.length && (current.length >= OUTBOX_SEGMENT_EVENTS || bytes + lineBytes > OUTBOX_SEGMENT_BYTES)) {
        chunks.push({ events: current, payload: linesFor(current), bytes })
        current = []
        bytes = 0
      }
      current.push(event)
      bytes += lineBytes
    }
    if (current.length) chunks.push({ events: current, payload: linesFor(current), bytes })
    return chunks
  }

  async function append(events) {
    if (!events.length) {
      await serial(async () => {
        await mkdir(dataDir, { recursive: true, mode: 0o700 })
        await initializeSizes()
      })
      return
    }
    const payload = linesFor(events)
    const bytes = Buffer.byteLength(payload)
    await serial(async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 })
      await initializeSizes()
      await rotateAudit()
      await appendFile(file, payload, { encoding: 'utf8', mode: 0o600 })
      auditSize += bytes
      if (outboxBytes + bytes > outboxMaxBytes) {
        overflowEvents += events.length
        lastError = 'Traction outbox is full; events remain in the bounded audit log for operator replay'
        return
      }
      for (const chunk of outboxChunks(events)) {
        if (
          currentOutboxBytes &&
          (currentOutboxBytes + chunk.bytes > OUTBOX_SEGMENT_BYTES ||
            currentOutboxEvents + chunk.events.length > OUTBOX_SEGMENT_EVENTS)
        ) {
          await sealCurrent()
        }
        await appendFile(currentOutbox, chunk.payload, { encoding: 'utf8', mode: 0o600 })
        currentOutboxBytes += chunk.bytes
        currentOutboxEvents += chunk.events.length
        outboxBytes += chunk.bytes
        if (currentOutboxBytes >= OUTBOX_SEGMENT_BYTES || currentOutboxEvents >= OUTBOX_SEGMENT_EVENTS) {
          await sealCurrent()
        }
      }
    })
    void drain()
  }

  async function nextSegment() {
    return serial(async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 })
      await initializeSizes()
      await sealCurrent()
      const ready = (await files()).filter((name) => name.startsWith(outboxPrefix) && name.endsWith('.ready')).sort()
      return ready.length ? path.join(dataDir, ready[0]) : null
    })
  }

  async function quarantineSegment(segment, reason) {
    await serial(async () => {
      const bytes = await sizeOf(segment)
      const deadNames = (await files())
        .filter((name) => name.startsWith(`traction-dead-letter-${environment}.`) && name.endsWith('.bad'))
        .sort()
      // Make room before the rename so a simultaneous health scan/restart never
      // observes storage above its declared file/byte ceiling.
      while (
        deadNames.length &&
        (deadNames.length >= deadLetterMaxFiles || deadLetterBytes + bytes > deadLetterMaxBytes)
      ) {
        const stale = deadNames.shift()
        if (!stale) break
        const target = path.join(dataDir, stale)
        deadLetterBytes = Math.max(0, deadLetterBytes - await sizeOf(target))
        deadLetterSegments = Math.max(0, deadLetterSegments - 1)
        await unlink(target)
      }
      outboxBytes = Math.max(0, (outboxBytes || 0) - bytes)
      if (bytes > deadLetterMaxBytes || deadLetterMaxFiles < 1) {
        await unlink(segment)
        lastError = `Traction segment discarded above dead-letter limit: ${String(reason).slice(0, 160)}`
        return
      }
      const dead = path.join(dataDir, `traction-dead-letter-${environment}.${Date.now()}-${randomUUID()}.bad`)
      await rename(segment, dead)
      deadLetterSegments += 1
      deadLetterBytes += bytes
      lastError = `Traction segment quarantined: ${String(reason).slice(0, 160)}`
    })
    setTimeout(() => void drain(), 0).unref?.()
  }

  async function splitRejectedSegment(segment, batch) {
    const midpoint = Math.ceil(batch.length / 2)
    const base = segment.slice(0, -'.ready'.length)
    const halves = [batch.slice(0, midpoint), batch.slice(midpoint)]
    await serial(async () => {
      for (const [index, events] of halves.entries()) {
        if (!events.length) continue
        await appendFile(`${base}.${index}.ready`, linesFor(events), { encoding: 'utf8', mode: 0o600 })
      }
      await unlink(segment)
    })
    lastError = 'Traction rejected a batch; isolating the invalid event without discarding valid neighbours'
    setTimeout(() => void drain(), 0).unref?.()
  }

  async function drain() {
    if (closed || draining || !tractionUrl || Date.now() < nextAttemptAt) return
    draining = true
    try {
      const segment = await nextSegment()
      if (!segment) return
      let raw
      let batch
      try {
        raw = await readFile(segment, 'utf8')
        if (Buffer.byteLength(raw) > OUTBOX_SEGMENT_BYTES) throw new Error('outbox segment exceeds safety limit')
        batch = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
        if (batch.length > OUTBOX_SEGMENT_EVENTS) throw new Error('outbox segment contains too many events')
      } catch (error) {
        await quarantineSegment(segment, error?.message || error)
        return
      }
      if (!batch.length) {
        await serial(async () => unlink(segment))
        return
      }
      const response = await fetchImpl(tractionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Analytics-Environment': environment,
          ...(tractionToken ? { 'X-Ingest-Token': tractionToken } : {})
        },
        body: JSON.stringify({ events: batch.map(tractionEvent) }),
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) {
        // Only event-schema validation is isolated recursively. Global route,
        // auth, environment and rate/config errors must block FIFO and retry;
        // bisecting them would eventually DLQ an entirely valid backlog.
        if ([400, 422].includes(response.status)) {
          if (batch.length > 1) {
            await splitRejectedSegment(segment, batch)
            return
          }
          await quarantineSegment(segment, `ingest returned ${response.status}`)
          return
        }
        throw new Error(`Traction ingest returned ${response.status}`)
      }
      await serial(async () => {
        const bytes = await sizeOf(segment)
        await unlink(segment)
        outboxBytes = Math.max(0, (outboxBytes || 0) - bytes)
      })
      lastSuccessAt = new Date().toISOString()
      lastError = overflowEvents ? lastError : null
      retryMs = 1_000
      nextAttemptAt = 0
      setTimeout(() => void drain(), 0).unref?.()
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 240)
      nextAttemptAt = Date.now() + retryMs
      retryMs = Math.min(retryMs * 2, 60_000)
    } finally {
      draining = false
    }
  }

  function start() {
    if (timer) return
    closed = false
    timer = setInterval(() => void drain(), flushIntervalMs)
    timer.unref?.()
    void drain()
  }

  async function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
    closed = true
    while (draining) await new Promise((resolve) => setTimeout(resolve, 5))
    await chain
  }

  function status() {
    return {
      configured: Boolean(tractionUrl),
      backlog_bytes: outboxBytes || 0,
      overflow_events: overflowEvents,
      dead_letter_segments: deadLetterSegments,
      dead_letter_bytes: deadLetterBytes,
      last_success_at: lastSuccessAt,
      last_error: lastError,
      retry_at: nextAttemptAt ? new Date(nextAttemptAt).toISOString() : null
    }
  }

  return { file, currentOutbox, append, drain, start, stop, status }
}
