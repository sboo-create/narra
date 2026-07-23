import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEventStore } from '../event-store.mjs'

function event(id) {
  return {
    event_id: id,
    event_name: 'book_opened',
    actor_id: 'actor',
    occurred_at: new Date().toISOString(),
    session_id: '123e4567-e89b-42d3-a456-426614174001',
    schema_version: 1,
    properties: { book_kind: 'builtin' }
  }
}

test('durable outbox retries safely and sends Traction envelope', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'narra-events-'))
  const requests = []
  let status = 503
  const store = createEventStore({
    dataDir: directory,
    tractionUrl: 'https://stats.example/events',
    tractionToken: 'secret',
    fetchImpl: async (_url, init) => {
      requests.push(init)
      return { ok: status === 200, status }
    }
  })
  await store.append([event('123e4567-e89b-42d3-a456-426614174010')])
  await store.drain()
  assert.ok(store.status().backlog_bytes > 0)
  status = 200
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  await store.drain()
  assert.equal(store.status().backlog_bytes, 0)
  const payload = JSON.parse(requests.at(-1).body)
  assert.equal(payload.events[0].device_id, 'actor')
  assert.equal(payload.events[0].name, 'book_opened')
  assert.equal(requests.at(-1).headers['X-Ingest-Token'], 'secret')
  assert.equal(requests.at(-1).headers['X-Analytics-Environment'], 'production')
})

test('outbox overflow is bounded and audit remains available for replay', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'narra-events-'))
  const store = createEventStore({ dataDir: directory, outboxMaxBytes: 1 })
  await store.append([event('323e4567-e89b-42d3-a456-426614174010')])
  assert.equal(store.status().overflow_events, 1)
  assert.equal(store.status().backlog_bytes, 0)
  assert.match(await readFile(store.file, 'utf8'), /book_opened/)
})

