import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface StagedDeleteResult extends Set<string> {
  cleanupPending: boolean
}

function resultFor(staged: Array<{ original: string }>, cleanupPending: boolean): StagedDeleteResult {
  const result = new Set(staged.map(({ original }) => original)) as StagedDeleteResult
  result.cleanupPending = cleanupPending
  return result
}

export async function stagedDeleteFiles(
  originals: string[],
  deleteAssociated: () => Promise<void>,
  transaction: {
    commit?: () => Promise<void> | void
    fileOps?: Pick<typeof fs, 'rename' | 'unlink'>
  } = {}
): Promise<StagedDeleteResult> {
  const fileOps = transaction.fileOps || fs
  const staged: Array<{ original: string; tombstone: string }> = []
  let committed = false
  try {
    for (const original of originals) {
      const tombstone = `${original}.deleting-${randomUUID()}`
      try {
        await fileOps.rename(original, tombstone)
        staged.push({ original, tombstone })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await deleteAssociated()
    await transaction.commit?.()
    committed = true
    const cleanup = await Promise.allSettled(
      [...staged].reverse().map(({ tombstone }) => fileOps.unlink(tombstone))
    )
    return resultFor(staged, cleanup.some((item) => item.status === 'rejected'))
  } catch (error) {
    if (committed) {
      // Once structured state is cleared, never restore any original path:
      // a tombstone cleanup failure must not recreate sensitive book orphans.
      // Remaining tombstones are quarantined from normal app loading.
      return resultFor(staged, true)
    }
    for (const { original, tombstone } of [...staged].reverse()) {
      try {
        await fileOps.rename(tombstone, original)
      } catch { /* tombstone may already be irreversibly removed */ }
    }
    throw error
  }
}

export async function cleanupStagedDeleteTombstones(directory: string): Promise<number> {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  const tombstones = entries.filter((entry) =>
    entry.isFile() && /\.deleting-[0-9a-f-]{36}$/i.test(entry.name)
  )
  const results = await Promise.allSettled(
    tombstones.map((entry) => fs.unlink(path.join(directory, entry.name)))
  )
  return results.filter((item) => item.status === 'rejected').length
}
