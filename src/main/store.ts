import Store from 'electron-store'
import type { Settings } from '../shared/types'

interface Schema {
  settings: Settings
  appState: Record<string, unknown>
}

// URL прокси по умолчанию: локальный сервер для разработки.
// Для раздачи приложения замени на задеплоенный (Railway) URL — можно через
// переменную сборки NARRA_PROXY_URL.
const DEFAULT_PROXY = process.env.NARRA_PROXY_URL || 'http://localhost:8787'

const defaults: Schema = {
  settings: {
    proxyUrl: DEFAULT_PROXY
  },
  appState: {}
}

const store = new Store<Schema>({ defaults, name: 'narra' })

export function getSettings(): Settings {
  return { ...defaults.settings, ...(store.get('settings') as Partial<Settings>) }
}

export function setSettings(next: Partial<Settings>): Settings {
  const merged = { ...getSettings(), ...next }
  store.set('settings', merged)
  return merged
}

export function getAppState(): Record<string, unknown> {
  return store.get('appState') as Record<string, unknown>
}

export function setAppState(next: Record<string, unknown>): void {
  store.set('appState', next)
}
