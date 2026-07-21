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

export interface CharStat {
  asked: number
  lastTopic: string
  lastReadChapter: number
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
  routeHistory: Route[]
  toasts: Toast[]

  init: () => Promise<void>
  navigate: (r: Route) => void
  goBack: () => boolean
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
  anchorLists: {}
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persist(p: Persisted) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    window.narra.setState(p as unknown as Record<string, unknown>)
  }, 350)
}

function sameRoute(a: Route, b: Route): boolean {
  return (
    a.name === b.name &&
    ('id' in a ? a.id : '') === ('id' in b ? b.id : '') &&
    ('sceneContext' in a ? a.sceneContext : '') === ('sceneContext' in b ? b.sceneContext : '') &&
    ('autoAsk' in a ? a.autoAsk : '') === ('autoAsk' in b ? b.autoAsk : '')
  )
}

export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  books: [],
  activeBookId: '',
  fanfic: null,
  characters: [],
  narratorVoice: 'Pon',
  chapter: 1,
  settings: null,
  health: null,
  checkingHealth: false,
  persisted: emptyPersisted,
  route: { name: 'library' },
  routeHistory: [],
  toasts: [],

  init: async () => {
    try {
      if (!window.narra) throw new Error('Мост Electron недоступен (запусти через npm run dev).')
      const [booksRes, settings, state] = await Promise.all([
        window.narra.loadBooks(),
        window.narra.getSettings(),
        window.narra.getState()
      ])
      const persisted: Persisted = { ...emptyPersisted, ...(state as Partial<Persisted>) }
      const books = booksRes.ok ? booksRes.data! : []
      const active = books[0]
      set({
        ready: true,
        books,
        activeBookId: active?.fanfic.id || '',
        fanfic: active?.fanfic || null,
        characters: active?.characters || [],
        narratorVoice: active?.narratorVoice || 'Pon',
        chapter: active ? persisted.chapters[active.fanfic.id] || 1 : 1,
        settings,
        persisted
      })
      if (!booksRes.ok) get().toast({ type: 'error', title: 'Книги не загрузились', message: booksRes.error })
      get().checkHealth()
    } catch (e) {
      set({ ready: true, settings: null })
      get().toast({ type: 'error', title: 'Ошибка запуска', message: (e as Error).message })
    }
  },

  navigate: (r) => {
    const current = get().route
    if (sameRoute(current, r)) return
    set({
      route: r,
      routeHistory: [...get().routeHistory.slice(-24), current]
    })
  },

  goBack: () => {
    const history = get().routeHistory
    const prev = history[history.length - 1]
    if (!prev) return false
    set({ route: prev, routeHistory: history.slice(0, -1) })
    return true
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
    if (res.ok) set({ books: res.data! })
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
  },
  setChats: (charId, msgs) => {
    const p = { ...get().persisted, chats: { ...get().persisted.chats, [charId]: msgs } }
    set({ persisted: p })
    persist(p)
  },
  recordAsk: (charId, topic, readChapter) => {
    const prev = get().persisted.stats[charId] || { asked: 0, lastTopic: '', lastReadChapter: readChapter }
    const stat: CharStat = { asked: prev.asked + 1, lastTopic: topic, lastReadChapter: readChapter }
    const p = { ...get().persisted, stats: { ...get().persisted.stats, [charId]: stat } }
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
    const p = { ...get().persisted, voiceOverrides: { ...get().persisted.voiceOverrides, [charId]: voice } }
    set({ persisted: p })
    persist(p)
  },
  setMemory: (charId, text) => {
    const p = { ...get().persisted, memories: { ...get().persisted.memories, [charId]: text } }
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

  voiceFor: (charId) => {
    const st = get()
    if (!charId) return st.narratorVoice
    const override = st.persisted.voiceOverrides[charId]
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
