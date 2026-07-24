import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sanitizeAnalyticsProperties,
  validRendererAnalyticsProperties
} from '../src/shared/analytics.ts'

test('renderer telemetry rejects covert content in every new string enum', () => {
  const cases = [
    ['media_job_enqueued', 'job_type'],
    ['media_job_enqueued', 'provider'],
    ['media_job_enqueued', 'model'],
    ['media_job_enqueued', 'quality'],
    ['media_job_enqueued', 'origin'],
    ['media_job_failed', 'stage'],
    ['media_job_failed', 'safe_error_code'],
    ['media_job_failed', 'retry_count_bucket'],
    ['tts_first_audio_ready', 'first_audio_latency_bucket'],
    ['tts_playback_started', 'source'],
    ['tts_playback_abandoned', 'listened_fraction_bucket']
  ]
  for (const [event, property] of cases) {
    assert.equal(
      validRendererAnalyticsProperties(event, { [property]: 'PRIVATE_BOOK_TEXT' }),
      false,
      `${event}.${property}`
    )
    assert.deepEqual(
      sanitizeAnalyticsProperties({ [property]: 'PRIVATE_BOOK_TEXT' }, event),
      {},
      `${event}.${property} sanitizer`
    )
  }
})

test('renderer telemetry accepts the closed media bucket contract', () => {
  assert.equal(validRendererAnalyticsProperties('media_job_completed', {
    job_type: 'tts',
    job_latency_bucket: '1-4s',
    cache_hit: true,
    result_size_bucket: '256kb-1mb',
    origin: 'user'
  }), true)
  assert.equal(validRendererAnalyticsProperties('tts_first_audio_ready', {
    sample_rate: 48000,
    first_audio_latency_bucket: '1-4s',
    origin: 'user'
  }), true)
})

test('renderer telemetry rejects null values before they can poison a batch', () => {
  assert.equal(validRendererAnalyticsProperties('media_job_completed', {
    job_type: 'image',
    job_latency_bucket: null,
    cache_hit: false,
    result_size_bucket: '<256kb',
    origin: 'user'
  }), false)
})
