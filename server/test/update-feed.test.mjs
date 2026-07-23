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
      PERSISTENT_DATA_MOUNT_PATH: dataDir,
      INSTALLATION_SINGLE_REPLICA_ACK: 'true',
      GATEWAY_TOKEN_SECRET: 'g'.repeat(32),
      INSTALLATION_SECRET_PEPPER: 'p'.repeat(32),
      ANALYTICS_HMAC_SECRET: 'a'.repeat(32),
      INSTALLATION_OPERATOR_TOKEN: 'o'.repeat(32),
      LLM_BASE_URL: 'https://llm.example',
      LLM_API_KEY: 'test',
      VIDEO_BASE_URL: 'https://127.0.0.1:1',
      SALUTESPEECH_AUTH_KEY: 'test',
      KANDINSKY_TOKEN: '',
      VIDEO_LIMIT_PER_HOUR: '1',
      REFRESH_LIMIT_PER_HOUR: '1',
      REFRESH_ATTEMPT_LIMIT_PER_HOUR: '1'
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
    assert.equal(protectedRoute.headers.get('x-narra-auth-error'), 'installation_token')
    const oversizedUnauthenticated = await fetch(`http://127.0.0.1:${port}/v2/media/avatar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'x'.repeat(2 * 1024 * 1024), audio: 'x' })
    })
    assert.equal(oversizedUnauthenticated.status, 401, 'auth must run before large body parsing')
    const installationId = '123e4567-e89b-42d3-a456-426614174000'
    const installationSecret = 's'.repeat(43)
    const missingInstallationId = '323e4567-e89b-42d3-a456-426614174000'
    const missingRefresh = await fetch(`http://127.0.0.1:${port}/v2/installations/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installation_id: missingInstallationId,
        installation_secret: installationSecret
      })
    })
    assert.equal(missingRefresh.status, 404)
    assert.equal(
      missingRefresh.headers.get('x-narra-auth-error'),
      'installation_not_found'
    )
    assert.equal((await missingRefresh.json()).code, 'INSTALLATION_NOT_FOUND')
    const reEnrolledAfterMissing = await fetch(
      `http://127.0.0.1:${port}/v2/installations/register`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installation_id: missingInstallationId,
          installation_secret: installationSecret
        })
      }
    )
    assert.equal(reEnrolledAfterMissing.status, 201)
    const registration = await fetch(`http://127.0.0.1:${port}/v2/installations/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installation_id: installationId,
        installation_secret: installationSecret
      })
    })
    assert.equal(registration.status, 201)
    const { token } = await registration.json()
    const stolenIdCannotRegister = await fetch(`http://127.0.0.1:${port}/v2/installations/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installation_id: installationId,
        installation_secret: 'x'.repeat(43)
      })
    })
    assert.equal(stolenIdCannotRegister.status, 403)
    const attackerRefresh = await fetch(`http://127.0.0.1:${port}/v2/installations/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.12'
      },
      body: JSON.stringify({
        installation_id: installationId,
        installation_secret: 'x'.repeat(43)
      })
    })
    assert.equal(attackerRefresh.status, 403)
    assert.equal(attackerRefresh.headers.get('x-narra-auth-error'), null)
    assert.equal((await attackerRefresh.json()).code, 'AUTH')
    const refreshed = await fetch(`http://127.0.0.1:${port}/v2/installations/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installation_id: installationId,
        installation_secret: installationSecret
      })
    })
    assert.equal(refreshed.status, 200)
    const successfulRefreshIsBounded = await fetch(
      `http://127.0.0.1:${port}/v2/installations/refresh`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.20'
        },
        body: JSON.stringify({
          installation_id: installationId,
          installation_secret: installationSecret
        })
      }
    )
    assert.equal(successfulRefreshIsBounded.status, 429)
    const variant = `http://127.0.0.1:${port}/v2/Media/Avatar/`
    const init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'x', audio: 'x' })
    }
    assert.notEqual((await fetch(variant, init)).status, 429)
    assert.equal((await fetch(variant, init)).status, 429, 'case/trailing-slash route must not bypass video quota')

    const revoked = await fetch(
      `http://127.0.0.1:${port}/v2/admin/installations/${installationId}/revoke`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${'o'.repeat(32)}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: 'test abuse' })
      }
    )
    assert.equal(revoked.status, 200)
    const revokedRefresh = await fetch(`http://127.0.0.1:${port}/v2/installations/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.30'
      },
      body: JSON.stringify({
        installation_id: installationId,
        installation_secret: installationSecret
      })
    })
    assert.equal(revokedRefresh.status, 403)
    assert.equal(revokedRefresh.headers.get('x-narra-auth-error'), null)
    assert.equal((await revokedRefresh.json()).code, 'REVOKED')
    const revokedBearer = await fetch(`http://127.0.0.1:${port}/v2/events/batch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [] })
      })
    assert.equal(
      revokedBearer.status,
      401,
      'revocation must invalidate an already-issued token immediately'
    )
    assert.equal(revokedBearer.headers.get('x-narra-auth-error'), 'installation_token')
  } finally {
    const exited = child.exitCode === null
      ? new Promise((resolve) => child.once('exit', resolve))
      : Promise.resolve()
    child.kill('SIGTERM')
    await exited
    await rm(dataDir, { recursive: true, force: true })
  }
})
