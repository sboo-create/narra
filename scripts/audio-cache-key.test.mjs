import assert from 'node:assert/strict'
import test from 'node:test'
import { versionedAudioCacheKey } from '../src/main/audio-cache-key.ts'

test('TTS cache key changes with voice and rendered content', () => {
  const base = versionedAudioCacheKey('chapter-1-segment-1', { ssml: '<speak>Привет</speak>', voice: 'Che' })
  const otherVoice = versionedAudioCacheKey('chapter-1-segment-1', { ssml: '<speak>Привет</speak>', voice: 'She' })
  const otherText = versionedAudioCacheKey('chapter-1-segment-1', { ssml: '<speak>Пока</speak>', voice: 'Che' })

  assert.notEqual(base, otherVoice)
  assert.notEqual(base, otherText)
  assert.match(base, /^[a-zA-Z0-9_-]+$/)
  assert.ok(base.length <= 180)
})

test('TTS cache key rejects unsafe base keys', () => {
  assert.throws(
    () => versionedAudioCacheKey('../chapter', { text: 'Привет', voice: 'Che' }),
    /Некорректный ключ/
  )
  assert.throws(
    () => versionedAudioCacheKey('chapter', { text: 'Привет', voice: 'Nec' }),
    /Неподдерживаемый голос/
  )
})
