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
export const ASSISTANT_VOICES = ['Che', 'She', 'Erm'] as const
export const AUTO_MALE_VOICES = ['Ast', 'Gal', 'Bez', 'Ego', 'Izv'] as const
export const AUTO_FEMALE_VOICES = ['Ste', 'Tso', 'Chr'] as const
export const CHILD_MALE_VOICES = ['Ksa'] as const
export const CHILD_FEMALE_VOICES = ['Saf', 'Bsa'] as const
export const MANUAL_MALE_VOICES = ['Mar', 'Kas'] as const
export const SALUTE_VOICES = [
  ...ASSISTANT_VOICES,
  ...AUTO_MALE_VOICES,
  ...AUTO_FEMALE_VOICES,
  ...CHILD_MALE_VOICES,
  ...CHILD_FEMALE_VOICES,
  ...MANUAL_MALE_VOICES
] as const
export type SaluteVoice = (typeof SALUTE_VOICES)[number]
export const DEFAULT_NARRATOR_VOICE: SaluteVoice = 'Che'

export function isSaluteVoice(value: unknown): value is SaluteVoice {
  return typeof value === 'string' && (SALUTE_VOICES as readonly string[]).includes(value)
}

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

export function normalizeNarratorVoice(value: unknown): SaluteVoice {
  return isSaluteVoice(value) ? value : DEFAULT_NARRATOR_VOICE
}

export function normalizeCharacterVoices(characters: Character[]): Character[] {
  let male = 0
  let female = 0
  return characters.map((character) => {
    if (isSaluteVoice(character.voice)) return character
    const pool = character.gender === 'female' ? AUTO_FEMALE_VOICES : AUTO_MALE_VOICES
    const index = character.gender === 'female' ? female++ : male++
    return { ...character, voice: pool[index % pool.length] }
  })
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
  /** Детальная продуктовая аналитика; минимальная обезличенная телеметрия обязательна. */
  extendedTelemetryEnabled: boolean
}

export interface ProxyHealth {
  ok: boolean
  services: {
    gigachat: boolean
    salutespeech: boolean
    kandinsky: boolean
    video: boolean
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
  code?: 'NO_PROXY' | 'NO_KEY' | 'AUTH' | 'TIMEOUT' | 'RATE' | 'PARSE' | 'CENSOR' | 'VALIDATION' | 'NETWORK' | 'UNKNOWN'
}

// ===== Сообщения для LLM =====
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LlmPurpose =
  | 'character_chat'
  | 'structured_task'
  | 'summary'
  | 'scenario'
  | 'memory'
