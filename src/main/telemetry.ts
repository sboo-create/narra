import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  ANALYTICS_SCHEMA_VERSION,
  isEssentialAnalyticsEvent,
  sanitizeAnalyticsProperties,
  type AnalyticsEvent,
  type AnalyticsEventName,
  type SafeAnalyticsValue
} from '../shared/analytics'
import { sendTelemetryBatch } from './api/proxy'
import { getSettings, getTelemetryQueue, getTelemetrySession, quarantineTelemetry, setTelemetryQueue } from './store'
import { partitionFreshTelemetry } from './telemetry-queue'

let flushing = false
let interval: ReturnType<typeof setInterval> | undefined
let startedAt = 0
let stopped = false

export function recordTelemetry(
  name: AnalyticsEventName,
  properties: Record<string, SafeAnalyticsValue> = {}
): void {
  if (!isEssentialAnalyticsEvent(name) && !getSettings().extendedTelemetryEnabled) return
  const event: AnalyticsEvent = {
    eventId: randomUUID(),
    name,
    occurredAt: new Date().toISOString(),
    sessionId: getTelemetrySession(),
    properties: sanitizeAnalyticsProperties(properties, name),
    schemaVersion: ANALYTICS_SCHEMA_VERSION
  }
  setTelemetryQueue([...getTelemetryQueue(), event])
}

export async function flushTelemetry(): Promise<void> {
  if (flushing) return
  const queued = getTelemetryQueue()
  const { fresh, rejected: expired } = partitionFreshTelemetry(queued)
  if (expired.length) {
    quarantineTelemetry(expired, 'event timestamp outside delivery window')
    const expiredIds = new Set(expired.map((event) => event.eventId))
    setTelemetryQueue(queued.filter((event) => !expiredIds.has(event.eventId)))
  }
  const batch = fresh.slice(0, 100).map((event) => {
    const validSession = typeof event.sessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.sessionId)
    return validSession ? event : { ...event, sessionId: randomUUID() }
  })
  if (!batch.length) return
  flushing = true
  try {
    const result = await sendTelemetryBatch(batch)
    if (result.ok) {
      const rejectedIds = new Set((result.data?.rejected || []).map((event) => event.event_id))
      const rejectedEvents = batch.filter((event) => rejectedIds.has(event.eventId))
      if (rejectedEvents.length) quarantineTelemetry(rejectedEvents, 'gateway rejected invalid event')
      const attempted = new Set(batch.map((event) => event.eventId))
      setTelemetryQueue(getTelemetryQueue().filter((event) => !attempted.has(event.eventId)))
    } else if (result.code === 'VALIDATION') {
      quarantineTelemetry(batch, result.error || 'gateway validation failed')
      const rejected = new Set(batch.map((event) => event.eventId))
      setTelemetryQueue(getTelemetryQueue().filter((event) => !rejected.has(event.eventId)))
    }
  } finally {
    flushing = false
  }
}

export function startTelemetry(): void {
  if (interval) clearInterval(interval)
  startedAt = Date.now()
  stopped = false
  recordTelemetry('app_opened', {
    app_version: app.getVersion(),
    arch: process.arch,
    os_major: process.getSystemVersion().split('.')[0],
    channel: app.isPackaged ? 'production' : 'development'
  })
  recordTelemetry('app_version_seen', { version: app.getVersion() })
  void flushTelemetry()
  interval = setInterval(() => void flushTelemetry(), 30_000)
  interval.unref()
}

export function stopTelemetry(): void {
  if (!stopped && startedAt) {
    stopped = true
    recordTelemetry('app_closed', {
      duration_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000))
    })
    void flushTelemetry()
  }
  if (interval) clearInterval(interval)
  interval = undefined
}
