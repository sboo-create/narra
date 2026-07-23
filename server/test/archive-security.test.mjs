import assert from 'node:assert/strict'
import test from 'node:test'
import { ArchiveByteQuota, validateArchiveEntry } from '../../src/main/archive-security.ts'

test('archive fixtures reject traversal, absolute paths and empty components', () => {
  for (const fixture of ['../', '../book.epub', '/tmp/book', 'C:/book', 'a//book', './book']) {
    assert.throws(() => validateArchiveEntry(fixture, 0, 1, 2_000), /unsafe|path|link|путь|ссылку/i)
  }
  assert.equal(validateArchiveEntry('OPS/chapter.xhtml', 0, 1, 2_000), 'OPS/chapter.xhtml')
})

test('archive fixtures reject symlink metadata and excessive entry count', () => {
  const symlinkAttributes = 0o120000 << 16
  assert.throws(() => validateArchiveEntry('OPS/link', symlinkAttributes, 1, 2_000))
  assert.throws(() => validateArchiveEntry('OPS/chapter.xhtml', 0, 2_001, 2_000))
})

test('streaming archive quota stops byte and compression-ratio bombs before full extraction', () => {
  const byteLimit = new ArchiveByteQuota(10, 100)
  byteLimit.add(6)
  assert.throws(() => byteLimit.add(5), /byte\/ratio/)
  const ratioLimit = new ArchiveByteQuota(100, 8)
  assert.throws(() => ratioLimit.add(9), /byte\/ratio/)
})
