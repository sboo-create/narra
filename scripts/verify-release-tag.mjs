import { readFileSync } from 'node:fs'

const supplied = String(process.argv[2] || '').trim()
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const expected = `v${manifest.version}`
if (supplied !== expected) {
  throw new Error(`Release ref must exactly match package version: expected ${expected}, got ${supplied || '<empty>'}`)
}
console.log(`Release tag verified: ${expected}`)
