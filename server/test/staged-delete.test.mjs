import assert from 'node:assert/strict'
import * as realFs from 'node:fs/promises'
const { mkdtemp, readFile, readdir, rm, writeFile } = realFs
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cleanupStagedDeleteTombstones, stagedDeleteFiles } from '../../src/main/staged-delete.ts'

test('per-book delete restores staged files when associated cache cleanup fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'narra-staged-delete-'))
  const book = path.join(directory, 'book.json')
  const characters = path.join(directory, 'book-characters.json')
  await writeFile(book, 'book')
  await writeFile(characters, 'characters')
  try {
    await assert.rejects(
      stagedDeleteFiles([book, characters], async () => { throw new Error('cache denied') }),
      /cache denied/
    )
    assert.equal(await readFile(book, 'utf8'), 'book')
    assert.equal(await readFile(characters, 'utf8'), 'characters')
    assert.equal((await readdir(directory)).some((name) => name.includes('.deleting-')), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('per-book delete never restores originals after structured state commit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'narra-staged-delete-'))
  const book = path.join(directory, 'book.json')
  await writeFile(book, 'book')
  let state = 'old'
  let failed = false
  try {
    const characters = path.join(directory, 'book-characters.json')
    await writeFile(characters, 'characters')
    const deleted = await stagedDeleteFiles([book, characters], async () => {}, {
        commit: () => { state = 'cleared' },
        fileOps: {
          rename: realFs.rename,
          unlink: async (target) => {
            if (!failed && String(target).includes('book.json.deleting-')) {
              failed = true
              throw new Error('disk commit failed')
            }
            return realFs.unlink(target)
          }
        }
      })
    assert.equal(deleted.has(book), true)
    assert.equal(deleted.cleanupPending, true)
    assert.equal(state, 'cleared')
    await assert.rejects(readFile(book, 'utf8'), /ENOENT/)
    await assert.rejects(readFile(characters, 'utf8'), /ENOENT/)
    assert.equal(await cleanupStagedDeleteTombstones(directory), 0)
    assert.equal((await readdir(directory)).some((name) => name.includes('.deleting-')), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
