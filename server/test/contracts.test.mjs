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
  assert.throws(
    () => parseChatBody({ messages: [{ role: 'user', content: 'hello' }], request_id: 'private-text' }),
    /UUID v4/
  )
  assert.equal(
    parseChatBody({ messages: [{ role: 'user', content: 'hello' }], request_id: '123e4567-e89b-42d3-a456-426614174001' }).requestId,
    '123e4567-e89b-42d3-a456-426614174001'
  )
})

test('media and speech contracts reject unknown or oversized inputs', () => {
  assert.deepEqual(parseImageBody({ prompt: 'scene' }), {
    prompt: 'scene', width: 768, height: 1024, engine: undefined
  })
  assert.throws(() => parseImageBody({ prompt: 'scene', provider: 'x' }), /неизвестное поле/)
  assert.throws(() => parseSynthesisBody({ text: 'a', ssml: '<speak>a</speak>' }), /ровно одно/)
  assert.deepEqual(parseSynthesisBody({ text: 'hello', voice: 'Che' }), {
    text: 'hello',
    ssml: undefined,
    voice: 'Che',
    providerVoice: 'Che_48000',
    sampleRate: 48000
  })
  assert.deepEqual(parseSynthesisBody({ text: 'hello', voice: 'Ana' }), {
    text: 'hello',
    ssml: undefined,
    voice: 'Ana',
    providerVoice: 'Ana_24000',
    sampleRate: 24000
  })
  assert.throws(() => parseSynthesisBody({ text: 'hello', voice: 'Nec' }), /не поддерживается/)
  assert.throws(() => parseSynthesisBody({ text: 'hello', voice: 'Che_24000' }), /не поддерживается/)
  assert.equal(parseAvatarBody({ image: 'a', audio: 'b' }).image, 'a')
  assert.throws(() => parsePortraitBody({ image: 'a', quality: '4k' }), /lite или hd/)
})

test('analytics accepts only allowlisted events and properties', () => {
  const event = {
    eventId: '123e4567-e89b-42d3-a456-426614174000',
    name: 'app_opened',
    occurredAt: new Date().toISOString(),
    sessionId: '123e4567-e89b-42d3-a456-426614174001',
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
  assert.throws(
    () => parseEventBatch({ events: [{ ...event, name: 'ai_request_completed', properties: {} }] }),
    /name/
  )
  assert.throws(
    () => parseEventBatch({ events: [{ ...event, sessionId: { private: 'text' } }] }),
    /sessionId/
  )
  assert.throws(
    () => parseEventBatch({ events: [{ ...event, properties: { route: 'covert content' } }] }),
    /не разрешено/
  )
  const offline = { ...event, eventId: '223e4567-e89b-42d3-a456-426614174000', occurredAt: new Date(Date.now() - 30 * 86400_000).toISOString() }
  assert.equal(parseEventBatch({ events: [offline] })[0].event_id, offline.eventId)
})

test('analytics error codes are closed enums and cannot carry content', () => {
  const event = {
    eventId: '123e4567-e89b-42d3-a456-426614174099',
    name: 'book_import_failed',
    occurredAt: new Date().toISOString(),
    sessionId: '123e4567-e89b-42d3-a456-426614174001',
    schemaVersion: 1,
    properties: { format: 'epub', source_class: 'file', error_code: 'private-text-fragment' }
  }
  assert.throws(() => parseEventBatch({ events: [event] }), /error_code/)
  event.properties.error_code = 'PARSE'
  assert.equal(parseEventBatch({ events: [event] })[0].properties.error_code, 'PARSE')
})
