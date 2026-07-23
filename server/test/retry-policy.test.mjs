import assert from 'node:assert/strict'
import test from 'node:test'
import { imageUpstreamError, shouldFallbackAfterImageError } from '../image-policy.mjs'
import { shouldRetryKandinsky, videoRetryDelay } from '../retry-policy.mjs'

test('Kandinsky censorship is terminal and only rate limits are retried', () => {
  assert.equal(shouldRetryKandinsky({ code: 'RATE' }), true)
  assert.equal(shouldRetryKandinsky({ code: 'CENSOR' }), false)
  assert.equal(shouldRetryKandinsky({ code: 'AUTH' }), false)
})

test('provider fallback never bypasses an image censorship decision', () => {
  assert.equal(shouldFallbackAfterImageError({ code: 'CENSOR' }), false)
  assert.equal(shouldFallbackAfterImageError({ code: 'VALIDATION' }), false)
  assert.equal(shouldFallbackAfterImageError({ code: 'UNKNOWN' }), false)
  assert.equal(shouldFallbackAfterImageError({ code: 'RATE' }), true)
  assert.equal(shouldFallbackAfterImageError({ code: 'NETWORK' }), true)
})

test('image moderation is terminal at Kandinsky create, status and result phases', () => {
  assert.equal(imageUpstreamError({
    provider: 'Kandinsky', phase: 'create', status: 422, detail: '{"bad_text_lemmas":[]}'
  }).code, 'CENSOR')
  assert.equal(imageUpstreamError({
    provider: 'Kandinsky', phase: 'status', detail: 'failed: blocked by censor'
  }).code, 'CENSOR')
  assert.equal(imageUpstreamError({
    provider: 'Kandinsky', phase: 'result', status: 422
  }).code, 'CENSOR')
})

test('Giga moderation and shared-request 4xx never qualify for provider fallback', () => {
  const moderated = imageUpstreamError({
    provider: 'GigaChat Image', phase: 'create', status: 400, detail: 'safety policy violation'
  })
  const invalid = imageUpstreamError({
    provider: 'GigaChat Image', phase: 'create', status: 400, detail: 'invalid request'
  })
  assert.equal(moderated.code, 'CENSOR')
  assert.equal(invalid.code, 'VALIDATION')
  assert.equal(shouldFallbackAfterImageError(moderated), false)
  assert.equal(shouldFallbackAfterImageError(invalid), false)
})

test('video retries only explicit rate-limit conditions', () => {
  assert.equal(videoRetryDelay({ code: 'RATE', message: 'concurrent slots' }), 45_000)
  assert.equal(videoRetryDelay({ message: '429' }), 10_000)
  assert.equal(videoRetryDelay({ code: 'CENSOR' }), 0)
})
