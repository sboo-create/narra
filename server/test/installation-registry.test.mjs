import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInstallationRegistry } from '../installation-registry.mjs'

const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000'
const SECOND_INSTALLATION_ID = '223e4567-e89b-42d3-a456-426614174000'
const SECRET_HASH = 'h'.repeat(43)
const OTHER_SECRET_HASH = 'x'.repeat(43)

async function temporaryRegistry(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'narra-installations-'))
  const registry = createInstallationRegistry({
    dataDir,
    environment: 'test',
    ...options
  })
  await registry.start()
  return { dataDir, registry }
}

test('registration persists, is idempotent and a revoked installation stays revoked after restart', async () => {
  let timestamp = Date.UTC(2026, 6, 24, 8)
  const { dataDir, registry } = await temporaryRegistry({ now: () => timestamp })
  try {
    const created = await registry.register({
      installationId: INSTALLATION_ID,
      refreshSecretHash: SECRET_HASH,
      appVersion: '0.7.7',
      platform: 'darwin',
      arch: 'arm64'
    })
    assert.equal(created.ok, true)
    assert.equal(created.created, true)
    const repeated = await registry.register({
      installationId: INSTALLATION_ID,
      refreshSecretHash: SECRET_HASH,
      appVersion: '0.7.8',
      platform: 'darwin',
      arch: 'arm64'
    })
    assert.equal(repeated.created, false)
    assert.equal(repeated.record.last_app_version, '0.7.8')
    assert.equal('refresh_secret_hash' in repeated.record, false)
    assert.equal((await registry.register({
      installationId: INSTALLATION_ID,
      refreshSecretHash: OTHER_SECRET_HASH
    })).code, 'INVALID_PROOF')
    assert.equal((await registry.refresh(INSTALLATION_ID, OTHER_SECRET_HASH)).code, 'INVALID_PROOF')

    await registry.revoke(INSTALLATION_ID, 'abuse')
    assert.equal(registry.authenticate({ sub: INSTALLATION_ID, ver: 1 }), null)

    timestamp += 1_000
    const restarted = createInstallationRegistry({
      dataDir,
      environment: 'test',
      now: () => timestamp
    })
    await restarted.start()
    assert.equal((await restarted.register({
      installationId: INSTALLATION_ID,
      refreshSecretHash: SECRET_HASH
    })).code, 'REVOKED')
    assert.equal(restarted.get(INSTALLATION_ID).revoke_reason, 'abuse')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('an installation reclaimed by GC can re-enroll but revoked or wrong proofs cannot', async () => {
  let timestamp = Date.UTC(2026, 6, 24, 8)
  const { dataDir, registry } = await temporaryRegistry({
    now: () => timestamp,
    maxInstallations: 2,
    registrationLimitPerHour: 10,
    registrationLimitPerDay: 10,
    inactiveRetentionDays: 1
  })
  try {
    assert.equal((await registry.register({
      installationId: INSTALLATION_ID,
      refreshSecretHash: SECRET_HASH
    })).created, true)
    timestamp += 25 * 60 * 60 * 1000
    assert.equal((await registry.register({
      installationId: SECOND_INSTALLATION_ID,
      refreshSecretHash: OTHER_SECRET_HASH
    })).created, true)
    assert.equal((await registry.refresh(INSTALLATION_ID, SECRET_HASH)).code, 'NOT_FOUND')
    assert.equal((await registry.register({
      installationId: INSTALLATION_ID,
      refreshSecretHash: SECRET_HASH
    })).created, true)
    assert.equal(
      (await registry.refresh(INSTALLATION_ID, OTHER_SECRET_HASH)).code,
      'INVALID_PROOF'
    )
    await registry.revoke(INSTALLATION_ID, 'abuse')
    assert.equal((await registry.refresh(INSTALLATION_ID, SECRET_HASH)).code, 'REVOKED')
    assert.equal((await registry.register({
      installationId: INSTALLATION_ID,
      refreshSecretHash: SECRET_HASH
    })).code, 'REVOKED')
  } finally {
    await registry.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('global registration budget is persistent and inactive records are reclaimed', async () => {
  let timestamp = Date.UTC(2026, 6, 24, 8)
  const { dataDir, registry } = await temporaryRegistry({
    now: () => timestamp,
    maxInstallations: 1,
    registrationLimitPerHour: 1,
    registrationLimitPerDay: 1,
    inactiveRetentionDays: 1
  })
  try {
    assert.equal((await registry.register({
      installationId: INSTALLATION_ID,
      refreshSecretHash: SECRET_HASH
    })).ok, true)
    assert.equal((await registry.register({
      installationId: SECOND_INSTALLATION_ID,
      refreshSecretHash: OTHER_SECRET_HASH
    })).code, 'REGISTRY_FULL')

    timestamp += 25 * 60 * 60 * 1000
    const replacement = await registry.register({
      installationId: SECOND_INSTALLATION_ID,
      refreshSecretHash: OTHER_SECRET_HASH
    })
    assert.equal(replacement.ok, true)
    assert.equal(replacement.created, true)
    assert.equal(registry.get(INSTALLATION_ID), null)
  } finally {
    await registry.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('daily reservations atomically enforce per-installation and global budgets across restarts', async () => {
  const timestamp = Date.UTC(2026, 6, 24, 8)
  const { dataDir, registry } = await temporaryRegistry({ now: () => timestamp })
  try {
    await registry.register({ installationId: INSTALLATION_ID, refreshSecretHash: SECRET_HASH })
    const first = await registry.reserve({
      installationId: INSTALLATION_ID,
      metric: 'video_requests',
      perInstallationLimit: 2,
      globalLimit: 3
    })
    assert.equal(first.ok, true)
    const second = await registry.reserve({
      installationId: INSTALLATION_ID,
      metric: 'video_requests',
      perInstallationLimit: 2,
      globalLimit: 3
    })
    assert.equal(second.ok, true)
    const blocked = await registry.reserve({
      installationId: INSTALLATION_ID,
      metric: 'video_requests',
      perInstallationLimit: 2,
      globalLimit: 3
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.scope, 'installation')

    const restarted = createInstallationRegistry({
      dataDir,
      environment: 'test',
      now: () => timestamp
    })
    await restarted.start()
    const stillBlocked = await restarted.reserve({
      installationId: INSTALLATION_ID,
      metric: 'video_requests',
      perInstallationLimit: 2,
      globalLimit: 3
    })
    assert.equal(stillBlocked.ok, false)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a failed revoke commit cannot leave a revocation that disappears after restart', async () => {
  let failCommit = false
  const { dataDir, registry } = await temporaryRegistry({
    beforeSnapshotCommit: async () => {
      if (failCommit) throw new Error('simulated disk failure')
    }
  })
  try {
    await registry.register({ installationId: INSTALLATION_ID, refreshSecretHash: SECRET_HASH })
    failCommit = true
    await assert.rejects(registry.revoke(INSTALLATION_ID, 'abuse'), /simulated disk failure/)
    assert.equal(registry.authenticate({ sub: INSTALLATION_ID, ver: 1 })?.sub, INSTALLATION_ID)
    failCommit = false
    const restarted = createInstallationRegistry({ dataDir, environment: 'test' })
    await restarted.start()
    assert.equal(restarted.authenticate({ sub: INSTALLATION_ID, ver: 1 })?.sub, INSTALLATION_ID)
    await restarted.stop()
  } finally {
    failCommit = false
    await registry.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a corrupt registry fails closed instead of silently forgetting revocations', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'narra-installations-corrupt-'))
  try {
    await writeFile(path.join(dataDir, 'installations-test.json'), '{broken', 'utf8')
    const registry = createInstallationRegistry({ dataDir, environment: 'test' })
    await assert.rejects(registry.start())
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
