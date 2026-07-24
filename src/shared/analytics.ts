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
  'book_analysis_started',
  'book_analysis_completed',
  'book_analysis_failed',
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
  'media_job_enqueued',
  'media_job_started',
  'media_job_completed',
  'media_job_failed',
  'media_job_cancelled',
  'tts_first_audio_ready',
  'tts_playback_started',
  'tts_playback_abandoned',
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
  'answer_feedback_submitted', 'book_analysis_started',
  'book_analysis_completed', 'book_analysis_failed', 'media_job_enqueued',
  'media_job_started', 'media_job_completed', 'media_job_failed',
  'media_job_cancelled', 'tts_first_audio_ready', 'tts_playback_started',
  'tts_playback_abandoned'
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
  'version',
  'analysis_version',
  'character_count_bucket',
  'pov',
  'confidence_bucket',
  'origin',
  'stage',
  'safe_error_code',
  'job_type',
  'provider',
  'model',
  'quality',
  'queue_depth_bucket',
  'queue_wait_bucket',
  'job_latency_bucket',
  'cache_hit',
  'result_size_bucket',
  'retry_count_bucket',
  'queue_or_running',
  'sample_rate',
  'first_audio_latency_bucket',
  'source',
  'listened_fraction_bucket'
])

/**
 * Properties are also scoped to an event. A global allow-list alone would
 * let a compromised renderer hide arbitrary strings in an unrelated field.
 */
export const ANALYTICS_EVENT_PROPERTIES: Record<AnalyticsEventName, ReadonlySet<string>> = {
  app_opened: new Set(['app_version', 'os_major', 'arch', 'channel']),
  app_closed: new Set(['duration_seconds']),
  book_import_started: new Set(['format', 'source_class', 'size_bucket']),
  book_import_completed: new Set(['format', 'source_class', 'size_bucket', 'chapter_count_bucket', 'duration_bucket']),
  book_import_failed: new Set(['format', 'source_class', 'size_bucket', 'error_code']),
  book_analysis_started: new Set(['analysis_version', 'origin']),
  book_analysis_completed: new Set([
    'analysis_version', 'character_count_bucket', 'duration_bucket', 'pov',
    'confidence_bucket', 'origin'
  ]),
  book_analysis_failed: new Set(['analysis_version', 'stage', 'safe_error_code', 'origin']),
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
  ai_request_started: new Set(['request_id', 'purpose', 'origin']),
  ai_request_completed: new Set(['request_id', 'purpose', 'route', 'latency_ms', 'success', 'origin']),
  ai_request_failed: new Set(['request_id', 'purpose', 'route', 'latency_ms', 'success', 'error_code', 'origin']),
  media_job_enqueued: new Set(['job_type', 'provider', 'model', 'quality', 'queue_depth_bucket', 'origin']),
  media_job_started: new Set(['job_type', 'queue_wait_bucket', 'origin']),
  media_job_completed: new Set([
    'job_type', 'job_latency_bucket', 'cache_hit', 'result_size_bucket', 'origin'
  ]),
  media_job_failed: new Set(['job_type', 'stage', 'safe_error_code', 'retry_count_bucket', 'origin']),
  media_job_cancelled: new Set(['job_type', 'queue_or_running', 'origin']),
  tts_first_audio_ready: new Set(['sample_rate', 'first_audio_latency_bucket', 'origin']),
  tts_playback_started: new Set(['source', 'cache_hit', 'origin']),
  tts_playback_abandoned: new Set(['source', 'listened_fraction_bucket', 'origin']),
  answer_feedback_submitted: new Set(['rating']),
  update_offered: new Set(['version']),
  update_downloaded: new Set(['version']),
  update_verified: new Set(['version', 'success', 'error_code']),
  update_installed: new Set(['version']),
  app_version_seen: new Set(['version'])
}

