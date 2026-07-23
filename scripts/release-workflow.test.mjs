import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/release-macos.yml', import.meta.url), 'utf8')
const localRelease = readFileSync(new URL('./release-macos-local.sh', import.meta.url), 'utf8')
const notarizeDmg = readFileSync(new URL('./notarize-dmg.sh', import.meta.url), 'utf8')
const verifyMacRelease = readFileSync(new URL('./verify-macos-release.sh', import.meta.url), 'utf8')
const finalizeUpdateFeedUrl = new URL('./finalize-update-feed.mjs', import.meta.url)
const appEntitlements = readFileSync(new URL('../build/entitlements.mac.plist', import.meta.url), 'utf8')
const inheritedEntitlements = readFileSync(new URL('../build/entitlements.mac.inherit.plist', import.meta.url), 'utf8')

test('hosted workflow is a manual unsigned preflight and receives no Apple secrets', () => {
  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /push:\s*\n\s+tags:/)
  assert.match(workflow, /permissions:\s*\n\s+contents: read/)
  assert.match(
    workflow,
    /actions\/checkout@[^\n]+[\s\S]+?ref: \$\{\{ env\.RELEASE_VERSION \}\}[\s\S]+?persist-credentials: false/
  )
  assert.match(workflow, /npm run dist:unsigned/)
  assert.match(workflow, /npm run release:verify:unsigned/)
  assert.doesNotMatch(workflow, /secrets\.|APPLE_API|CSC_LINK|gh release/)
})

test('local release verifies before uploading only to a draft', () => {
  assert.match(localRelease, /NARRA_LOCAL_RELEASE=1/)
  assert.match(localRelease, /Developer ID Application: Evgeny Tsapnikov \(LTS79DWRGJ\)/)
  assert.match(localRelease, /npm run release:verify/)
  assert.match(localRelease, /gh release create "\$RELEASE_VERSION"[\s\S]+--draft/)
  assert.match(localRelease, /gh release upload "\$RELEASE_VERSION" "\$\{assets\[@\]\}" --clobber/)
  assert.match(localRelease, /assert_no_unexpected_remote_assets/)
  assert.match(localRelease, /Draft asset set does not exactly match this release/)
  assert.ok(
    localRelease.indexOf('npm run release:verify') < localRelease.indexOf('gh release create'),
    'release files must be verified before a draft release is created'
  )
  assert.doesNotMatch(localRelease, /gh release edit[\s\S]+--draft=false/)
})

test('local release is tied to a clean tagged tree and isolated exact-version artifacts', () => {
  assert.match(localRelease, /git status --porcelain=v1 --untracked-files=all/)
  assert.match(localRelease, /NARRA_RELEASE_DIR="release\/\$RELEASE_VERSION"/)
  assert.match(localRelease, /\[ ! -e "\$NARRA_RELEASE_DIR" \]/)
  assert.match(localRelease, /Narra-\$\{APP_VERSION\}-universal\.dmg/)
  assert.match(localRelease, /Narra-\$\{APP_VERSION\}-universal\.zip/)
  assert.doesNotMatch(localRelease, /Narra-\*|release\/\*|find release/)
  assert.doesNotMatch(notarizeDmg, /Narra-\*|find release/)
  assert.doesNotMatch(verifyMacRelease, /Narra-\*|find release/)
})

test('update feed rejects an artifact from a stale version', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'narra-feed-test-'))
  const releaseDir = path.join(root, 'release')
  mkdirSync(releaseDir)
  writeFileSync(path.join(releaseDir, 'Narra-0.7.6-universal.zip'), 'stale')
  writeFileSync(
    path.join(releaseDir, 'latest-mac.yml'),
    [
      'version: 0.7.6',
      'files:',
      '  - url: Narra-0.7.6-universal.zip',
      '    sha512: stale',
      '    size: 5',
      'path: Narra-0.7.6-universal.zip',
      'sha512: stale'
    ].join('\n')
  )
  try {
    const result = spawnSync(process.execPath, [finalizeUpdateFeedUrl.pathname, '--verify', '--version', '0.7.7'], {
      cwd: root,
      encoding: 'utf8'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /version must be 0\.7\.7/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('local notarization can use a Keychain profile without writing key material', () => {
  assert.match(notarizeDmg, /APPLE_KEYCHAIN_PROFILE/)
  assert.match(notarizeDmg, /--keychain-profile/)
  assert.doesNotMatch(localRelease, /printf.+APPLE|AuthKey_|\\.p8/)
})

test('modern Electron release does not request unsigned executable memory', () => {
  for (const entitlements of [appEntitlements, inheritedEntitlements]) {
    assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/)
    assert.doesNotMatch(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/)
  }
})
