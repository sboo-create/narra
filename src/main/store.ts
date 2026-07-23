import Store from 'electron-store'
import { randomBytes, randomUUID } from 'node:crypto'
import { app, safeStorage } from 'electron'
import type { Settings } from '../shared/types'
import { isEssentialAnalyticsEvent, type AnalyticsEvent } from '../shared/analytics'
import { boundedTelemetryQueue } from './telemetry-queue'

interface Schema {
  settings: Settings
  appState: Record<string, unknown>
  gateway: {
    installationId: string
    refreshSecret: string
    token: string
    tokenProxyUrl: string
  }
  telemetryQueue: AnalyticsEvent[]
  telemetrySession: {
    id: string
    lastActivityAt: number
  }
  telemetryDeadLetters: Array<{
    eventId: string
    name: string
    occurredAt: string
    reason: string
  }>
  pendingUpdateVersion: string
}

// URL прокси по умолчанию: локальный сервер для разработки.
// Для раздачи приложения замени на задеплоенный (Railway) URL — можно через
// переменную сборки NARRA_PROXY_URL.
const DEFAULT_PROXY = process.env.NARRA_PROXY_URL || 'http://localhost:8787'

function normalizeProxyUrl(candidate: string): string {
  const raw = candidate.trim().replace(/\/+$/, '')
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash) throw new Error('Некорректный URL gateway')
  if (app.isPackaged) {
    const releaseOrigin = new URL(DEFAULT_PROXY).origin
    const allowCustom = process.env.NARRA_ALLOW_CUSTOM_PROXY === 'true'
    if (url.protocol !== 'https:') throw new Error('Release-сборка подключается только по HTTPS')
    if (!allowCustom && url.origin !== releaseOrigin) throw new Error('Этот gateway не разрешён release-сборкой')
  } else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Разрешены HTTPS или локальный HTTP для разработки')
  }
  return raw
}

const defaults: Schema = {
  settings: {
    proxyUrl: DEFAULT_PROXY,
    extendedTelemetryEnabled: true
  },
  appState: {},
  gateway: {
    installationId: '',
    refreshSecret: '',
    token: '',
    tokenProxyUrl: ''
  },
  telemetryQueue: [],
  telemetrySession: {
    id: '',
    lastActivityAt: 0
  },
  telemetryDeadLetters: [],
  pendingUpdateVersion: ''
}

const store = new Store<Schema>({ defaults, name: 'narra' })
let memoryGatewayToken = ''
let memoryInstallationSecret = ''
let privacyResetActive = false

export function getSettings(): Settings {
  const merged = { ...defaults.settings, ...(store.get('settings') as Partial<Settings>) }
  try {
    return { ...merged, proxyUrl: normalizeProxyUrl(merged.proxyUrl) }
  } catch {
    return { ...merged, proxyUrl: '' }
  }
}

export function setSettings(next: Partial<Settings>): Settings {
  if (privacyResetActive) return getSettings()
  const proxyUrl = typeof next.proxyUrl === 'string' ? normalizeProxyUrl(next.proxyUrl) : undefined
  const merged = {
    ...getSettings(),
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    ...(typeof next.extendedTelemetryEnabled === 'boolean'
      ? { extendedTelemetryEnabled: next.extendedTelemetryEnabled }
      : {})
  }
  store.set('settings', merged)
  if (proxyUrl !== undefined && proxyUrl !== store.get('gateway.tokenProxyUrl')) {
    clearGatewayToken()
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
  refreshSecret: string
  token: string
  tokenProxyUrl: string
} {
  const current = store.get('gateway')
  const refreshSecret = revealSensitive(current?.refreshSecret || '') || memoryInstallationSecret
  if (current?.installationId && refreshSecret) {
    return {
      ...current,
      refreshSecret,
      token: revealSensitive(current.token) || memoryGatewayToken
    }
  }
  const rawSecret = randomBytes(32).toString('base64url')
  const protectedSecret = protectSensitive(rawSecret)
  memoryInstallationSecret = protectedSecret ? '' : rawSecret
  memoryGatewayToken = ''
  const created = {
    installationId: randomUUID(),
    refreshSecret: protectedSecret,
    token: '',
    tokenProxyUrl: ''
  }
  store.set('gateway', created)
  return { ...created, refreshSecret: rawSecret }
}

export function setGatewayToken(token: string, tokenProxyUrl: string): void {
  if (privacyResetActive) return
  const protectedToken = protectSensitive(token)
  memoryGatewayToken = protectedToken ? '' : token
  store.set('gateway.token', protectedToken)
  store.set('gateway.tokenProxyUrl', tokenProxyUrl)
}

function protectSensitive(token: string): string {
  if (!token) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(token).toString('base64')}`
  }
  // Release credentials are never persisted in plaintext. If Keychain is
  // temporarily unavailable the token remains process-local and is renewed.
  return app.isPackaged ? '' : `plain:${token}`
}

function revealSensitive(stored: string): string {
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
  memoryGatewayToken = ''
  store.set('gateway.token', '')
  store.set('gateway.tokenProxyUrl', '')
}

export function clearGatewayTokenIf(expectedToken: string, expectedProxyUrl: string): void {
  const current = store.get('gateway')
  const currentToken = revealSensitive(current?.token || '') || memoryGatewayToken
  if (currentToken !== expectedToken || current?.tokenProxyUrl !== expectedProxyUrl) return
  clearGatewayToken()
}

export function resetAllPersistentState(): void {
  const extendedTelemetryEnabled = getSettings().extendedTelemetryEnabled
  memoryGatewayToken = ''
  memoryInstallationSecret = ''
  store.clear()
  store.set({
    ...defaults,
    settings: { ...defaults.settings, extendedTelemetryEnabled }
  })
}

export function beginPrivacyReset(): void {
  privacyResetActive = true
}

export function setPendingUpdateVersion(version: string): void {
  if (privacyResetActive) return
  store.set('pendingUpdateVersion', /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : '')
}

export function consumeInstalledUpdateVersion(currentVersion: string): string {
  const pending = store.get('pendingUpdateVersion') || ''
  if (pending && pending === currentVersion) {
    store.set('pendingUpdateVersion', '')
    return pending
  }
  return ''
}

export function getTelemetryQueue(): AnalyticsEvent[] {
  return boundedTelemetryQueue(store.get('telemetryQueue') || [], isEssentialAnalyticsEvent)
}

export function setTelemetryQueue(events: AnalyticsEvent[]): void {
  if (privacyResetActive) return
  store.set('telemetryQueue', boundedTelemetryQueue(events, isEssentialAnalyticsEvent))
}

export function getTelemetrySession(now = Date.now()): string {
  const current = store.get('telemetrySession')
  const expired = !current?.id || now - current.lastActivityAt > 30 * 60 * 1000
  const id = expired ? randomUUID() : current.id
  if (!privacyResetActive) store.set('telemetrySession', { id, lastActivityAt: now })
  return id
}

export function quarantineTelemetry(events: AnalyticsEvent[], reason: string): void {
  if (privacyResetActive) return
  const existing = store.get('telemetryDeadLetters') || []
  const next = events.map((event) => ({
    eventId: event.eventId,
    name: event.name,
    occurredAt: event.occurredAt,
    reason: reason.slice(0, 120)
  }))
  store.set('telemetryDeadLetters', [...existing, ...next].slice(-100))
}

export function getAppState(): Record<string, unknown> {
  return store.get('appState') as Record<string, unknown>
}

export function setAppState(next: Record<string, unknown>): void {
  if (privacyResetActive) return
  store.set('appState', next)
}
