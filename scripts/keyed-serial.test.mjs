import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedSerialQueue } from '../src/main/keyed-serial.ts'

test('save/delete mutations for one book cannot overtake each other', async () => {
  const queue = new KeyedSerialQueue()
  const order = []
  let releaseFirst
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  const first = queue.run('book-1', async () => {
    order.push('save:start')
    markStarted()
    await new Promise((resolve) => {
      releaseFirst = resolve
    })
    order.push('save:end')
  })
  const second = queue.run('book-1', async () => {
    order.push('delete')
  })
  await started
  assert.deepEqual(order, ['save:start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['save:start', 'save:end', 'delete'])
})

test('different books are not globally serialized', async () => {
  const queue = new KeyedSerialQueue()
  const order = []
  let release
  const first = queue.run('book-1', async () => {
    order.push('one:start')
    await new Promise((resolve) => {
      release = resolve
    })
  })
  const second = queue.run('book-2', async () => {
    order.push('two')
  })
  await second
  assert.deepEqual(order, ['one:start', 'two'])
  release()
  await first
})
