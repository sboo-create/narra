import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/release-macos.yml', import.meta.url), 'utf8')
const appEntitlements = readFileSync(new URL('../build/entitlements.mac.plist', import.meta.url), 'utf8')
const inheritedEntitlements = readFileSync(new URL('../build/entitlements.mac.inherit.plist', import.meta.url), 'utf8')

test('release workflow stages a verified draft without silently publishing it', () => {
  assert.match(workflow, /permissions:\s*\n\s+contents: write/)
  assert.match(
    workflow,
    /actions\/checkout@[^\n]+[\s\S]+?ref: \$\{\{ env\.RELEASE_VERSION \}\}[\s\S]+?persist-credentials: false/
  )
  assert.match(workflow, /https:\/\/github\.com\/sboo-create\/narra\/releases\/latest\/download\//)
  assert.match(workflow, /gh release create "\$RELEASE_VERSION"[\s\S]+--draft/)
  assert.match(workflow, /gh release upload "\$RELEASE_VERSION" "\$\{assets\[@\]\}" --clobber/)
  assert.match(workflow, /Do not publish until every documented release gate passes/)
  assert.ok(
    workflow.indexOf('npm run release:verify') < workflow.indexOf('gh release create'),
    'release files must be verified before a draft release is created'
  )
  assert.doesNotMatch(workflow, /gh release edit[\s\S]+--draft=false/)
})

test('update feed is a public HTTPS origin and is not treated as a credential', () => {
  assert.match(workflow, /UPDATE_BASE_URL: \$\{\{ vars\.NARRA_UPDATE_BASE_URL \|\|/)
  assert.match(workflow, /NARRA_UPDATE_BASE_URL: \$\{\{ env\.UPDATE_BASE_URL \}\}/)
  assert.doesNotMatch(workflow, /secrets\.NARRA_UPDATE_BASE_URL/)
})

test('modern Electron release does not request unsigned executable memory', () => {
  for (const entitlements of [appEntitlements, inheritedEntitlements]) {
    assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/)
    assert.doesNotMatch(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/)
  }
})
