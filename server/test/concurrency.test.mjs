import assert from 'node:assert/strict'
import test from 'node:test'
import { createConcurrencyGate } from '../concurrency.mjs'

test('concurrency gate bounds active work and queue', async () => {
  const gate = createConcurrencyGate({ limit: 1, queueLimit: 1, name: 'test' })
  const first = await gate.acquire()
  const secondPromise = gate.acquire()
  await assert.rejects(() => gate.acquire(), /очередь переполнена/)
  assert.deepEqual(gate.status(), { active: 1, waiting: 1, limit: 1, queue_limit: 1 })
  first()
  const second = await secondPromise
  assert.equal(gate.status().active, 1)
  second()
  assert.equal(gate.status().active, 0)
})

test('aborted queued work is removed', async () => {
  const gate = createConcurrencyGate({ limit: 1, queueLimit: 1, name: 'test' })
  const release = await gate.acquire()
  const controller = new AbortController()
  const waiting = gate.acquire(controller.signal)
  controller.abort(new Error('stop'))
  await assert.rejects(() => waiting, /stop/)
  assert.equal(gate.status().waiting, 0)
  release()
})
