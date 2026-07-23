import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import test from 'node:test'
import tls from 'node:tls'

import { createHttpsAgent } from '../http.mjs'
import {
  EXPECTED_SBER_CA_FINGERPRINTS,
  sberCaBundle,
  verifiedRussianTrustedCertificates,
  verifiedSberCertificates
} from '../sber-tls.mjs'

function fingerprints(certificates) {
  return new Set(certificates.map((pem) => (
    new X509Certificate(pem).fingerprint256.replaceAll(':', '').toUpperCase()
  )))
}

test('bundles only the fingerprint-verified Russian trusted root and current sub CA', () => {
  assert.equal(verifiedSberCertificates.length, 2)
  assert.deepEqual(fingerprints(verifiedSberCertificates), EXPECTED_SBER_CA_FINGERPRINTS)
  assert.equal(sberCaBundle.length, tls.rootCertificates.length + 2)
})

test('rejects a bundle when either required certificate is absent or corrupted', () => {
  const root = readFileSync(
    new URL('../russian-trusted-root-ca.pem', import.meta.url),
    'utf8'
  )
  const sub = readFileSync(
    new URL('../russian-trusted-sub-ca-2024.pem', import.meta.url),
    'utf8'
  )
  assert.deepEqual(verifiedRussianTrustedCertificates(root), [])
  assert.deepEqual(
    verifiedRussianTrustedCertificates(`${root}\n${sub.replace('MIIG6D', 'NIIG6D')}`),
    []
  )
})

test('adds Sber roots without disabling certificate or hostname verification', () => {
  const agent = createHttpsAgent({ ca: sberCaBundle })
  assert.equal(agent.options.rejectUnauthorized, true)
  assert.equal(agent.options.ca.length, tls.rootCertificates.length + 2)
  agent.destroy()
})

test('verified bundle state is suitable for fail-closed readiness', () => {
  assert.equal(Array.isArray(sberCaBundle), true)
  assert.equal(verifiedSberCertificates.length === 2, true)
})
