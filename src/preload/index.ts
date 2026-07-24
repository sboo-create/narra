import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  ApiResult,
  BookContent,
  LlmMessage,
  ProxyHealth,
  Settings
} from '../shared/types'
import type { AnalyticsEventName, SafeAnalyticsValue } from '../shared/analytics'

export interface ChatHandlers {
  onChunk: (delta: string) => void
  onDone: (text: string) => void
  onError: (error: string, code?: string) => void
}

const api = {
  loadBooks: (): Promise<ApiResult<BookContent[]>> => ipcRenderer.invoke(IPC.loadBooks),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (next: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.setSettings, next),
  trackEvent: (
    name: AnalyticsEventName,
    properties: Record<string, SafeAnalyticsValue> = {}
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.trackEvent, name, properties),
  touchTelemetrySession: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.touchTelemetrySession),

  getState: (): Promise<Record<string, unknown>> => ipcRenderer.invoke(IPC.getState),
  setState: (next: Record<string, unknown>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.setState, next),
  deleteAllLocalData: (): Promise<ApiResult<{ deleted: true }>> =>
    ipcRenderer.invoke(IPC.deleteAllLocalData),

  testProxy: (): Promise<ApiResult<ProxyHealth>> => ipcRenderer.invoke(IPC.testProxy),

  llmJson: <T = unknown>(
    messages: LlmMessage[],
    origin: 'user' | 'background' = 'user'
  ): Promise<ApiResult<T>> =>
    ipcRenderer.invoke(IPC.llmJson, messages, origin),
  llmText: (
    messages: LlmMessage[],
    temperature?: number,
    origin: 'user' | 'background' = 'user'
  ): Promise<ApiResult<{ text: string }>> =>
    ipcRenderer.invoke(IPC.llmText, messages, temperature, origin),

  generateImage: (
    prompt: string,
    cacheKey?: string,
    width?: number,
    height?: number,
    force?: boolean,
    engine?: 'kandinsky',
    origin?: 'user' | 'background'
  ): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> =>
    ipcRenderer.invoke(IPC.generateImage, prompt, cacheKey, width, height, force, engine, origin),
  getCachedImage: (cacheKey: string): Promise<ApiResult<{ dataUrl: string }>> =>
    ipcRenderer.invoke(IPC.getCachedImage, cacheKey),

  synthesize: (
    payload: { text?: string; ssml?: string; voice: string },
    cacheKey?: string,
    origin?: 'user' | 'background'
  ): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> =>
    ipcRenderer.invoke(IPC.synthesize, payload, cacheKey, origin),
  getCachedAudio: (cacheKey: string): Promise<ApiResult<{ dataUrl: string }>> =>
    ipcRenderer.invoke(IPC.getCachedAudio, cacheKey),

  generateAvatar: (
    imageDataUrl: string,
    audioDataUrl: string,
    cacheKey?: string,
    origin?: 'user' | 'background'
  ): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> =>
    ipcRenderer.invoke(IPC.generateAvatar, imageDataUrl, audioDataUrl, cacheKey, origin),
  getCachedVideo: (cacheKey: string): Promise<ApiResult<{ dataUrl: string }>> =>
    ipcRenderer.invoke(IPC.getCachedVideo, cacheKey),
  animatePortrait: (
    imageDataUrl: string,
    query: string,
    cacheKey?: string,
    quality?: 'lite' | 'hd',
    origin?: 'user' | 'background'
  ): Promise<ApiResult<{ dataUrl: string; cached: boolean }>> =>
    ipcRenderer.invoke(IPC.animatePortrait, imageDataUrl, query, cacheKey, quality, origin),
  deleteCachedImage: (cacheKey: string): Promise<ApiResult<{ ok: true }>> =>
    ipcRenderer.invoke(IPC.deleteCachedImage, cacheKey),
  deleteCachedVideo: (cacheKey: string): Promise<ApiResult<{ ok: true }>> =>
    ipcRenderer.invoke(IPC.deleteCachedVideo, cacheKey),
  saveCachedVideo: (cacheKey: string, dataUrl: string): Promise<ApiResult<{ ok: true }>> =>
    ipcRenderer.invoke(IPC.saveCachedVideo, cacheKey, dataUrl),
  checkAppUpdate: (): Promise<ApiResult<{ hasUpdate: boolean; version: string }>> =>
    ipcRenderer.invoke(IPC.checkAppUpdate),
  installUpdate: (): Promise<ApiResult<{ started: true; version: string }>> =>
    ipcRenderer.invoke(IPC.installUpdate),
  deleteBook: (bookId: string): Promise<ApiResult<{ builtin: boolean; cleanupPending?: boolean }>> =>
    ipcRenderer.invoke(IPC.deleteBook, bookId),
  bookExcerpt: (bookId: string): Promise<ApiResult<{ title: string; author: string; excerpt: string }>> =>
    ipcRenderer.invoke(IPC.bookExcerpt, bookId),
  importBookFromUrl: (
    url: string
  ): Promise<ApiResult<{
    id: string
    title: string
    author: string
    chapters: number
    words: number
    excerpt: string
    format: 'html'
    sizeBucket: '<1mb' | '1-9mb' | '10-39mb'
  }>> =>
    ipcRenderer.invoke(IPC.importBookFromUrl, url),
  recognize: (base64: string, mime: string): Promise<ApiResult<{ text: string }>> =>
    ipcRenderer.invoke(IPC.recognize, base64, mime),
  importBook: (): Promise<ApiResult<{
    id: string
    title: string
    author: string
    chapters: number
    words: number
    excerpt: string
    format: 'epub' | 'fb2' | 'txt' | 'pdf' | 'unknown'
    sizeBucket: '<1mb' | '1-9mb' | '10-39mb'
  }>> =>
    ipcRenderer.invoke(IPC.importBook),
  saveBookCharacters: (
    bookId: string,
    narratorVoice: string,
    characters: unknown
  ): Promise<ApiResult<{ ok: true }>> =>
    ipcRenderer.invoke(IPC.saveBookCharacters, bookId, narratorVoice, characters),

  chat: (messages: LlmMessage[], handlers: ChatHandlers, temperature?: number): (() => void) => {
    const requestId = crypto.randomUUID()
    const onChunk = (_e: unknown, p: { requestId: string; delta: string }) => {
      if (p.requestId === requestId) handlers.onChunk(p.delta)
    }
    const onDone = (_e: unknown, p: { requestId: string; text: string }) => {
      if (p.requestId === requestId) {
        cleanup()
        handlers.onDone(p.text)
      }
    }
    const onError = (_e: unknown, p: { requestId: string; error: string; code?: string }) => {
      if (p.requestId === requestId) {
        cleanup()
        handlers.onError(p.error, p.code)
      }
    }
    const cleanup = () => {
      ipcRenderer.off(IPC.chatChunk, onChunk)
      ipcRenderer.off(IPC.chatDone, onDone)
      ipcRenderer.off(IPC.chatError, onError)
    }
    ipcRenderer.on(IPC.chatChunk, onChunk)
    ipcRenderer.on(IPC.chatDone, onDone)
    ipcRenderer.on(IPC.chatError, onError)
    ipcRenderer.send(IPC.chatStart, { requestId, messages, temperature })
    return () => {
      ipcRenderer.send(IPC.chatCancel, requestId)
      cleanup()
    }
  }
}

export type NarraApi = typeof api
contextBridge.exposeInMainWorld('narra', api)
