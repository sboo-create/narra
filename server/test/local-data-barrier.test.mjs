import assert from 'node:assert/strict'
import test from 'node:test'
import { beginLocalDataReset, runLocalDataWrite } from '../../src/main/local-data-barrier.ts'

test('delete-all waits for admitted writes and rejects every later writer', async () => {
  let release
  let resetFinished = false
  const admitted = runLocalDataWrite(() => new Promise((resolve) => { release = resolve }))
  const reset = beginLocalDataReset().then(() => { resetFinished = true })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(resetFinished, false)
  await assert.rejects(runLocalDataWrite(async () => undefined), /reset in progress/)
  release()
  await admitted
  await reset
  assert.equal(resetFinished, true)
})
