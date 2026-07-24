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
let remoteTagCommit
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  tagCommit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${expected}^{commit}`], {
    encoding: 'utf8'
  }).trim()
  const remoteLines = execFileSync(
    'git',
    ['ls-remote', '--tags', 'origin', `refs/tags/${expected}`, `refs/tags/${expected}^{}`],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/, 2))
  const remoteRefs = new Map(remoteLines.map(([commit, ref]) => [ref, commit]))
  remoteTagCommit =
    remoteRefs.get(`refs/tags/${expected}^{}`) || remoteRefs.get(`refs/tags/${expected}`)
  if (!remoteTagCommit) throw new Error('remote tag is missing')
} catch {
  throw new Error(`Release requires matching immutable local and origin tags refs/tags/${expected}`)
}
if (head !== tagCommit) {
  throw new Error(`Release HEAD ${head} does not match refs/tags/${expected} (${tagCommit})`)
}
if (head !== remoteTagCommit) {
  throw new Error(
    `Release HEAD/local tag ${head} does not match origin refs/tags/${expected} (${remoteTagCommit})`
  )
}
console.log(`Release local and origin tags verified: ${expected} -> ${head}`)
