import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { Settings } from '../shared/types'
import { isEssentialAnalyticsEvent, type AnalyticsEvent } from '../shared/analytics'

interface Schema {
  settings: Settings
  appState: Record<string, unknown>
  gateway: {
    installationId: string
    token: string
    tokenProxyUrl: string
  }
  telemetryQueue: AnalyticsEvent[]
}

// URL прокси по умолчанию: локальный сервер для разработки.
// Для раздачи приложения замени на задеплоенный (Railway) URL — можно через
// переменную сборки NARRA_PROXY_URL.
const DEFAULT_PROXY = process.env.NARRA_PROXY_URL || 'http://localhost:8787'

const defaults: Schema = {
  settings: {
    proxyUrl: DEFAULT_PROXY,
    extendedTelemetryEnabled: true
  },
  appState: {},
  gateway: {
    installationId: '',
    token: '',
    tokenProxyUrl: ''
  },
  telemetryQueue: []
}

const store = new Store<Schema>({ defaults, name: 'narra' })

export function getSettings(): Settings {
  return { ...defaults.settings, ...(store.get('settings') as Partial<Settings>) }
}

export function setSettings(next: Partial<Settings>): Settings {
  const merged = {
    ...getSettings(),
    ...(typeof next.proxyUrl === 'string' ? { proxyUrl: next.proxyUrl.trim() } : {}),
    ...(typeof next.extendedTelemetryEnabled === 'boolean'
      ? { extendedTelemetryEnabled: next.extendedTelemetryEnabled }
      : {})
  }
  store.set('settings', merged)
  if (next.proxyUrl !== undefined && next.proxyUrl.trim() !== store.get('gateway.tokenProxyUrl')) {
    store.set('gateway.token', '')
    store.set('gateway.tokenProxyUrl', '')
  }
  if (next.extendedTelemetryEnabled === false) {
    store.set(
      'telemetryQueue',
      getTelemetryQueue().filter((event) => isEssentialAnalyticsEvent(event.name))
    )
  }
  return merged
}

export function getGatewayIdentity(): {
  installationId: string
  token: string
  tokenProxyUrl: string
} {
  const current = store.get('gateway')
  if (current?.installationId) {
    return { ...current, token: revealGatewayToken(current.token) }
  }
  const created = { ...current, installationId: randomUUID() }
  store.set('gateway', created)
  return created
}

export function setGatewayToken(token: string, tokenProxyUrl: string): void {
  store.set('gateway.token', protectGatewayToken(token))
  store.set('gateway.tokenProxyUrl', tokenProxyUrl)
}

function protectGatewayToken(token: string): string {
  if (!token) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(token).toString('base64')}`
  }
  return `plain:${token}`
}

function revealGatewayToken(stored: string): string {
  if (!stored) return ''
  if (stored.startsWith('safe:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'))
    } catch {
      return ''
    }
  }
  return stored.startsWith('plain:') ? stored.slice(6) : stored
}

export function clearGatewayToken(): void {
  store.set('gateway.token', '')
  store.set('gateway.tokenProxyUrl', '')
}

export function getTelemetryQueue(): AnalyticsEvent[] {
  return (store.get('telemetryQueue') || []).slice(0, 500)
}

export function setTelemetryQueue(events: AnalyticsEvent[]): void {
  store.set('telemetryQueue', events.slice(-500))
}

export function getAppState(): Record<string, unknown> {
  return store.get('appState') as Record<string, unknown>
}

export function setAppState(next: Record<string, unknown>): void {
  store.set('appState', next)
}
