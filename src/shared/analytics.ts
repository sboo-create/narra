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

export function sanitizeAnalyticsProperties(
  properties: Record<string, SafeAnalyticsValue>
): Record<string, SafeAnalyticsValue> {
  return Object.fromEntries(
    Object.entries(properties).filter(([key, value]) => {
      if (!ANALYTICS_PROPERTY_ALLOWLIST.has(key)) return false
      if (typeof value === 'string' && value.length > 120) return false
      return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    })
  )
}