const ANALYTICS_PROPERTY_ENUMS: Readonly<Record<string, ReadonlySet<SafeAnalyticsValue>>> = {
  book_kind: new Set(['builtin', 'imported']),
  format: new Set(['epub', 'fb2', 'txt', 'pdf', 'html', 'unknown']),
  source_class: new Set(['file', 'url', 'builtin']),
  channel: new Set(['production', 'development', 'staging']),
  rating: new Set(['helpful', 'unhelpful']),
  feature: new Set(['bookmark', 'note', 'character', 'chat']),
  navigation_type: new Set(['reader', 'toc', 'next', 'previous']),
  duration_bucket: new Set(['<1s', '1-4s', '5-14s', '15-59s', '<1m', '1-4m', '5-14m', '15m+', '5m+']),
  size_bucket: new Set(['<1mb', '1-9mb', '10-39mb']),
  chapter_count_bucket: new Set(['1-3', '4-10', '11-25', '26+']),
  chapter_position_bucket: new Set(['1-3', '4-10', '11-25', '26+']),
  arch: new Set(['arm64', 'x64']),
  analysis_version: new Set(['v1']),
  character_count_bucket: new Set(['0', '1-3', '4-8', '9+']),
  pov: new Set(['first_person', 'third_person', 'unknown']),
  confidence_bucket: new Set(['low', 'medium', 'high', 'unknown']),
  origin: new Set(['user', 'background']),
  stage: new Set(['import', 'character_markup', 'chapter_markup', 'character_or_chapter_markup', 'provider', 'cache', 'playback']),
  job_type: new Set(['image', 'tts', 'avatar', 'portrait_animation', 'chapter_markup']),
  provider: new Set(['kandinsky', 'salutespeech', 'video', 'openrouter', 'browser']),
  model: new Set(['k6-image-t2i', 'salutespeech-yourvoice', 'k5-avatar', 'k5-i2v-lite', 'k5-i2v-hd', 'deepseek-v4-flash', 'unknown']),
  quality: new Set(['standard', 'lite', 'hd', '24000', '48000', 'unknown']),
  queue_depth_bucket: new Set(['0', '1-4', '5-9', '10+']),
  queue_wait_bucket: new Set(['<1s', '1-4s', '5-14s', '15s+']),
  job_latency_bucket: new Set(['<1s', '1-4s', '5-14s', '15-59s', '1-4m', '5m+']),
  result_size_bucket: new Set(['<256kb', '256kb-1mb', '1-9mb', '10mb+']),
  retry_count_bucket: new Set(['0', '1', '2+']),
  queue_or_running: new Set(['queue', 'running']),
  sample_rate: new Set([24000, 48000]),
  first_audio_latency_bucket: new Set(['<1s', '1-4s', '5-14s', '15s+']),
  source: new Set(['reader', 'character', 'chat']),
  listened_fraction_bucket: new Set(['<10%', '10-49%', '50-89%', '90%+']),
  safe_error_code: new Set(['UNKNOWN', 'VALIDATION', 'NETWORK', 'AUTH', 'TIMEOUT', 'RATE', 'NO_KEY', 'NO_PROXY', 'PARSE', 'CENSOR', 'CANCELLED']),
  error_code: new Set(['UNKNOWN', 'VALIDATION', 'NETWORK', 'AUTH', 'TIMEOUT', 'RATE', 'NO_KEY', 'NO_PROXY', 'PARSE', 'CENSOR', 'CANCELLED'])
}

function validAnalyticsValue(key: string, value: SafeAnalyticsValue): boolean {
  if (value === null) return true
  if (typeof value === 'string' && (value.length > 120 || value.includes('\n'))) return false
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 1_000_000_000)) return false
  if (!['string', 'number', 'boolean'].includes(typeof value)) return false
  const allowedValues = ANALYTICS_PROPERTY_ENUMS[key]
  if (allowedValues && !allowedValues.has(value)) return false
  if (
    ['error_code', 'safe_error_code', 'version', 'app_version'].includes(key) &&
    (typeof value !== 'string' || !/^[A-Za-z0-9_.+-]{1,80}$/.test(value))
  ) return false
  if (key === 'os_major' && (typeof value !== 'string' || !/^\d{1,3}$/.test(value))) return false
  return true
}

/**
 * Renderer input is untrusted. Reject the whole property object before it can
 * enter the local queue; silently dropping only a key would still permit
 * malformed/covert events to cross the process boundary.
 */
export function validRendererAnalyticsProperties(
  eventName: AnalyticsEventName,
  properties: Record<string, SafeAnalyticsValue>
): boolean {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false
  const eventProperties = ANALYTICS_EVENT_PROPERTIES[eventName]
  return Object.entries(properties).every(([key, value]) =>
    value !== null &&
    ANALYTICS_PROPERTY_ALLOWLIST.has(key) &&
    eventProperties.has(key) &&
    validAnalyticsValue(key, value)
  )
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
      return validAnalyticsValue(key, value)
    })
  )
}
