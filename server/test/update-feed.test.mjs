import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

test('generic update feed is public while other v2 routes require bearer auth', async () => {
  const port = await freePort()
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'narra-server-update-'))
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      DATA_DIR: dataDir,
      GATEWAY_TOKEN_SECRET: 'g'.repeat(32),
      ANALYTICS_HMAC_SECRET: 'a'.repeat(32),
      REGISTRATION_ACTIVATION_SECRET: 'r'.repeat(32),
      LLM_BASE_URL: 'https://llm.example',
      LLM_API_KEY: 'test',
      VIDEO_BASE_URL: 'https://127.0.0.1:1',
      SALUTESPEECH_AUTH_KEY: 'test',
      KANDINSKY_TOKEN: '',
      VIDEO_LIMIT_PER_HOUR: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  try {
    const deadline = Date.now() + 5_000
    let healthy = false
    while (!healthy && Date.now() < deadline) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    assert.ok(healthy, 'gateway did not start')
    const update = await fetch(`http://127.0.0.1:${port}/v2/updates/files/not-present.yml`)
    assert.equal(update.status, 404, 'update feed must be reachable without bearer auth')
    const protectedRoute = await fetch(`http://127.0.0.1:${port}/v2/import/fetch?url=https://ficbook.net/x`)
    assert.equal(protectedRoute.status, 401)
    const oversizedUnauthenticated = await fetch(`http://127.0.0.1:${port}/v2/media/avatar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'x'.repeat(2 * 1024 * 1024), audio: 'x' })
    })
    assert.equal(oversizedUnauthenticated.status, 401, 'auth must run before large body parsing')
    const installationId = '123e4567-e89b-42d3-a456-426614174000'
    const registration = await fetch(`http://127.0.0.1:${port}/v2/installations/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installation_id: installationId, activation_token: 'r'.repeat(32) })
    })
    const { token } = await registration.json()
    const variant = `http://127.0.0.1:${port}/v2/Media/Avatar/`
    const init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'x', audio: 'x' })
    }
    assert.notEqual((await fetch(variant, init)).status, 429)
    assert.equal((await fetch(variant, init)).status, 429, 'case/trailing-slash route must not bypass video quota')
  } finally {
    const exited = child.exitCode === null
      ? new Promise((resolve) => child.once('exit', resolve))
      : Promise.resolve()
    child.kill('SIGTERM')
    await exited
    await rm(dataDir, { recursive: true, force: true })
  }
})
