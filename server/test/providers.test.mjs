import assert from 'node:assert/strict'
import test from 'node:test'
import { requestChat, routeForPurpose } from '../providers.mjs'

test('provider route is selected only from server environment', () => {
  const route = routeForPurpose('summary', {
    LLM_ROUTE_SUMMARY: 'openrouter',
    LLM_FALLBACK_SUMMARY: 'giga'
  })
  assert.deepEqual(route, ['openrouter', 'giga'])
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
