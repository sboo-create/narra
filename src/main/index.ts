import { app, BrowserWindow, ipcMain, net, protocol, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import path from 'path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/ipc'
import type { LlmMessage, Settings } from '../shared/types'
import {
  consumeInstalledUpdateVersion,
  getSettings,
  getTelemetrySession,
  setSettings,
  getAppState,
  setAppState,
  setPendingUpdateVersion
} from './store'
import { loadBooks } from './content'
import { recordTelemetry, startTelemetry, stopTelemetry } from './telemetry'
import { RENDERER_ANALYTICS_EVENTS, type AnalyticsEventName, type SafeAnalyticsValue } from '../shared/analytics'
import { cleanupPendingBookDeletes, importBook, importBookFromUrl, saveBookCharacters, deleteBook, bookExcerpt } from './importer'
import {
  testProxy,
  chatStream,
  chatComplete,
  chatJson,
  generateImage,
  getCachedImage,
  synthesize,
  getCachedAudio,
  generateAvatar,
  getCachedVideo,
  animatePortrait,
  deleteCachedVideo,
  deleteCachedImage,
  saveCachedVideo,
  recognize
} from './api/proxy'
import { availableUpdateVersion, checkAppUpdate, installUpdate } from './updater'
import { deleteAllLocalData } from './privacy'

let mainWindow: BrowserWindow | null = null

protocol.registerSchemesAsPrivileged([
  { scheme: 'narra', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

function trustedRendererUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const development = process.env['ELECTRON_RENDERER_URL']
    if (development) return url.origin === new URL(development).origin
    return url.protocol === 'narra:' && url.hostname === 'app'
  } catch {
    return false
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!event.senderFrame || !trustedRendererUrl(event.senderFrame.url)) {
    throw new Error('IPC request from an untrusted renderer was blocked')
  }
}

function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event)
    return listener(event, ...args)
  })
}

function on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    assertTrustedSender(event)
    listener(event, ...args)
  })
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error(`${name}: invalid string`)
  return value
}

function validatedCacheKey(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const key = boundedString(value, 'cacheKey', 180)
  if (!/^[a-zA-Z0-9_-]{1,180}$/.test(key)) throw new Error('cacheKey: invalid format')
  return key
}

function llmMessages(value: unknown): LlmMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error('messages: invalid array')
  let total = 0
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('messages: invalid item')
    const candidate = item as Partial<LlmMessage>
    if (!['system', 'user', 'assistant'].includes(String(candidate.role))) throw new Error('messages: invalid role')
    const content = boundedString(candidate.content, 'message.content', 60_000)
    total += content.length
    if (total > 180_000) throw new Error('messages: payload too large')
    return { role: candidate.role as LlmMessage['role'], content }
  })
}

function boundedDataUrl(value: unknown, name: string, maximum = 25_000_000): string {
  const data = boundedString(value, name, maximum)
  if (!/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(data)) throw new Error(`${name}: invalid data URL`)
  return data
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#fafaf8',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (target.protocol === 'https:') void shell.openExternal(target.toString())
    } catch {
      // Invalid and non-HTTPS links stay inside the denied renderer request.
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!trustedRendererUrl(url)) event.preventDefault()
  })
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadURL('narra://app/index.html')
  }
}

function registerAppProtocol(): void {
  const root = path.resolve(__dirname, '../renderer')
  protocol.handle('narra', (request) => {
    const url = new URL(request.url)
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    if (!relative || relative.includes('\0')) return new Response('Bad request', { status: 400 })
    const candidate = path.resolve(root, relative)
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(candidate).toString())
  })
}

const chatSignals = new Map<string, { aborted: boolean }>()

