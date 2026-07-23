import assert from 'node:assert/strict'
import test from 'node:test'
import { analyticsRoute, completionProperties, providerAttemptProperties } from '../analytics-properties.mjs'

test('provider attempt analytics never emits null or invalid identifiers', () => {
  assert.deepEqual(providerAttemptProperties('123e4567-e89b-42d3-a456-426614174001', 'summary', {
    provider: 'openrouter', model: '', status: 'not_configured', retry_index: 0
  }), {
    request_id: '123e4567-e89b-42d3-a456-426614174001',
    purpose: 'summary', provider: 'openrouter', model: 'unreported', retry_index: 0, error_code: 'NO_KEY'
  })
})

test('completion analytics coerces valid numeric usage and omits poison values', () => {
  const result = completionProperties({
    requestId: '123e4567-e89b-42d3-a456-426614174001', purpose: 'summary',
    provider: 'openrouter', model: 'vendor/model:free', latencyMs: 12,
    usage: { prompt_tokens: '10', completion_tokens: -1, total_tokens: 'bad', cost: '0.25' }
  })
  assert.equal(result.route, 'openrouter:vendor/model:free')
  assert.equal(result.input_tokens, 10)
  assert.equal(result.exact_cost, 0.25)
  assert.ok(!('output_tokens' in result))
  assert.ok(!('total_tokens' in result))
  assert.equal(analyticsRoute('provider', 'model with spaces'), 'provider:unreported')
})
