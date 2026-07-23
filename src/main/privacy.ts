import { app, session } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ApiResult } from '../shared/types'
import { beginPrivacyReset, resetAllPersistentState } from './store'
import { ownedLocalDataDirectories } from './local-data-paths'
import { cancelGatewayActivity } from './api/proxy'
import { beginLocalDataReset } from './local-data-barrier'

export async function deleteAllLocalData(): Promise<ApiResult<{ deleted: true }>> {
  beginPrivacyReset()
  cancelGatewayActivity()
  try {
    // Close admission first, then wait for every already-admitted filesystem
    // writer. Only after the write set is empty may recursive deletion start.
    await beginLocalDataReset()
    const userData = path.resolve(app.getPath('userData'))
    const results = await Promise.allSettled([
      ...ownedLocalDataDirectories(userData).map((target) => fs.rm(target, { recursive: true, force: true })),
      session.defaultSession.clearCache(),
      session.defaultSession.clearStorageData({
        storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers']
      })
    ])
    // Clear structured state/token/telemetry even if one cache backend fails;
    // the user can retry the remaining filesystem cleanup after an honest error.
    resetAllPersistentState()
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length) {
      scheduleCleanRelaunch()
      return { ok: false, error: `Не удалось удалить ${failures.length} локальных хранилищ; повтори действие.`, code: 'UNKNOWN' }
    }
    // Keep the write barrier until a clean process relaunch. This prevents any
    // in-flight IPC/network completion from recreating state or media caches.
    scheduleCleanRelaunch()
    return { ok: true, data: { deleted: true } }
  } catch (error) {
    resetAllPersistentState()
    scheduleCleanRelaunch()
    return { ok: false, error: (error as Error).message, code: 'UNKNOWN' }
  }
}

function scheduleCleanRelaunch(): void {
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 1200).unref()
}