function registerIpc(): void {
  handle(IPC.loadBooks, async () => {
    try {
      return { ok: true, data: await loadBooks() }
    } catch (e) {
      return { ok: false, error: `Не удалось загрузить книги: ${(e as Error).message}` }
    }
  })

  handle(IPC.getSettings, () => getSettings())
  handle(IPC.setSettings, (_e, next: Partial<Settings>) => {
    return setSettings(next)
  })
  handle(
    IPC.trackEvent,
    (_e, name: AnalyticsEventName, properties: Record<string, SafeAnalyticsValue>) => {
      if (!RENDERER_ANALYTICS_EVENTS.has(name)) return { ok: false }
      recordTelemetry(name, properties)
      return { ok: true }
    }
  )
  handle(IPC.touchTelemetrySession, () => {
    getTelemetrySession()
    return { ok: true }
  })

  handle(IPC.getState, () => getAppState())
  handle(IPC.setState, (_e, next: Record<string, unknown>) => {
    if (!next || typeof next !== 'object' || Array.isArray(next) || Buffer.byteLength(JSON.stringify(next)) > 20 * 1024 * 1024) {
      throw new Error('state payload is invalid or too large')
    }
    setAppState(next)
    return { ok: true }
  })

  handle(IPC.testProxy, () => testProxy())

  handle(IPC.llmJson, (_e, messages: LlmMessage[]) => chatJson(llmMessages(messages)))
  handle(IPC.llmText, (_e, messages: LlmMessage[], temperature?: number) =>
    chatComplete(llmMessages(messages), temperature)
  )

  handle(
    IPC.generateImage,
    (_e, prompt: string, cacheKey?: string, w?: number, h?: number, force?: boolean, engine?: 'kandinsky') =>
      generateImage(boundedString(prompt, 'prompt', 4_000), validatedCacheKey(cacheKey), w, h, force, engine)
  )
  handle(IPC.getCachedImage, (_e, key: string) => getCachedImage(validatedCacheKey(key)!))

  handle(
    IPC.synthesize,
    (_e, payload: { text?: string; ssml?: string; voice: string }, cacheKey?: string) =>
      synthesize({
        ...(payload.text !== undefined ? { text: boundedString(payload.text, 'text', 12_000) } : {}),
        ...(payload.ssml !== undefined ? { ssml: boundedString(payload.ssml, 'ssml', 24_000) } : {}),
        voice: boundedString(payload.voice, 'voice', 24)
      }, validatedCacheKey(cacheKey))
  )
  handle(IPC.getCachedAudio, (_e, key: string) => getCachedAudio(validatedCacheKey(key)!))

  handle(
    IPC.generateAvatar,
    (_e, imageDataUrl: string, audioDataUrl: string, cacheKey?: string) =>
      generateAvatar(boundedDataUrl(imageDataUrl, 'image'), boundedDataUrl(audioDataUrl, 'audio'), validatedCacheKey(cacheKey))
  )
  handle(IPC.getCachedVideo, (_e, key: string) => getCachedVideo(validatedCacheKey(key)!))
  handle(
    IPC.animatePortrait,
    (_e, imageDataUrl: string, query: string, cacheKey?: string, quality?: 'lite' | 'hd') =>
      animatePortrait(boundedDataUrl(imageDataUrl, 'image'), boundedString(query, 'query', 2_000), validatedCacheKey(cacheKey), quality)
  )
  handle(IPC.deleteCachedImage, (_e, key: string) => deleteCachedImage(validatedCacheKey(key)!))
  handle(IPC.deleteCachedVideo, (_e, key: string) => deleteCachedVideo(validatedCacheKey(key)!))
  handle(IPC.saveCachedVideo, (_e, key: string, dataUrl: string) => saveCachedVideo(validatedCacheKey(key)!, boundedDataUrl(dataUrl, 'video', 80_000_000)))
  handle(IPC.checkAppUpdate, async () => {
    const r = await checkAppUpdate()
    if (r.ok && r.data?.hasUpdate) recordTelemetry('update_offered', { version: r.data.version })
    return r
  })
  handle(IPC.installUpdate, async () => {
    const r = await installUpdate()
    if (r.ok && r.data) {
      recordTelemetry('update_downloaded', { version: r.data.version })
      setPendingUpdateVersion(r.data.version)
    } else {
      const version = availableUpdateVersion()
      if (version) recordTelemetry('update_verified', {
        version,
        success: false,
        error_code: r.code || 'UNKNOWN'
      })
    }
    return r
  })
  handle(IPC.importBookFromUrl, async (_e, url: string) => {
    recordTelemetry('book_import_started', { source_class: 'url', format: 'unknown' })
    const result = await importBookFromUrl(url)
    if (result.ok) {
      const chapters = result.data?.chapters || 0
      recordTelemetry('book_import_completed', {
        source_class: 'url', format: 'unknown',
        chapter_count_bucket: chapters <= 3 ? '1-3' : chapters <= 10 ? '4-10' : chapters <= 25 ? '11-25' : '26+'
      })
    } else {
      recordTelemetry('book_import_failed', { source_class: 'url', format: 'unknown', error_code: result.code || 'UNKNOWN' })
    }
    return result
  })
  handle(IPC.deleteBook, (_e, bookId: string, nextState: Record<string, unknown>) => {
    if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState) || Buffer.byteLength(JSON.stringify(nextState)) > 20 * 1024 * 1024) {
      throw new Error('state payload is invalid or too large')
    }
    return deleteBook(bookId, nextState)
  })
  handle(IPC.deleteAllLocalData, () => deleteAllLocalData())
  handle(IPC.bookExcerpt, (_e, bookId: string) => bookExcerpt(bookId))
  handle(IPC.recognize, (_e, base64: string, mime: string) =>
    recognize(boundedString(base64, 'audio', 35_000_000), boundedString(mime, 'mime', 100)))
  handle(IPC.importBook, async () => {
    recordTelemetry('book_import_started', { source_class: 'file', format: 'unknown' })
    const result = await importBook()
    if (result.ok) {
      const chapters = result.data?.chapters || 0
      recordTelemetry('book_import_completed', {
        source_class: 'file', format: 'unknown',
        chapter_count_bucket: chapters <= 3 ? '1-3' : chapters <= 10 ? '4-10' : chapters <= 25 ? '11-25' : '26+'
      })
    } else if (result.error !== 'Отменено') {
      recordTelemetry('book_import_failed', { source_class: 'file', format: 'unknown', error_code: result.code || 'UNKNOWN' })
    }
    return result
  })
  handle(IPC.saveBookCharacters, (_e, bookId: string, characters: unknown) =>
    saveBookCharacters(bookId, characters as never)
  )

  on(
    IPC.chatStart,
    async (e, payload: { requestId: string; messages: LlmMessage[]; temperature?: number }) => {
      const requestId = boundedString(payload?.requestId, 'requestId', 36)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new Error('requestId: invalid UUID')
      }
      const messages = llmMessages(payload?.messages)
      const temperature = payload?.temperature
      if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
        throw new Error('temperature: invalid value')
      }
      const signal = { aborted: false }
      chatSignals.set(requestId, signal)
      const wc = e.sender
      const res = await chatStream(
        messages,
        (delta) => {
          if (!wc.isDestroyed()) wc.send(IPC.chatChunk, { requestId, delta })
        },
        signal,
        temperature,
        'character_chat',
        requestId
      )
      chatSignals.delete(requestId)
      if (wc.isDestroyed()) return
      if (res.ok) wc.send(IPC.chatDone, { requestId, text: res.data!.text })
      else wc.send(IPC.chatError, { requestId, error: res.error, code: res.code })
    }
  )

  on(IPC.chatCancel, (_e, requestId: string) => {
    const s = chatSignals.get(requestId)
    if (s) s.aborted = true
  })
}

app.whenReady().then(async () => {
  const pendingBookDeletes = await cleanupPendingBookDeletes()
  if (pendingBookDeletes) console.error(`[privacy] ${pendingBookDeletes} staged book tombstones still need deletion`)
  registerAppProtocol()
  registerIpc()
  startTelemetry()
  const installedUpdate = consumeInstalledUpdateVersion(app.getVersion())
  if (installedUpdate) {
    // A successful launch of the exact downloaded version is the first point
    // where native signature/install validation is definitively complete.
    recordTelemetry('update_verified', { version: installedUpdate, success: true })
    recordTelemetry('update_installed', { version: installedUpdate })
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', stopTelemetry)
