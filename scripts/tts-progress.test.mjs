import assert from 'node:assert/strict'
import test from 'node:test'
import { CoalescedTaskMap } from '../src/shared/coalesced-task.ts'
import { listenedFraction } from '../src/shared/playback-progress.ts'

test('in-flight TTS cache coalesces duplicate requests for one segment', async () => {
  const cache = new CoalescedTaskMap()
  let calls = 0
  let resolve
  const create = () => {
    calls += 1
    return new Promise((done) => {
      resolve = done
    })
  }
  const first = cache.getOrCreate(1, create)
  const second = cache.getOrCreate(1, create)
  assert.equal(first, second)
  assert.equal(calls, 1)
  resolve('audio')
  assert.equal(await second, 'audio')
})

test('rejected TTS synthesis is evicted so a later attempt can retry', async () => {
  const cache = new CoalescedTaskMap()
  let calls = 0
  await assert.rejects(
    cache.getOrCreate(1, async () => {
      calls += 1
      throw new Error('temporary upstream failure')
    }),
    /temporary upstream failure/
  )
  await Promise.resolve()
  assert.equal(await cache.getOrCreate(1, async () => {
    calls += 1
    return 'audio'
  }), 'audio')
  assert.equal(calls, 2)
})

test('one second of a long one-segment chapter is not reported as 100 percent', () => {
  assert.equal(listenedFraction(0, 1_000, 0.01, 1_000), 0.01)
  assert.equal(listenedFraction(500, 500, 0.5, 1_000), 0.75)
  assert.equal(listenedFraction(1_000, 100, 1, 1_000), 1)
})
