import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeOpenAiSse } from '../../src/main/api/sse-protocol.ts'

async function *chunks(...values) {
  for (const value of values) yield Buffer.from(value)
}

test('desktop SSE parser returns text only after a valid terminal frame', async () => {
  const deltas = []
  const text = await consumeOpenAiSse(chunks(
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ), (delta) => deltas.push(delta))
  assert.equal(text, 'hello')
  assert.deepEqual(deltas, ['hel', 'lo'])
})

for (const [name, stream, code] of [
  ['malformed JSON', chunks('data: {bad}\n\ndata: [DONE]\n\n'), 'PARSE'],
  ['missing terminal frame', chunks('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), 'PARSE'],
  ['gateway in-band error', chunks('event: error\ndata: {"error":{"code":"PARSE"}}\n\n'), 'PARSE'],
  ['content filter finish', chunks('data: {"choices":[{"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n'), 'CENSOR']
]) {
  test(`desktop SSE parser rejects ${name}`, async () => {
    await assert.rejects(
      consumeOpenAiSse(stream, () => {}),
      (error) => error?.code === code
    )
  })
}