test('full outbox segments stay within stats ingest body and batch limits', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'narra-outbox-contract-'))
  const deliveries = []
  const store = createEventStore({
    dataDir,
    environment: 'test',
    tractionUrl: 'https://stats.example/events',
    tractionToken: 'test-token',
    fetchImpl: async (_url, init) => {
      const bytes = Buffer.byteLength(init.body)
      const payload = JSON.parse(init.body)
      assert.ok(bytes <= 512 * 1024, `ingest body exceeded stats limit: ${bytes}`)
      assert.ok(payload.events.length <= 100, `ingest batch exceeded contract: ${payload.events.length}`)
      deliveries.push({ bytes, count: payload.events.length })
      return { ok: true, status: 202 }
    },
    flushIntervalMs: 60_000
  })
  try {
    const events = Array.from({ length: 240 }, () => event(randomUUID()))
    await store.append(events)
    const deadline = Date.now() + 2_000
    while (deliveries.reduce((sum, delivery) => sum + delivery.count, 0) < 240 && Date.now() < deadline) {
      await store.drain()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(deliveries.reduce((sum, delivery) => sum + delivery.count, 0), 240)
    assert.ok(deliveries.length >= 3)
  } finally {
    await store.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('corrupted segment is quarantined and does not block later delivery', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'narra-outbox-corrupt-'))
  const delivered = []
  const store = createEventStore({
    dataDir,
    environment: 'test',
    tractionUrl: 'https://stats.example/events',
    tractionToken: 'test-token',
    fetchImpl: async (_url, init) => {
      delivered.push(...JSON.parse(init.body).events)
      return { ok: true, status: 202 }
    },
    flushIntervalMs: 60_000
  })
  try {
    await store.append([event(randomUUID())])
    await appendFile(store.currentOutbox, '{truncated\n')
    await store.drain()
    await store.append([event(randomUUID())])
    const deadline = Date.now() + 2_000
    while (delivered.length < 1 && Date.now() < deadline) {
      await store.drain()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(delivered.length, 1)
    assert.equal(store.status().dead_letter_segments, 1)
    assert.ok((await readdir(dataDir)).some((name) => name.startsWith('traction-dead-letter-test.')))
  } finally {
    await store.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('Traction envelope omits null provider properties rejected by stats schema', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'narra-outbox-null-'))
  let delivered
  const store = createEventStore({
    dataDir,
    environment: 'test',
    tractionUrl: 'https://stats.example/events',
    tractionToken: 'test-token',
    fetchImpl: async (_url, init) => {
      delivered = JSON.parse(init.body).events[0]
      return { ok: true, status: 202 }
    }
  })
  try {
    await store.append([{
      ...event(randomUUID()),
      event_name: 'provider_attempt_completed',
      properties: {
        request_id: randomUUID(), purpose: 'summary', provider: 'giga', model: 'giga',
        latency_ms: 10, http_status: 200, error_code: null
      }
    }])
    const deadline = Date.now() + 1_000
    while (!delivered && Date.now() < deadline) {
      await store.drain()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(delivered.name, 'provider_attempt_completed')
    assert.ok(!('error_code' in delivered.properties))
  } finally {
    await store.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('permanent validation failure is quarantined and does not block FIFO', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'narra-outbox-400-'))
  let calls = 0
  let delivered = 0
  const store = createEventStore({
    dataDir,
    environment: 'test',
    tractionUrl: 'https://stats.example/events',
    tractionToken: 'test-token',
    fetchImpl: async (_url, init) => {
      calls += 1
      if (calls === 1) return { ok: false, status: 400 }
      delivered += JSON.parse(init.body).events.length
      return { ok: true, status: 202 }
    }
  })
  try {
    await store.append([event(randomUUID())])
    await store.drain()
    await store.append([event(randomUUID())])
    const deadline = Date.now() + 1_000
    while (!delivered && Date.now() < deadline) {
      await store.drain()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(delivered, 1)
    assert.equal(store.status().dead_letter_segments, 1)
  } finally {
    await store.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('batch validation failure isolates one poison event and delivers valid neighbours', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'narra-outbox-bisect-'))
  const poisonId = randomUUID()
  const delivered = []
  const store = createEventStore({
    dataDir,
    environment: 'test',
    tractionUrl: 'https://stats.example/events',
    tractionToken: 'test-token',
    fetchImpl: async (_url, init) => {
      const events = JSON.parse(init.body).events
      if (events.some((candidate) => candidate.event_id === poisonId)) return { ok: false, status: 400 }
      delivered.push(...events)
      return { ok: true, status: 202 }
    },
    flushIntervalMs: 60_000
  })
  try {
    await store.append([event(randomUUID()), event(poisonId), event(randomUUID())])
    const deadline = Date.now() + 2_000
    while ((delivered.length < 2 || store.status().dead_letter_segments < 1) && Date.now() < deadline) {
      await store.drain()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(delivered.length, 2)
    assert.equal(store.status().dead_letter_segments, 1)
  } finally {
    await store.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('environment mismatch blocks FIFO for retry instead of poisoning the DLQ', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'narra-outbox-env-'))
  const store = createEventStore({
    dataDir,
    environment: 'staging',
    tractionUrl: 'https://stats.example/events',
    tractionToken: 'test-token',
    fetchImpl: async () => ({ ok: false, status: 409 }),
    flushIntervalMs: 60_000
  })
  try {
    await store.append([event(randomUUID()), event(randomUUID())])
    const deadline = Date.now() + 1_000
    while (!store.status().last_error && Date.now() < deadline) {
      await store.drain()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(store.status().backlog_bytes > 0)
    assert.equal(store.status().dead_letter_segments, 0)
    assert.match(store.status().last_error, /409/)
  } finally {
    await store.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('dead-letter storage is bounded and restored in health after restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'narra-outbox-dlq-bound-'))
  const options = {
    dataDir,
    environment: 'test',
    tractionUrl: 'https://stats.example/events',
    tractionToken: 'test-token',
    fetchImpl: async () => ({ ok: false, status: 400 }),
    deadLetterMaxFiles: 2,
    deadLetterMaxBytes: 4_096,
    flushIntervalMs: 60_000
  }
  const store = createEventStore(options)
  try {
    for (let index = 0; index < 4; index++) {
      await store.append([event(randomUUID())])
      const target = index + 1
      const deadline = Date.now() + 1_000
      while (store.status().dead_letter_segments < Math.min(target, 2) && Date.now() < deadline) {
        await store.drain()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    assert.ok(store.status().dead_letter_segments <= 2)
    assert.ok(store.status().dead_letter_bytes <= 4_096)
    await store.stop()
    const restarted = createEventStore(options)
    await restarted.append([])
    assert.equal(restarted.status().dead_letter_segments, store.status().dead_letter_segments)
    assert.equal(restarted.status().dead_letter_bytes, store.status().dead_letter_bytes)
    await restarted.stop()
  } finally {
    await store.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})
