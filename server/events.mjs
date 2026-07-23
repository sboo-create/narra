export const EVENT_NAMES = new Set([
  'app_opened', 'app_closed', 'book_import_started', 'book_import_completed',
  'book_import_failed', 'book_opened', 'reading_session_started',
  'reading_session_qualified', 'reading_session_ended', 'chapter_changed',
  'chapter_completed', 'bookmark_added', 'note_added', 'character_opened',
  'chat_opened', 'ai_request_started', 'ai_request_completed', 'ai_request_failed',
  'answer_feedback_submitted', 'update_offered', 'update_downloaded',
  'update_verified', 'update_installed', 'app_version_seen'
])

export const PROPERTY_NAMES = new Set([
  'app_version', 'os_major', 'arch', 'channel', 'status', 'duration_seconds',
  'duration_bucket', 'book_kind', 'format', 'source_class', 'size_bucket',
  'chapter_count_bucket', 'error_code', 'chapter_position_bucket',
  'navigation_type', 'feature', 'success', 'request_id', 'purpose', 'route',
  'latency_ms', 'rating', 'version'
])

function invalid(message) {
  const error = new Error(message)
  error.status = 400
  error.code = 'VALIDATION'
  throw error
}

export function parseEventBatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('body: нужен объект')
  if (Object.keys(input).some((key) => key !== 'events')) invalid('body: неизвестное поле')
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 100) {
    invalid('events: нужен массив из 1–100 событий')
  }
  return input.events.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) invalid(`events[${index}]: нужен объект`)
    const allowed = new Set(['eventId', 'name', 'occurredAt', 'sessionId', 'properties', 'schemaVersion'])
    if (Object.keys(event).some((key) => !allowed.has(key))) invalid(`events[${index}]: неизвестное поле`)
    if (!/^[0-9a-f-]{36}$/i.test(String(event.eventId || ''))) invalid(`events[${index}].eventId`)
    if (!EVENT_NAMES.has(event.name)) invalid(`events[${index}].name`)
    const occurredAt = new Date(event.occurredAt)
    if (!Number.isFinite(occurredAt.getTime())) invalid(`events[${index}].occurredAt`)
    if (Math.abs(Date.now() - occurredAt.getTime()) > 7 * 24 * 60 * 60 * 1000) invalid(`events[${index}].occurredAt вне окна`)
    if (event.schemaVersion !== 1) invalid(`events[${index}].schemaVersion`)
    if (!event.properties || typeof event.properties !== 'object' || Array.isArray(event.properties)) {
      invalid(`events[${index}].properties`)
    }
    const properties = {}
    for (const [key, value] of Object.entries(event.properties)) {
      if (!PROPERTY_NAMES.has(key)) invalid(`events[${index}].properties.${key}`)
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) invalid(`events[${index}].properties.${key}`)
      if (typeof value === 'string' && value.length > 120) invalid(`events[${index}].properties.${key}`)
      properties[key] = value
    }
    return {
      event_id: event.eventId,
      event_name: event.name,
      occurred_at: occurredAt.toISOString(),
      session_id: event.sessionId || null,
      schema_version: 1,
      properties
    }
  })
}
