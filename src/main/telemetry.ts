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
import { getSettings, getTelemetryQueue, setTelemetryQueue } from './store'

let flushing = false
let interval: ReturnType<typeof setInterval> | undefined

export function recordTelemetry(
  name: AnalyticsEventName,
  properties: Record<string, SafeAnalyticsValue> = {}
): void {
  if (!isEssentialAnalyticsEvent(name) && !getSettings().extendedTelemetryEnabled) return
  const event: AnalyticsEvent = {
    eventId: randomUUID(),
    name,
    occurredAt: new Date().toISOString(),
    properties: sanitizeAnalyticsProperties(properties),
    schemaVersion: ANALYTICS_SCHEMA_VERSION
  }
  setTelemetryQueue([...getTelemetryQueue(), event])
}

export async function flushTelemetry(): Promise<void> {
  if (flushing) return
  const batch = getTelemetryQueue().slice(0, 100)
  if (!batch.length) return
  flushing = true
  try {
    const result = await sendTelemetryBatch(batch)
    if (result.ok) {
      const accepted = new Set(batch.map((event) => event.eventId))
      setTelemetryQueue(getTelemetryQueue().filter((event) => !accepted.has(event.eventId)))
    }
  } finally {
    flushing = false
  }
}

export function startTelemetry(): void {
  if (interval) clearInterval(interval)
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
  if (interval) clearInterval(interval)
  interval = undefined
}
