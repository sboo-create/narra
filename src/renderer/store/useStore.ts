import { create } from 'zustand'
import type {
  BookContent,
  Character,
  ChapterScenario,
  ChatMessage,
  Fanfic,
  ProxyHealth,
  SaluteVoice,
  Settings
} from '@shared/types'
import { DEFAULT_NARRATOR_VOICE, isSaluteVoice } from '@shared/types'
import { cancelPreparedBook } from '../lib/scenario'

export interface CharStat {
  asked: number
  lastTopic: string
  lastReadChapter: number
}

export interface Bookmark {
  id: string
  chapter: number
  block: number
  quote: string
  ts: number
}

export interface Note extends Bookmark {
  note: string
}

export interface ReaderPrefs {
  fontSize: number // 15..26
  lineHeight: number // 1.4..2.2
  font: 'serif' | 'sans'
  theme: 'original' | 'quiet' | 'paper' | 'accent' | 'calm' | 'focus'
  width: 'narrow' | 'normal' | 'wide'
  paged: boolean // постранично vs лента
}

export const defaultReaderPrefs: ReaderPrefs = {
  fontSize: 19,
  lineHeight: 1.75,
  font: 'serif',
  theme: 'original',
  width: 'normal',
  paged: false
}

export interface Persisted {
  chapters: Record<string, number> // bookId -> текущая глава
  chats: Record<string, ChatMessage[]>
  stats: Record<string, CharStat>
  versions: Record<string, string>
  covers: Record<string, boolean>
  summaries: Record<string, string> // ключ `${bookId}-${chapter}`
  scenarios: Record<string, ChapterScenario> // ключ `${bookId}-${chapter}`
  voiceOverrides: Record<string, SaluteVoice>
  memories: Record<string, string>
  sceneAnchors: Record<string, number> // ключ `${bookId}-${chapter}`
  extraScenes: Record<string, number[]> // доп. иллюстрации по выделению: ключ `${bookId}-${chapter}`
  anchorLists: Record<string, number[]> // точки сцен в главе (индексы блоков): ключ `${bookId}-${chapter}`
  bookmarks: Record<string, Bookmark[]> // ключ bookId
  notes: Record<string, Note[]> // ключ bookId
  hiddenBooks: string[] // встроенные книги, убранные пользователем с полки
  readerPrefs: ReaderPrefs
}

export interface Toast {
  id: string
  type: 'error' | 'success' | 'info'
  title: string
  message?: string
  onRetry?: () => void
  actionLabel?: string // подпись кнопки onRetry (по умолчанию «↻ Повторить»)
}

export type Route =
  | { name: 'library' }
  | { name: 'book' }
  | { name: 'reader' }
  | { name: 'character'; id: string; sceneContext?: string }
  | { name: 'chat'; id: string; sceneContext?: string; autoAsk?: string }
  | { name: 'profile' }
  | { name: 'settings' }

interface StoreState {
  ready: boolean
  books: BookContent[]
  activeBookId: string
  fanfic: Fanfic | null
  characters: Character[]
  narratorVoice: SaluteVoice
  chapter: number // текущая глава активной книги
  settings: Settings | null
  health: ProxyHealth['services'] | null
  checkingHealth: boolean
  persisted: Persisted
  route: Route
  toasts: Toast[]

  init: () => Promise<void>
  navigate: (r: Route) => void
  setActiveBook: (id: string) => void
  reloadSettings: () => Promise<void>
  reloadBooks: () => Promise<void>
  checkHealth: () => Promise<void>

