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
  assert.equal(result.attempts.length, 2)
  assert.deepEqual(calls.map((call) => call.url), [
    'https://openrouter.test/v1/chat/completions',
    'https://giga.test/v1/chat/completions'
  ])
  assert.equal(calls.every((call) => call.body.provider === undefined), true)
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
  assert.deepEqual(result.attempts.map((attempt) => attempt.retry_index), [0, 1])
})
