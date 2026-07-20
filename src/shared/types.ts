// ===== Контент =====
export interface Chapter {
  number: number
  title: string
  summary: string
  characters: string[]
  text: string
}

export interface Fanfic {
  id: string
  title: string
  author: string
  source?: string
  pairing: string
  tags: string[]
  description: string
  coverPrompt: string
  chapters: Chapter[]
}

export type Gender = 'male' | 'female'
export type SaluteVoice = 'Nec' | 'Bys' | 'May' | 'Tur' | 'Ost' | 'Pon'

export interface ExampleTurn {
  user: string
  char: string
}

export interface Passport {
  age: number
  gender: Gender
  build: string
  hair: string
  eyes: string
  face: string
  outfit: string
}

export interface Character {
  id: string
  name: string
  fullName: string
  role: string
  gender: Gender
  voice: SaluteVoice
  traits: string[]
  speechStyle: string
  speechExamples: string[]
  appearancePrompt: string
  passport?: Passport
  expression?: string // выражение лица для портрета — из характера
  unlockChapter?: number // герой открывается с этой главы
  greeting?: string
  exampleDialogue?: ExampleTurn[]
  idleAnimation?: string
}

export interface CharactersFile {
  narratorVoice: SaluteVoice
  characters: Character[]
}

export interface BookContent {
  fanfic: Fanfic
  narratorVoice: SaluteVoice
  characters: Character[]
}

// ===== Настройки =====
// Ключи живут на прокси-сервере (Railway). В приложении хранится только URL прокси.
export interface Settings {
  proxyUrl: string
}

export interface ProxyHealth {
  ok: boolean
  services: {
    gigachat: boolean
    salutespeech: boolean
    kandinsky: boolean
  }
}

// ===== Чат =====
export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  ts: number
}

// ===== Озвучка: сценарий главы =====
export type Emotion =
  | 'neutral'
  | 'joy'
  | 'tenderness'
  | 'anger'
  | 'fear'
  | 'irony'
  | 'sadness'

export interface Segment {
  type: 'narration' | 'speech'
  character: string | null // id персонажа для speech, null для narration
  emotion: Emotion
  text: string
}

export interface ChapterScenario {
  chapter: number
  segments: Segment[]
}

// ===== Ответ API =====
export interface ApiResult<T> {
  ok: boolean
  data?: T
  error?: string
  code?: 'NO_PROXY' | 'NO_KEY' | 'AUTH' | 'TIMEOUT' | 'RATE' | 'PARSE' | 'NETWORK' | 'UNKNOWN'
}

// ===== Сообщения для LLM =====
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