  setChapter: (n: number) => void
  setChats: (charId: string, msgs: ChatMessage[]) => void
  recordAsk: (charId: string, topic: string, readChapter: number) => void
  setVersion: (key: string, text: string) => void
  markGenerated: (key: string) => void
  setSummary: (key: string, text: string) => void
  setScenario: (key: string, sc: ChapterScenario) => void
  setVoiceOverride: (charId: string, voice: SaluteVoice) => void
  setMemory: (charId: string, text: string) => void
  setSceneAnchor: (key: string, index: number) => void
  addExtraScene: (key: string, index: number) => void
  setAnchorList: (key: string, list: number[]) => void
  setReaderPrefs: (patch: Partial<ReaderPrefs>) => void
  toggleBookmark: (bookId: string, b: Omit<Bookmark, 'id' | 'ts'>) => void
  removeBookmark: (bookId: string, id: string) => void
  addNote: (bookId: string, n: Omit<Note, 'id' | 'ts'>) => void
  removeNote: (bookId: string, id: string) => void
  clearChat: (charId: string) => void
  deleteBook: (bookId: string) => Promise<void>

  voiceFor: (charId: string | null) => SaluteVoice
  chapterOf: (bookId: string) => number

  toast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
}

const emptyPersisted: Persisted = {
  chapters: {},
  chats: {},
  stats: {},
  versions: {},
  covers: {},
  summaries: {},
  scenarios: {},
  voiceOverrides: {},
  memories: {},
  sceneAnchors: {},
  extraScenes: {},
  anchorLists: {},
  bookmarks: {},
  notes: {},
  hiddenBooks: [],
  readerPrefs: defaultReaderPrefs
}

/** Старые темы (paper/sepia/night) → новые пресеты. */
function migratePrefs(saved?: Partial<ReaderPrefs>): ReaderPrefs {
  const legacy: Record<string, ReaderPrefs['theme']> = { sepia: 'calm', night: 'quiet', paper: 'original' }
  const p = { ...defaultReaderPrefs, ...(saved || {}) }
  const known = ['original', 'quiet', 'paper', 'accent', 'calm', 'focus']
  if (!known.includes(p.theme)) p.theme = legacy[p.theme as string] || 'original'
  return p
}

/**
 * Ключ данных героя. ВАЖНО: включает книгу — Гермиона из школьного фанфика
 * и Гермиона из другой книги это разные люди со своей перепиской и памятью.
 */
export function charKey(bookId: string, charId: string): string {
  return `${bookId}:${charId}`
}

/** Разовая миграция старых ключей (без книги) — чтобы не потерять уже накопленные чаты. */
function migrateCharKeys(p: Persisted, books: BookContent[]): Persisted {
  const owner = (charId: string): string | null => {
    const found = books.filter((b) => b.characters.some((c) => c.id === charId))
    if (found.length === 0) return null
    // при совпадении имени в разных книгах старые чаты принадлежат встроенной книге
    const builtin = found.find((b) => !b.fanfic.id.startsWith('u-'))
    return (builtin || found[0]).fanfic.id
  }
  const fix = <T,>(rec: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(rec)) {
      if (k.includes(':')) {
        out[k] = v
        continue
      }
      const bookId = owner(k)
      out[bookId ? charKey(bookId, k) : k] = v
    }
    return out
  }
  const migratedVoices = Object.fromEntries(
    Object.entries(fix(p.voiceOverrides)).filter((entry): entry is [string, SaluteVoice] => isSaluteVoice(entry[1]))
  )
  return {
    ...p,
    chats: fix(p.chats),
    memories: fix(p.memories),
    stats: fix(p.stats),
    voiceOverrides: migratedVoices
  }
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingStateWrite: Promise<unknown> = Promise.resolve()
let persistenceSuspended = false
function persist(p: Persisted) {
  if (persistenceSuspended) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (persistenceSuspended) return
    pendingStateWrite = window.narra
      .setState(p as unknown as Record<string, unknown>)
      .catch(() => undefined)
  }, 350)
}

export async function suspendStatePersistence(): Promise<void> {
  persistenceSuspended = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  await pendingStateWrite.catch(() => undefined)
}


