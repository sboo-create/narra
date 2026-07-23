import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const supplied = String(process.argv[2] || '').trim()
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const expected = `v${manifest.version}`
if (supplied !== expected) {
  throw new Error(`Release ref must exactly match package version: expected ${expected}, got ${supplied || '<empty>'}`)
}
let head
let tagCommit
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  tagCommit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${expected}^{commit}`], {
    encoding: 'utf8'
  }).trim()
} catch {
  throw new Error(`Release requires an existing immutable tag refs/tags/${expected}`)
}
if (head !== tagCommit) {
  throw new Error(`Release HEAD ${head} does not match refs/tags/${expected} (${tagCommit})`)
}
console.log(`Release tag verified: ${expected} -> ${head}`)
