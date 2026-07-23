import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSafeImportUrl, fetchWithRedirectPolicy, readBoundedBody } from '../safe-fetch.mjs'

const hosts = new Set(['example.test', 'download.example.test'])
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

test('import URL policy rejects protocol, host, port and private DNS answers', async () => {
  await assert.rejects(() => assertSafeImportUrl('http://example.test/a', hosts, publicLookup), /Хост/)
  await assert.rejects(() => assertSafeImportUrl('https://evil.test/a', hosts, publicLookup), /Хост/)
  await assert.rejects(() => assertSafeImportUrl('https://example.test:8443/a', hosts, publicLookup), /port/)
  await assert.rejects(
    () => assertSafeImportUrl('https://example.test/a', hosts, async () => [{ address: '127.0.0.1', family: 4 }]),
    /запрещён/
  )
})

test('every redirect is revalidated against the same policy', async () => {
  const responses = [
    new Response(null, { status: 302, headers: { location: 'https://download.example.test/file' } }),
    new Response('ok', { status: 200 })
  ]
  const result = await fetchWithRedirectPolicy('https://example.test/start', {
    allowedHosts: hosts,
    lookupImpl: publicLookup,
    fetchImpl: async () => responses.shift()
  })
  assert.equal(await result.text(), 'ok')

  await assert.rejects(
    () => fetchWithRedirectPolicy('https://example.test/start', {
      allowedHosts: hosts,
      lookupImpl: publicLookup,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/file' } })
    }),
    /Хост/
  )
})

test('streaming body limit stops oversized downloads', async () => {
  const response = new Response(new Uint8Array(12))
  await assert.rejects(() => readBoundedBody(response, 10), /больше/)
  const small = new Response(new Uint8Array([1, 2, 3]))
  assert.deepEqual(await readBoundedBody(small, 10), Buffer.from([1, 2, 3]))
})
