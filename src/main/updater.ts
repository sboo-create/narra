import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ApiResult } from '../shared/types'

let availableVersion = ''
let checking: Promise<ApiResult<{ hasUpdate: boolean; version: string }>> | null = null
let installing: Promise<ApiResult<{ started: true; version: string }>> | null = null

export function availableUpdateVersion(): string {
  return availableVersion
}

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.allowDowngrade = false
autoUpdater.allowPrerelease = false
autoUpdater.logger = null

function supported(): boolean {
  return app.isPackaged && process.platform === 'darwin'
}

function updaterError(error: unknown): ApiResult<never> {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  const code = message.includes('timeout') ? 'TIMEOUT' : 'NETWORK'
  return {
    ok: false,
    code,
    error: code === 'TIMEOUT'
      ? 'Сервер обновлений не ответил вовремя.'
      : 'Не удалось проверить или загрузить подписанное обновление.'
  }
}

export function checkAppUpdate(): Promise<ApiResult<{ hasUpdate: boolean; version: string }>> {
  if (!supported()) return Promise.resolve({ ok: true, data: { hasUpdate: false, version: '' } })
  if (checking) return checking
  checking = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      const version = result?.isUpdateAvailable ? result.updateInfo.version : ''
      availableVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : ''
      return { ok: true, data: { hasUpdate: !!availableVersion, version: availableVersion } }
    } catch (error) {
      availableVersion = ''
      return updaterError(error)
    } finally {
      checking = null
    }
  })()
  return checking
}

export function installUpdate(): Promise<ApiResult<{ started: true; version: string }>> {
  if (!supported()) {
    return Promise.resolve({ ok: false, code: 'VALIDATION', error: 'Обновление доступно только в установленной macOS-сборке.' })
  }
  if (installing) return installing
  const task: Promise<ApiResult<{ started: true; version: string }>> = (async () => {
    try {
      if (!availableVersion) {
        const checked = await checkAppUpdate()
        if (!checked.ok) return { ok: false, code: checked.code, error: checked.error }
        if (!checked.data?.hasUpdate) {
          return { ok: false, code: 'VALIDATION', error: 'Новая версия уже не доступна.' }
        }
      }
      const version = availableVersion
      await autoUpdater.downloadUpdate()
      setTimeout(() => autoUpdater.quitAndInstall(), 750)
      return { ok: true, data: { started: true, version } }
    } catch (error) {
      return updaterError(error)
    } finally {
      installing = null
    }
  })()
  installing = task
  return task
}
