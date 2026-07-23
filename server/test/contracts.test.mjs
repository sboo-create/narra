import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseAvatarBody,
  parseChatBody,
  parseImageBody,
  parsePortraitBody,
  parseSynthesisBody
} from '../contracts.mjs'
import { parseEventBatch } from '../events.mjs'

test('chat contract accepts purpose but rejects client-selected provider', () => {
  const parsed = parseChatBody({
    messages: [{ role: 'user', content: 'hello' }],
    purpose: 'summary',
    temperature: 0.2
  })
  assert.equal(parsed.purpose, 'summary')
  assert.throws(
    () => parseChatBody({ messages: [{ role: 'user', content: 'hello' }], provider: 'openrouter' }),
    /неизвестное поле/
  )
})

test('chat contract bounds payload and roles', () => {
  assert.throws(() => parseChatBody({ messages: [] }), /1–64/)
  assert.throws(
    () => parseChatBody({ messages: [{ role: 'tool', content: 'hello' }] }),
    /недопустимая роль/
  )
  assert.throws(
    () => parseChatBody({ messages: [{ role: 'user', content: 'x'.repeat(60_001) }] }),
    /длиной/
  )
})

test('media and speech contracts reject unknown or oversized inputs', () => {
  assert.deepEqual(parseImageBody({ prompt: 'scene' }), {
    prompt: 'scene', width: 768, height: 1024, engine: undefined
  })
  assert.throws(() => parseImageBody({ prompt: 'scene', provider: 'x' }), /неизвестное поле/)
  assert.throws(() => parseSynthesisBody({ text: 'a', ssml: '<speak>a</speak>' }), /ровно одно/)
  assert.equal(parseSynthesisBody({ text: 'hello', voice: 'Nec' }).voice, 'Nec')
  assert.equal(parseAvatarBody({ image: 'a', audio: 'b' }).image, 'a')
  assert.throws(() => parsePortraitBody({ image: 'a', quality: '4k' }), /lite или hd/)
})

test('analytics accepts only allowlisted events and properties', () => {
  const event = {
    eventId: '123e4567-e89b-42d3-a456-426614174000',
    name: 'app_opened',
    occurredAt: new Date().toISOString(),
    schemaVersion: 1,
    properties: { app_version: '0.7.7', arch: 'arm64' }
  }
  assert.equal(parseEventBatch({ events: [event] })[0].event_name, 'app_opened')
  assert.throws(
    () => parseEventBatch({ events: [{ ...event, properties: { prompt: 'private text' } }] }),
    /properties.prompt/
  )
  assert.throws(
    () => parseEventBatch({ events: [{ ...event, name: 'button_clicked' }] }),
    /name/
  )
})
