import type { AnalyticsEvent, AnalyticsEventName } from '../shared/analytics'

export const TELEMETRY_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000
export const TELEMETRY_MAX_FUTURE_MS = 5 * 60 * 1000

/** Essential events always win capacity over extended high-volume events. */
export function boundedTelemetryQueue(
  events: AnalyticsEvent[],
  isEssential: (name: AnalyticsEventName) => boolean,
  limit = 500
): AnalyticsEvent[] {
  if (events.length <= limit) return events.slice()
  const essential = events.filter((event) => isEssential(event.name)).slice(-limit)
  const remaining = Math.max(0, limit - essential.length)
  const extended = remaining
    ? events.filter((event) => !isEssential(event.name)).slice(-remaining)
    : []
  const selected = new Set([...essential, ...extended])
  return events.filter((event) => selected.has(event))
}

export function partitionFreshTelemetry(
  events: AnalyticsEvent[],
  now = Date.now()
): { fresh: AnalyticsEvent[]; rejected: AnalyticsEvent[] } {
  const fresh: AnalyticsEvent[] = []
  const rejected: AnalyticsEvent[] = []
  for (const event of events) {
    const occurredAt = Date.parse(event?.occurredAt)
    if (
      !Number.isFinite(occurredAt) ||
      occurredAt < now - TELEMETRY_MAX_AGE_MS ||
      occurredAt > now + TELEMETRY_MAX_FUTURE_MS
    ) rejected.push(event)
    else fresh.push(event)
  }
  return { fresh, rejected }
}
