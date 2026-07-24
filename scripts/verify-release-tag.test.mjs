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
  const remote = mkdtempSync(join(tmpdir(), 'narra-tag-remote-'))
  try {
    git(remote, 'init', '--bare', '-q')
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Narra Test')
    git(repo, 'config', 'user.email', 'narra-test@example.invalid')
    git(repo, 'remote', 'add', 'origin', remote)
    writeFileSync(join(repo, 'fixture.txt'), 'release\n')
    git(repo, 'add', 'fixture.txt')
    git(repo, 'commit', '-qm', 'fixture')
    git(repo, 'tag', 'v0.7.7')
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main', 'refs/tags/v0.7.7')
    assert.match(execFileSync(node, [script, 'v0.7.7'], {
      cwd: repo, encoding: 'utf8'
    }), /Release local and origin tags verified/)

    writeFileSync(join(repo, 'fixture.txt'), 'post-tag change\n')
    git(repo, 'add', 'fixture.txt')
    git(repo, 'commit', '-qm', 'post-tag fixture')
    assert.throws(
      () => execFileSync(node, [script, 'v0.7.7'], {
        cwd: repo, encoding: 'utf8', stdio: 'pipe'
      }),
      /Command failed/
    )
    git(repo, 'tag', '-f', 'v0.7.7')
    assert.throws(
      () => execFileSync(node, [script, 'v0.7.7'], {
        cwd: repo, encoding: 'utf8', stdio: 'pipe'
      }),
      /Command failed/
    )
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
    rmSync(remote, { recursive: true, force: true })
  }
})
