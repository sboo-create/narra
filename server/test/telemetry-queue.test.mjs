import assert from 'node:assert/strict'
import test from 'node:test'
import { boundedTelemetryQueue, partitionFreshTelemetry } from '../../src/main/telemetry-queue.ts'

const event = (id, name, occurredAt = new Date().toISOString()) => ({ eventId: id, name, occurredAt })

test('extended overflow cannot evict older essential telemetry', () => {
  const essential = event('essential', 'app_opened')
  const events = [essential, ...Array.from({ length: 700 }, (_, index) => event(`extended-${index}`, 'chapter_changed'))]
  const bounded = boundedTelemetryQueue(events, (name) => name === 'app_opened', 500)
  assert.equal(bounded.length, 500)
  assert.ok(bounded.includes(essential))
  assert.equal(bounded.filter((item) => item.name === 'chapter_changed').length, 499)
})

test('expired poison telemetry is separated without dropping a fresh essential event', () => {
  const now = Date.now()
  const old = event('old', 'chapter_changed', new Date(now - 32 * 86400_000).toISOString())
  const fresh = event('fresh', 'book_opened', new Date(now - 1000).toISOString())
  const result = partitionFreshTelemetry([old, fresh], now)
  assert.deepEqual(result.rejected, [old])
  assert.deepEqual(result.fresh, [fresh])
})
