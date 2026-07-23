import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const script = new URL('./verify-release-tag.mjs', import.meta.url).pathname
const node = process.execPath

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

test('release verification requires HEAD to resolve from the exact tag ref', () => {
  const repo = mkdtempSync(join(tmpdir(), 'narra-tag-test-'))
  try {
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Narra Test')
    git(repo, 'config', 'user.email', 'narra-test@example.invalid')
    writeFileSync(join(repo, 'fixture.txt'), 'release\n')
    git(repo, 'add', 'fixture.txt')
    git(repo, 'commit', '-qm', 'fixture')
    git(repo, 'tag', 'v0.7.7')
    assert.match(execFileSync(node, [script, 'v0.7.7'], {
      cwd: repo, encoding: 'utf8'
    }), /Release tag verified/)

    writeFileSync(join(repo, 'fixture.txt'), 'post-tag change\n')
    git(repo, 'add', 'fixture.txt')
    git(repo, 'commit', '-qm', 'post-tag fixture')
    assert.throws(
      () => execFileSync(node, [script, 'v0.7.7'], {
        cwd: repo, encoding: 'utf8', stdio: 'pipe'
      }),
      /Command failed/
    )
    git(repo, 'checkout', '-q', 'v0.7.7')
    git(repo, 'tag', '-d', 'v0.7.7')
    git(repo, 'branch', 'v0.7.7')
    assert.throws(
      () => execFileSync(node, [script, 'v0.7.7'], {
        cwd: repo, encoding: 'utf8', stdio: 'pipe'
      }),
      /Command failed/
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
