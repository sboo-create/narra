export const EVENT_NAMES = new Set([
  'app_opened', 'app_closed', 'book_import_started', 'book_import_completed',
  'book_import_failed', 'book_opened', 'reading_session_started',
  'reading_session_qualified', 'reading_session_ended', 'chapter_changed',
  'chapter_completed', 'bookmark_added', 'note_added', 'character_opened',
  'chat_opened',
  'answer_feedback_submitted', 'update_offered', 'update_downloaded',
  'update_verified', 'update_installed', 'app_version_seen'
])

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ENUMS = new Map([
  ['book_kind', new Set(['builtin', 'imported'])],
  ['format', new Set(['epub', 'fb2', 'txt', 'html', 'unknown'])],
  ['source_class', new Set(['file', 'url', 'builtin'])],
  ['channel', new Set(['production', 'development', 'staging'])],
  ['rating', new Set(['helpful', 'unhelpful'])],
  ['feature', new Set(['bookmark', 'note', 'character', 'chat'])],
  ['navigation_type', new Set(['reader', 'toc', 'next', 'previous'])],
  ['duration_bucket', new Set(['<1m', '1-4m', '5-14m', '15m+'])],
  ['size_bucket', new Set(['<1mb', '1-9mb', '10-39mb'])],
  ['chapter_count_bucket', new Set(['1-3', '4-10', '11-25', '26+'])],
  ['chapter_position_bucket', new Set(['1-3', '4-10', '11-25', '26+'])],
  ['arch', new Set(['arm64', 'x64'])]
  ,['error_code', new Set(['UNKNOWN', 'VALIDATION', 'NETWORK', 'AUTH', 'TIMEOUT', 'RATE', 'NO_KEY', 'NO_PROXY', 'PARSE', 'CENSOR', 'CANCELLED'])]
])

export const PROPERTY_NAMES = new Set([
  'app_version', 'os_major', 'arch', 'channel', 'status', 'duration_seconds',
  'duration_bucket', 'book_kind', 'format', 'source_class', 'size_bucket',
  'chapter_count_bucket', 'error_code', 'chapter_position_bucket',
  'navigation_type', 'feature', 'success', 'request_id', 'purpose', 'route',
  'latency_ms', 'rating', 'version'
])

export const EVENT_PROPERTIES = new Map([
  ['app_opened', new Set(['app_version', 'os_major', 'arch', 'channel'])],
  ['app_closed', new Set(['duration_seconds'])],
  ['book_import_started', new Set(['format', 'source_class', 'size_bucket'])],
  ['book_import_completed', new Set(['format', 'source_class', 'size_bucket', 'chapter_count_bucket'])],
  ['book_import_failed', new Set(['format', 'source_class', 'size_bucket', 'error_code'])],
  ['book_opened', new Set(['book_kind'])],
  ['reading_session_started', new Set(['book_kind'])],
  ['reading_session_qualified', new Set(['book_kind', 'duration_seconds', 'duration_bucket'])],
  ['reading_session_ended', new Set(['book_kind', 'duration_seconds', 'duration_bucket'])],
  ['chapter_changed', new Set(['chapter_position_bucket', 'navigation_type'])],
  ['chapter_completed', new Set(['chapter_position_bucket'])],
  ['bookmark_added', new Set(['feature'])],
  ['note_added', new Set(['feature'])],
  ['character_opened', new Set(['feature'])],
  ['chat_opened', new Set(['feature'])],
  ['ai_request_started', new Set(['request_id', 'purpose'])],
  ['ai_request_completed', new Set(['request_id', 'purpose', 'route', 'latency_ms', 'success'])],
  ['ai_request_failed', new Set(['request_id', 'purpose', 'route', 'latency_ms', 'success', 'error_code'])],
  ['answer_feedback_submitted', new Set(['rating'])],
  ['update_offered', new Set(['version'])],
  ['update_downloaded', new Set(['version'])],
  ['update_verified', new Set(['version', 'success', 'error_code'])],
  ['update_installed', new Set(['version'])],
  ['app_version_seen', new Set(['version'])]
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
    if (!UUID_V4.test(String(event.eventId || ''))) invalid(`events[${index}].eventId`)
    if (!EVENT_NAMES.has(event.name)) invalid(`events[${index}].name`)
    const occurredAt = new Date(event.occurredAt)
    if (!Number.isFinite(occurredAt.getTime())) invalid(`events[${index}].occurredAt`)
    if (occurredAt.getTime() > Date.now() + 5 * 60 * 1000) invalid(`events[${index}].occurredAt из будущего`)
    if (occurredAt.getTime() < Date.now() - 31 * 24 * 60 * 60 * 1000) invalid(`events[${index}].occurredAt старше 31 дня`)
    if (event.schemaVersion !== 1) invalid(`events[${index}].schemaVersion`)
    if (typeof event.sessionId !== 'string' || !UUID_V4.test(event.sessionId)) {
      invalid(`events[${index}].sessionId`)
    }
    if (!event.properties || typeof event.properties !== 'object' || Array.isArray(event.properties)) {
      invalid(`events[${index}].properties`)
    }
    const properties = {}
    const allowedProperties = EVENT_PROPERTIES.get(event.name)
    for (const [key, value] of Object.entries(event.properties)) {
      if (!PROPERTY_NAMES.has(key)) invalid(`events[${index}].properties.${key}`)
      if (!allowedProperties?.has(key)) invalid(`events[${index}].properties.${key} не разрешено для ${event.name}`)
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) invalid(`events[${index}].properties.${key}`)
      if (typeof value === 'string' && value.length > 120) invalid(`events[${index}].properties.${key}`)
      if (typeof value === 'number' && !Number.isFinite(value)) invalid(`events[${index}].properties.${key}`)
      if (typeof value === 'number' && (value < 0 || value > 1_000_000_000)) invalid(`events[${index}].properties.${key}`)
      if (ENUMS.has(key) && !ENUMS.get(key).has(value)) invalid(`events[${index}].properties.${key}`)
      if (['error_code', 'version', 'app_version'].includes(key) && typeof value === 'string' && !/^[A-Za-z0-9_.+-]{1,80}$/.test(value)) {
        invalid(`events[${index}].properties.${key}`)
      }
      if (key === 'os_major' && (typeof value !== 'string' || !/^\d{1,3}$/.test(value))) invalid(`events[${index}].properties.${key}`)
      properties[key] = value
    }
    return {
      event_id: event.eventId,
      event_name: event.name,
      occurred_at: occurredAt.toISOString(),
      session_id: event.sessionId,
      schema_version: 1,
      properties
    }
  })
}
