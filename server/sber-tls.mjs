import { readFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import tls from 'node:tls'

export const EXPECTED_SBER_CA_FINGERPRINTS = new Set([
  'D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31',
  '2155785036C900DBB5F1BB2A1569C80C55595BD6BF94867A29BBDDBC7D88A3F2'
])

function fingerprint(pem) {
  try {
    return new X509Certificate(pem).fingerprint256.replaceAll(':', '').toUpperCase()
  } catch {
    return undefined
  }
}

export function verifiedRussianTrustedCertificates(pem) {
  const verified = (String(pem).match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
  ) || []).filter((certificate) => (
    EXPECTED_SBER_CA_FINGERPRINTS.has(fingerprint(certificate))
  ))
  const fingerprints = new Set(verified.map(fingerprint))
  return fingerprints.size === EXPECTED_SBER_CA_FINGERPRINTS.size
    ? verified
    : []
}

function readBundledCertificates() {
  try {
    return verifiedRussianTrustedCertificates([
      readFileSync(new URL('./russian-trusted-root-ca.pem', import.meta.url), 'utf8'),
      readFileSync(new URL('./russian-trusted-sub-ca-2024.pem', import.meta.url), 'utf8')
    ].join('\n'))
  } catch (error) {
    console.error('[security] Sber CA bundle could not be loaded:', error?.message || error)
    return []
  }
}

export const verifiedSberCertificates = readBundledCertificates()

if (verifiedSberCertificates.length !== EXPECTED_SBER_CA_FINGERPRINTS.size) {
  console.error('[security] Sber CA bundle failed fingerprint verification; using default roots only')
}

// `ca` replaces Node's standard roots, so preserve them and add only the two
// fingerprint-verified Минцифры certificates required by Sber endpoints.
export const sberCaBundle = verifiedSberCertificates.length === EXPECTED_SBER_CA_FINGERPRINTS.size
  ? [...tls.rootCertificates, ...verifiedSberCertificates]
  : undefined
