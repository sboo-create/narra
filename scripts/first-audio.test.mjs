import assert from 'node:assert/strict'
import test from 'node:test'
import { splitFirstAudioText } from '../src/shared/first-audio.ts'

test('first audio bootstrap stays within 150–300 characters when text is long', () => {
  const source = `${'Начало фразы '.repeat(18)}. ${'Продолжение '.repeat(40)}`
  const [first, rest] = splitFirstAudioText(source)
  assert.ok(first.length >= 150)
  assert.ok(first.length <= 300)
  assert.ok(rest)
  assert.equal(`${first} ${rest}`.replace(/\s+/g, ' '), source.trim().replace(/\s+/g, ' '))
})

test('short opening text remains one segment', () => {
  assert.deepEqual(splitFirstAudioText('Короткое начало.'), ['Короткое начало.'])
})
