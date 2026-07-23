import assert from 'node:assert/strict'
import test from 'node:test'
import { llmRouteReadiness, requestChat, routeForPurpose } from '../providers.mjs'

test('provider route is selected only from server environment', () => {
  const route = routeForPurpose('summary', {
    LLM_ROUTE_SUMMARY: 'openrouter',
    LLM_FALLBACK_SUMMARY: 'giga'
  })
  assert.deepEqual(route, ['openrouter', 'giga'])
})

test('readiness requires a complete configured route for every purpose', () => {
  const broken = llmRouteReadiness({ OPENROUTER_API_KEY: 'key', LLM_ROUTE_DEFAULT: 'openrouter' })
  assert.equal(broken.ready, false)
  assert.equal(broken.purposes.summary.ready, false)
  const ready = llmRouteReadiness({
    LLM_ROUTE_DEFAULT: 'giga', LLM_BASE_URL: 'https://giga.test',
    LLM_API_KEY: 'key', LLM_MODEL: 'model'
  })
  assert.equal(ready.ready, true)
})

test('retryable primary failure falls back and keeps one request identity', async () => {
  const calls = []
  const events = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    if (calls.length === 1) return new Response('busy', { status: 429 })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
  const result = await requestChat({
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.2,
    purpose: 'summary',
    stream: false,
    requestId: 'request-1',
    fetchImpl,
    onAttempt: async (attempt) => events.push(attempt),
    env: {
      LLM_ROUTE_SUMMARY: 'openrouter',
      LLM_FALLBACK_SUMMARY: 'giga',
      OPENROUTER_BASE_URL: 'https://openrouter.test/v1',
      OPENROUTER_API_KEY: 'or-key',
      OPENROUTER_MODEL: 'or-model',
      LLM_BASE_URL: 'https://giga.test',
      LLM_API_KEY: 'giga-key',
      LLM_MODEL: 'giga-model'
    }
  })
  assert.equal(result.requestId, 'request-1')
  assert.equal(result.provider, 'giga')
  assert.equal(result.attempts.length, 1)
  await result.finalizeAttempt()
  assert.equal(result.attempts.length, 2)
  assert.deepEqual(events.map((attempt) => `${attempt.provider}:${attempt.status}`), [
    'openrouter:started',
    'openrouter:failed',
    'giga:started',
    'giga:completed'
  ])
  assert.equal(new Set(events.map((attempt) => attempt.event_id)).size, events.length)
  assert.equal(events[0].attempt_id, events[1].attempt_id)
  assert.equal(events[2].attempt_id, events[3].attempt_id)
  assert.deepEqual(calls.map((call) => call.url), [
    'https://openrouter.test/v1/chat/completions',
    'https://giga.test/v1/chat/completions'
  ])
  assert.deepEqual(calls[0].body.provider, { zdr: true, data_collection: 'deny' })
  assert.equal(calls[1].body.provider, undefined)
})

test('provider-local auth failure falls back to the configured secondary', async () => {
  let calls = 0
  const result = await requestChat({
    messages: [{ role: 'user', content: 'hello' }], purpose: 'summary', stream: false,
    fetchImpl: async () => {
      calls += 1
      return calls === 1
        ? new Response('expired key', { status: 401 })
        : new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 })
    },
    env: {
      LLM_ROUTE_SUMMARY: 'openrouter', LLM_FALLBACK_SUMMARY: 'giga',
      OPENROUTER_API_KEY: 'expired', OPENROUTER_MODEL: 'or-model',
      LLM_BASE_URL: 'https://giga.test', LLM_API_KEY: 'giga-key', LLM_MODEL: 'giga-model'
    }
  })
  assert.equal(result.provider, 'giga')
  assert.equal(calls, 2)
  await result.finalizeAttempt()
  assert.deepEqual(result.attempts.map((attempt) => attempt.retry_index), [0, 1])
})

test('Giga streaming requests usage and accepts an exact LiteLLM cost header', async () => {
  let body
  const result = await requestChat({
    messages: [{ role: 'user', content: 'hello' }],
    purpose: 'summary',
    stream: true,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'x-litellm-response-cost': '0.0125' }
      })
    },
    env: {
      LLM_ROUTE_SUMMARY: 'giga',
      LLM_BASE_URL: 'https://giga.test',
      LLM_API_KEY: 'giga-key',
      LLM_MODEL: 'giga-model'
    }
  })
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(result.responseCost, 0.0125)
  assert.equal(result.attempts.length, 0)
  await result.finalizeAttempt()
  await result.finalizeAttempt({ status: 'failed', error_code: 'NETWORK' })
  assert.deepEqual(result.attempts.map((attempt) => attempt.status), ['completed'])
})

for (const [name, response, expected] of [
  ['shared validation failure', new Response('invalid messages', { status: 400 }), 'VALIDATION'],
  ['moderation failure', new Response('content_filter blocked', { status: 422 }), 'CENSOR']
]) {
  test(`${name} is terminal and classified without fallback`, async () => {
    const events = []
    let calls = 0
    await assert.rejects(requestChat({
      messages: [{ role: 'user', content: 'hello' }],
      purpose: 'summary',
      stream: false,
      fetchImpl: async () => {
        calls += 1
        return response.clone()
      },
      onAttempt: async (attempt) => events.push(attempt),
      env: {
        LLM_ROUTE_SUMMARY: 'giga',
        LLM_FALLBACK_SUMMARY: 'openrouter',
        LLM_BASE_URL: 'https://giga.test',
        LLM_API_KEY: 'giga-key',
        LLM_MODEL: 'giga-model',
        OPENROUTER_API_KEY: 'or-key',
        OPENROUTER_MODEL: 'or-model'
      }
    }), (error) => error?.code === expected)
    assert.equal(calls, 1)
    assert.equal(events.at(-1).error_code, expected)
  })
}
