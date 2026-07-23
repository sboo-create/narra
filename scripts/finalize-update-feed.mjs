import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

const releaseDir = path.resolve('release')
const feedPath = path.join(releaseDir, 'latest-mac.yml')
const document = YAML.parse(await fs.readFile(feedPath, 'utf8'))
const zipFiles = Array.isArray(document.files)
  ? document.files.filter((entry) => typeof entry?.url === 'string' && entry.url.endsWith('-universal.zip'))
  : []
if (zipFiles.length !== 1) throw new Error('latest-mac.yml must contain exactly one universal ZIP')

const zip = zipFiles[0]
const zipPath = path.join(releaseDir, path.basename(zip.url))
const bytes = await fs.readFile(zipPath)
const actualSha512 = createHash('sha512').update(bytes).digest('base64')
const actualSize = bytes.length

if (process.argv.includes('--verify')) {
  if (document.files.length !== 1 || document.path !== zip.url) throw new Error('update feed must publish ZIP only')
  if (zip.sha512 !== actualSha512 || document.sha512 !== actualSha512) throw new Error('ZIP SHA-512 does not match latest-mac.yml')
  if (Number(zip.size) !== actualSize) throw new Error('ZIP size does not match latest-mac.yml')
  console.log(`Verified ZIP-only update feed: ${zip.url} (${actualSize} bytes)`)
  process.exit(0)
}

document.files = [{ ...zip, sha512: actualSha512, size: actualSize }]
document.path = zip.url
document.sha512 = actualSha512
await fs.writeFile(feedPath, YAML.stringify(document), { mode: 0o600 })
for (const name of await fs.readdir(releaseDir)) {
  if (name.endsWith('.dmg.blockmap')) await fs.unlink(path.join(releaseDir, name))
}
console.log(`Finalized ZIP-only update feed: ${zip.url}`)
