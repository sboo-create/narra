import assert from 'node:assert/strict'
import test from 'node:test'
import { progressiveChapterChunks } from '../src/shared/chapter-chunks.ts'

test('chapter bootstrap is small and remaining chunks stay bounded', () => {
  const paragraphs = Array.from(
    { length: 20 },
    (_, index) => `Абзац ${index + 1}. ${'слово '.repeat(80).trim()}`
  )
  const chunks = progressiveChapterChunks(paragraphs.join('\n\n'))
  assert.ok(chunks.length > 2)
  assert.ok(chunks[0].length <= 900)
  assert.ok(chunks.slice(1).every((chunk) => chunk.length <= 3500))
  const wordsBefore = paragraphs.join(' ').match(/[а-яё]+/gi)?.length
  const wordsAfter = chunks.join(' ').match(/[а-яё]+/gi)?.length
  assert.equal(wordsAfter, wordsBefore)
})

test('a single unbroken paragraph cannot create an oversized provider request', () => {
  const chunks = progressiveChapterChunks('а'.repeat(5_000))
  assert.deepEqual(chunks.map((chunk) => chunk.length), [900, 3500, 600])
  assert.equal(chunks.join('').replace(/\s/g, ''), 'а'.repeat(5_000))
})