export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  books: [],
  activeBookId: '',
  fanfic: null,
  characters: [],
  narratorVoice: DEFAULT_NARRATOR_VOICE,
  chapter: 1,
  settings: null,
  health: null,
  checkingHealth: false,
  persisted: emptyPersisted,
  route: { name: 'library' },
  toasts: [],

  init: async () => {
    try {
      if (!window.narra) throw new Error('Мост Electron недоступен (запусти через npm run dev).')
      const [booksRes, settings, state] = await Promise.all([
        window.narra.loadBooks(),
        window.narra.getSettings(),
        window.narra.getState()
      ])
      const saved = (state || {}) as Partial<Persisted>
      const persisted: Persisted = {
        ...emptyPersisted,
        ...saved,
        readerPrefs: migratePrefs(saved.readerPrefs)
      }
      const hidden = new Set(persisted.hiddenBooks || [])
      const books = (booksRes.ok ? booksRes.data! : []).filter((b) => !hidden.has(b.fanfic.id))
      const migrated = migrateCharKeys(persisted, books)
      const active = books[0]
      set({
        ready: true,
        books,
        activeBookId: active?.fanfic.id || '',
        fanfic: active?.fanfic || null,
        characters: active?.characters || [],
        narratorVoice: active?.narratorVoice || DEFAULT_NARRATOR_VOICE,
        chapter: active ? persisted.chapters[active.fanfic.id] || 1 : 1,
        settings,
        persisted: migrated
      })
      if (!booksRes.ok) get().toast({ type: 'error', title: 'Книги не загрузились', message: booksRes.error })
      get().checkHealth()
    } catch (e) {
      set({ ready: true, settings: null })
      get().toast({ type: 'error', title: 'Ошибка запуска', message: (e as Error).message })
    }
  },

  navigate: (r) => {
    if (r.name === 'character') void window.narra.trackEvent('character_opened', { feature: 'character' })
    if (r.name === 'chat') void window.narra.trackEvent('chat_opened', { feature: 'chat' })
    set({ route: r })
  },

  setActiveBook: (id) => {
    const book = get().books.find((b) => b.fanfic.id === id)
    if (!book) return
    set({
      activeBookId: id,
      fanfic: book.fanfic,
      characters: book.characters,
      narratorVoice: book.narratorVoice,
      chapter: get().persisted.chapters[id] || 1
    })
  },

  reloadSettings: async () => {
    const settings = await window.narra.getSettings()
    set({ settings })
  },

  reloadBooks: async () => {
    const res = await window.narra.loadBooks()
    if (res.ok) {
      const hidden = new Set(get().persisted.hiddenBooks || [])
      const books = res.data!.filter((b) => !hidden.has(b.fanfic.id))
      const active = books.find((book) => book.fanfic.id === get().activeBookId)
      set({
        books,
        ...(active
          ? {
              fanfic: active.fanfic,
              characters: active.characters,
              narratorVoice: active.narratorVoice
            }
          : {})
      })
    }
  },

  checkHealth: async () => {
    set({ checkingHealth: true })
    const res = await window.narra.testProxy()
    set({ checkingHealth: false, health: res.ok ? res.data!.services : null })
  },

  setChapter: (n) => {
    const id = get().activeBookId
    const p = { ...get().persisted, chapters: { ...get().persisted.chapters, [id]: n } }
    set({ persisted: p, chapter: n })
    persist(p)
    const bucket = n <= 3 ? '1-3' : n <= 10 ? '4-10' : n <= 25 ? '11-25' : '26+'
    void window.narra.trackEvent('chapter_changed', {
      navigation_type: 'reader',
      chapter_position_bucket: bucket
    })
  },
  setChats: (charId, msgs) => {
    const k = charKey(get().activeBookId, charId)
    const p = { ...get().persisted, chats: { ...get().persisted.chats, [k]: msgs } }
    set({ persisted: p })
    persist(p)
  },
  recordAsk: (charId, topic, readChapter) => {
    const k = charKey(get().activeBookId, charId)
    const prev = get().persisted.stats[k] || { asked: 0, lastTopic: '', lastReadChapter: readChapter }
    const stat: CharStat = { asked: prev.asked + 1, lastTopic: topic, lastReadChapter: readChapter }
    const p = { ...get().persisted, stats: { ...get().persisted.stats, [k]: stat } }
    set({ persisted: p })
    persist(p)
  },
  setVersion: (key, text) => {
    const p = { ...get().persisted, versions: { ...get().persisted.versions, [key]: text } }
    set({ persisted: p })
    persist(p)
  },
  markGenerated: (key) => {
    const p = { ...get().persisted, covers: { ...get().persisted.covers, [key]: true } }
    set({ persisted: p })
    persist(p)
  },
  setSummary: (key, text) => {
    const p = { ...get().persisted, summaries: { ...get().persisted.summaries, [key]: text } }
    set({ persisted: p })
    persist(p)
  },
  setScenario: (key, sc) => {
    const p = { ...get().persisted, scenarios: { ...get().persisted.scenarios, [key]: sc } }
    set({ persisted: p })
    persist(p)
  },
  setVoiceOverride: (charId, voice) => {
    const k = charKey(get().activeBookId, charId)
    const p = { ...get().persisted, voiceOverrides: { ...get().persisted.voiceOverrides, [k]: voice } }
    set({ persisted: p })
    persist(p)
  },
  setMemory: (charId, text) => {
    const k = charKey(get().activeBookId, charId)
    const p = { ...get().persisted, memories: { ...get().persisted.memories, [k]: text } }
    set({ persisted: p })
    persist(p)
  },
  setSceneAnchor: (key, index) => {
    const p = { ...get().persisted, sceneAnchors: { ...get().persisted.sceneAnchors, [key]: index } }
    set({ persisted: p })
    persist(p)
  },
  setAnchorList: (key, list) => {
    const p = { ...get().persisted, anchorLists: { ...get().persisted.anchorLists, [key]: list } }
    set({ persisted: p })
    persist(p)
  },
  addExtraScene: (key, index) => {
    const prev = get().persisted.extraScenes[key] || []
    if (prev.includes(index)) return
    const p = { ...get().persisted, extraScenes: { ...get().persisted.extraScenes, [key]: [...prev, index] } }
    set({ persisted: p })
    persist(p)
  },

  setReaderPrefs: (patch) => {
    const p = { ...get().persisted, readerPrefs: { ...get().persisted.readerPrefs, ...patch } }
    set({ persisted: p })
    persist(p)
  },
  toggleBookmark: (bookId, b) => {
    const list = get().persisted.bookmarks[bookId] || []
    const same = list.find((x) => x.chapter === b.chapter && x.block === b.block)
    const next = same
      ? list.filter((x) => x.id !== same.id)
      : [...list, { ...b, id: uid(), ts: Date.now() }]
    const p = { ...get().persisted, bookmarks: { ...get().persisted.bookmarks, [bookId]: next } }
    set({ persisted: p })
    persist(p)
    if (!same) void window.narra.trackEvent('bookmark_added', { feature: 'bookmark' })
  },
  removeBookmark: (bookId, id) => {
    const next = (get().persisted.bookmarks[bookId] || []).filter((x) => x.id !== id)
    const p = { ...get().persisted, bookmarks: { ...get().persisted.bookmarks, [bookId]: next } }
    set({ persisted: p })
    persist(p)
  },
  addNote: (bookId, n) => {
    const next = [...(get().persisted.notes[bookId] || []), { ...n, id: uid(), ts: Date.now() }]
    const p = { ...get().persisted, notes: { ...get().persisted.notes, [bookId]: next } }
    set({ persisted: p })
    persist(p)
    void window.narra.trackEvent('note_added', { feature: 'note' })
  },
  removeNote: (bookId, id) => {
    const next = (get().persisted.notes[bookId] || []).filter((x) => x.id !== id)
    const p = { ...get().persisted, notes: { ...get().persisted.notes, [bookId]: next } }
    set({ persisted: p })
    persist(p)
  },
  clearChat: (charId) => {
    const k = charKey(get().activeBookId, charId)
    const chats = { ...get().persisted.chats }
    delete chats[k]
    const memories = { ...get().persisted.memories }
    delete memories[k]
    const stats = { ...get().persisted.stats }
    delete stats[k]
    const p = { ...get().persisted, chats, memories, stats }
    set({ persisted: p })
    persist(p)
  },
  deleteBook: async (bookId) => {
    const cancelledPreparations = cancelPreparedBook(bookId)
    for (const origin of cancelledPreparations) {
      void window.narra.trackEvent('media_job_cancelled', {
        job_type: 'chapter_markup',
        queue_or_running: 'running',
        origin
      })
    }
    const res = await window.narra.deleteBook(bookId)
    if (!res.ok) {
      const message = res.error || 'Не удалось удалить локальные данные книги'
      get().toast({ type: 'error', title: 'Книга не удалена', message })
      throw new Error(message)
    }
    // Apply the cleanup to the latest renderer state after the async delete,
    // preserving unrelated changes made while files/cache were being removed.
    const st = get().persisted
    const belongsToBook = (key: string) =>
      key === bookId ||
      key.startsWith(`${bookId}-`) ||
      key.startsWith(`${bookId}:`) ||
      key.includes(`-${bookId}-`)
    const dropBook = <T,>(rec: Record<string, T>) =>
      Object.fromEntries(Object.entries(rec).filter(([key]) => !belongsToBook(key)))
    const chapters = { ...st.chapters }
    delete chapters[bookId]
    const bookmarks = { ...st.bookmarks }
    delete bookmarks[bookId]
    const notes = { ...st.notes }
    delete notes[bookId]
    const p: Persisted = {
      ...st,
      chapters,
      bookmarks,
      notes,
      chats: dropBook(st.chats),
      stats: dropBook(st.stats),
      versions: dropBook(st.versions),
      covers: dropBook(st.covers),
      summaries: dropBook(st.summaries),
      scenarios: dropBook(st.scenarios),
      voiceOverrides: dropBook(st.voiceOverrides),
      memories: dropBook(st.memories),
      sceneAnchors: dropBook(st.sceneAnchors),
      extraScenes: dropBook(st.extraScenes),
      anchorLists: dropBook(st.anchorLists),
      hiddenBooks:
        !bookId.startsWith('u-') ? [...new Set([...st.hiddenBooks, bookId])] : st.hiddenBooks
    }
    set({ persisted: p })
    if (res.data?.cleanupPending) {
      get().toast({
        type: 'info',
        title: 'Книга скрыта',
        message: 'Остаток файла будет повторно удалён при следующем запуске.'
      })
    }
    await get().reloadBooks()
  },

  voiceFor: (charId) => {
    const st = get()
    if (!charId) return st.narratorVoice
    const override = st.persisted.voiceOverrides[charKey(st.activeBookId, charId)]
    if (override) return override
    const c = st.characters.find((x) => x.id === charId)
    return c?.voice || st.narratorVoice
  },
  chapterOf: (bookId) => get().persisted.chapters[bookId] || 1,

  toast: (t) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    set({ toasts: [...get().toasts, { ...t, id }] })
    if (t.type !== 'error') setTimeout(() => get().dismissToast(id), 4200)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) })
}))

export function canChat(h: ProxyHealth['services'] | null): boolean {
  return !!h?.gigachat
}
export function canImage(h: ProxyHealth['services'] | null): boolean {
  return !!h?.kandinsky
}
export function canTts(h: ProxyHealth['services'] | null): boolean {
  return !!h?.salutespeech
}
