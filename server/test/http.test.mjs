import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { consumeResponse, createResponseBuffer } from '../http.mjs'

test('bounded upstream buffer rejects a binary response over its limit', () => {
  const buffer = createResponseBuffer({ binary: true, maxResponseBytes: 8 })
  buffer.push(Buffer.alloc(5))
  assert.throws(() => buffer.push(Buffer.alloc(4)), /exceeded the gateway limit/)
})

test('bounded upstream buffer returns content below its limit', () => {
  const buffer = createResponseBuffer({ binary: true, maxResponseBytes: 8 })
  buffer.push(Buffer.from('1234'))
  buffer.push(Buffer.from('5678'))
  assert.equal(buffer.value().toString('utf8'), '12345678')
})

test('oversized network response rejects once and destroys without an error event', async () => {
  class FakeResponse extends EventEmitter {
    statusCode = 200
    headers = {}
    destroyed = false

    setEncoding() {}

    destroy(error) {
      assert.equal(error, undefined)
      this.destroyed = true
      this.emit('close')
    }
  }

  const response = new FakeResponse()
  const result = consumeResponse(response, { binary: true, maxResponseBytes: 8 })
  response.emit('data', Buffer.alloc(9))

  await assert.rejects(result, (error) => {
    assert.equal(error.code, 'NETWORK')
    assert.equal(error.status, 502)
    return true
  })
  assert.equal(response.destroyed, true)
})
