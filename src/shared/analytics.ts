/**
 * Privacy contract for Narra analytics.
 *
 * Event properties are deliberately closed: content, prompts, responses, titles,
 * filenames, URLs and media never belong in analytics payloads.
 */
export const ANALYTICS_SCHEMA_VERSION = 1 as const

export const ANALYTICS_EVENTS = [
  'app_opened',
  'app_closed',
  'book_import_started',
  'book_import_completed',
  'book_import_failed',
  'book_opened',
  'reading_session_started',
  'reading_session_qualified',
  'reading_session_ended',
  'chapter_changed',
  'chapter_completed',
  'bookmark_added',
  'note_added',
  'character_opened',
  'chat_opened',
  'ai_request_started',
  'ai_request_completed',
  'ai_request_failed',
  'answer_feedback_submitted',
  'update_offered',
  'update_downloaded',
  'update_verified',
  'update_installed',
  'app_version_seen'
] as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number]

export const RENDERER_ANALYTICS_EVENTS = new Set<AnalyticsEventName>([
  'book_opened', 'reading_session_started', 'reading_session_qualified',
  'reading_session_ended', 'chapter_changed', 'chapter_completed',
  'bookmark_added', 'note_added', 'character_opened', 'chat_opened',
  'answer_feedback_submitted'
])

export const ESSENTIAL_ANALYTICS_EVENTS = new Set<AnalyticsEventName>([
  'app_opened',
  'app_closed',
  'book_opened',
  'reading_session_qualified',
  'ai_request_started',
  'ai_request_completed',
  'ai_request_failed',
  'update_offered',
  'update_downloaded',
  'update_verified',
  'update_installed',
  'app_version_seen'
])

export function isEssentialAnalyticsEvent(name: AnalyticsEventName): boolean {
  return ESSENTIAL_ANALYTICS_EVENTS.has(name)
}

export type SafeAnalyticsValue = string | number | boolean | null

export interface AnalyticsEvent {
  eventId: string
  name: AnalyticsEventName
  occurredAt: string
  sessionId?: string
  properties: Record<string, SafeAnalyticsValue>
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION
}

export const ANALYTICS_PROPERTY_ALLOWLIST = new Set([
  'app_version',
  'os_major',
  'arch',
  'channel',
  'status',
  'duration_seconds',
  'duration_bucket',
  'book_kind',
  'format',
  'source_class',
  'size_bucket',
  'chapter_count_bucket',
  'error_code',
  'chapter_position_bucket',
  'navigation_type',
  'feature',
  'success',
  'request_id',
  'purpose',
  'route',
  'latency_ms',
  'rating',
  'version'
])

/**
 * Properties are also scoped to an event. A global allow-list alone would
 * let a compromised renderer hide arbitrary strings in an unrelated field.
 */
export const ANALYTICS_EVENT_PROPERTIES: Record<AnalyticsEventName, ReadonlySet<string>> = {
  app_opened: new Set(['app_version', 'os_major', 'arch', 'channel']),
  app_closed: new Set(['duration_seconds']),
  book_import_started: new Set(['format', 'source_class', 'size_bucket']),
  book_import_completed: new Set(['format', 'source_class', 'size_bucket', 'chapter_count_bucket']),
  book_import_failed: new Set(['format', 'source_class', 'size_bucket', 'error_code']),
  book_opened: new Set(['book_kind']),
  reading_session_started: new Set(['book_kind']),
  reading_session_qualified: new Set(['book_kind', 'duration_seconds', 'duration_bucket']),
  reading_session_ended: new Set(['book_kind', 'duration_seconds', 'duration_bucket']),
  chapter_changed: new Set(['chapter_position_bucket', 'navigation_type']),
  chapter_completed: new Set(['chapter_position_bucket']),
  bookmark_added: new Set(['feature']),
  note_added: new Set(['feature']),
  character_opened: new Set(['feature']),
  chat_opened: new Set(['feature']),
  ai_request_started: new Set(['request_id', 'purpose']),
  ai_request_completed: new Set(['request_id', 'purpose', 'route', 'latency_ms', 'success']),
  ai_request_failed: new Set(['request_id', 'purpose', 'route', 'latency_ms', 'success', 'error_code']),
  answer_feedback_submitted: new Set(['rating']),
  update_offered: new Set(['version']),
  update_downloaded: new Set(['version']),
  update_verified: new Set(['version', 'success', 'error_code']),
  update_installed: new Set(['version']),
  app_version_seen: new Set(['version'])
}

export function sanitizeAnalyticsProperties(
  properties: Record<string, SafeAnalyticsValue>,
  eventName?: AnalyticsEventName
): Record<string, SafeAnalyticsValue> {
  const eventProperties = eventName ? ANALYTICS_EVENT_PROPERTIES[eventName] : undefined
  return Object.fromEntries(
    Object.entries(properties).filter(([key, value]) => {
      if (!ANALYTICS_PROPERTY_ALLOWLIST.has(key)) return false
      if (eventProperties && !eventProperties.has(key)) return false
      if (typeof value === 'string' && value.length > 120) return false
      if (typeof value === 'number' && !Number.isFinite(value)) return false
      return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    })
  )
}
