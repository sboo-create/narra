import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { ownedLocalDataDirectories } from '../../src/main/local-data-paths.ts'

test('delete-all targets only explicit children of the app user-data directory', () => {
  const root = path.resolve('/tmp/narra-test-user-data')
  const targets = ownedLocalDataDirectories(root)
  assert.deepEqual(targets.map((target) => path.basename(target)), ['books', 'images', 'audio', 'video'])
  assert.ok(targets.every((target) => path.dirname(target) === root))
  assert.throws(() => ownedLocalDataDirectories(path.parse(root).root), /filesystem root/)
})
