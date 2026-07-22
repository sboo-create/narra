import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'path'
import { IPC } from '../shared/ipc'
import type { LlmMessage, Settings } from '../shared/types'
import { getSettings, setSettings, getAppState, setAppState } from './store'
import { loadBooks } from './content'
import { importBook, importBookFromUrl, saveBookCharacters, deleteBook, bookExcerpt } from './importer'
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
  checkAppUpdate,
  installUpdate,
  recognize
} from './api/proxy'

let mainWindow: BrowserWindow | null = null

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
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const chatSignals = new Map<string, { aborted: boolean }>()

function registerIpc(): void {
  ipcMain.handle(IPC.loadBooks, async () => {
    try {
      return { ok: true, data: await loadBooks() }
    } catch (e) {
      return { ok: false, error: `Не удалось загрузить книги: ${(e as Error).message}` }
    }
  })

  ipcMain.handle(IPC.getSettings, () => getSettings())
  ipcMain.handle(IPC.setSettings, (_e, next: Partial<Settings>) => setSettings(next))

  ipcMain.handle(IPC.getState, () => getAppState())
  ipcMain.handle(IPC.setState, (_e, next: Record<string, unknown>) => {
    setAppState(next)
    return { ok: true }
  })

  ipcMain.handle(IPC.testProxy, () => testProxy())

  ipcMain.handle(IPC.llmJson, (_e, messages: LlmMessage[]) => chatJson(messages))
  ipcMain.handle(IPC.llmText, (_e, messages: LlmMessage[], temperature?: number) =>
    chatComplete(messages, temperature)
  )

  ipcMain.handle(
    IPC.generateImage,
    (_e, prompt: string, cacheKey?: string, w?: number, h?: number, force?: boolean, engine?: 'kandinsky') =>
      generateImage(prompt, cacheKey, w, h, force, engine)
  )
  ipcMain.handle(IPC.getCachedImage, (_e, cacheKey: string) => getCachedImage(cacheKey))

  ipcMain.handle(
    IPC.synthesize,
    (_e, payload: { text?: string; ssml?: string; voice: string }, cacheKey?: string) =>
      synthesize(payload, cacheKey)
  )
  ipcMain.handle(IPC.getCachedAudio, (_e, cacheKey: string) => getCachedAudio(cacheKey))

  ipcMain.handle(
    IPC.generateAvatar,
    (_e, imageDataUrl: string, audioDataUrl: string, cacheKey?: string) =>
      generateAvatar(imageDataUrl, audioDataUrl, cacheKey)
  )
  ipcMain.handle(IPC.getCachedVideo, (_e, cacheKey: string) => getCachedVideo(cacheKey))
  ipcMain.handle(
    IPC.animatePortrait,
    (_e, imageDataUrl: string, query: string, cacheKey?: string, quality?: 'lite' | 'hd') =>
      animatePortrait(imageDataUrl, query, cacheKey, quality)
  )
  ipcMain.handle(IPC.deleteCachedImage, (_e, cacheKey: string) => deleteCachedImage(cacheKey))
  ipcMain.handle(IPC.deleteCachedVideo, (_e, cacheKey: string) => deleteCachedVideo(cacheKey))
  ipcMain.handle(IPC.saveCachedVideo, (_e, cacheKey: string, dataUrl: string) => saveCachedVideo(cacheKey, dataUrl))
  ipcMain.handle(IPC.checkAppUpdate, () => checkAppUpdate(app.getVersion()))
  ipcMain.handle(IPC.installUpdate, async (_e, url: string) => {
    const r = await installUpdate(url)
    if (r.ok) setTimeout(() => app.quit(), 400) // скрипт дождётся выхода и подменит приложение
    return r
  })
  ipcMain.handle(IPC.importBookFromUrl, (_e, url: string) => importBookFromUrl(url))
  ipcMain.handle(IPC.deleteBook, (_e, bookId: string) => deleteBook(bookId))
  ipcMain.handle(IPC.bookExcerpt, (_e, bookId: string) => bookExcerpt(bookId))
  ipcMain.handle(IPC.recognize, (_e, base64: string, mime: string) => recognize(base64, mime))
  ipcMain.handle(IPC.importBook, () => importBook())
  ipcMain.handle(IPC.saveBookCharacters, (_e, bookId: string, characters: unknown) =>
    saveBookCharacters(bookId, characters as never)
  )

  ipcMain.on(
    IPC.chatStart,
    async (e, payload: { requestId: string; messages: LlmMessage[]; temperature?: number }) => {
      const { requestId, messages, temperature } = payload
      const signal = { aborted: false }
      chatSignals.set(requestId, signal)
      const wc = e.sender
      const res = await chatStream(
        messages,
        (delta) => {
          if (!wc.isDestroyed()) wc.send(IPC.chatChunk, { requestId, delta })
        },
        signal,
        temperature
      )
      chatSignals.delete(requestId)
      if (wc.isDestroyed()) return
      if (res.ok) wc.send(IPC.chatDone, { requestId, text: res.data!.text })
      else wc.send(IPC.chatError, { requestId, error: res.error, code: res.code })
    }
  )

  ipcMain.on(IPC.chatCancel, (_e, requestId: string) => {
    const s = chatSignals.get(requestId)
    if (s) s.aborted = true
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
