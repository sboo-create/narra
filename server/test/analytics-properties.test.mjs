import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyticsRoute,
  completionProperties,
  createSseUsageCollector,
  providerAttemptProperties
} from '../analytics-properties.mjs'

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
  assert.equal(result.cost_currency, 'USD')
  assert.equal(result.cost_source, 'openrouter_usage')
  assert.ok(!('output_tokens' in result))
  assert.ok(!('total_tokens' in result))
  assert.equal(analyticsRoute('provider', 'model with spaces'), 'provider:unreported')
})

test('LiteLLM response header is used only as an exact fallback cost source', () => {
  const result = completionProperties({
    requestId: '123e4567-e89b-42d3-a456-426614174001', purpose: 'summary',
    provider: 'giga', model: 'giga', latencyMs: 12,
    usage: { prompt_tokens: 10, completion_tokens: 2 },
    responseCost: 0.125
  })
  assert.equal(result.exact_cost, 0.125)
  assert.equal(result.cost_currency, 'USD')
  assert.equal(result.cost_source, 'litellm_response_header')
})

test('stream usage collector handles split SSE chunks without retaining content', () => {
  const collector = createSseUsageCollector()
  collector.push(Buffer.from(': keepalive\n\ndata: {"choices":[{"delta":{"content":"private te'))
  collector.push(Buffer.from('xt"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":12,'))
  collector.push(Buffer.from('"completion_tokens":4,"total_tokens":16,"cost":0.01}}\n\ndata: [DONE]\n\n'))
  assert.deepEqual(collector.value(), {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    cost: 0.01
  })
})

for (const [name, payload, code] of [
  ['malformed JSON', 'data: {bad}\n\ndata: [DONE]\n\n', 'PARSE'],
  ['upstream error', 'data: {"error":{"code":"upstream_failure"}}\n\n', 'NETWORK'],
  ['missing terminal frame', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'PARSE'],
  ['content filter', 'data: {"choices":[{"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n', 'CENSOR']
]) {
  test(`stream usage collector rejects ${name}`, () => {
    const collector = createSseUsageCollector()
    assert.throws(
      () => {
        collector.push(Buffer.from(payload))
        collector.value()
      },
      (error) => error?.code === code
    )
  })
}
