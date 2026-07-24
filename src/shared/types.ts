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
export const AUTO_MALE_48K_VOICES = ['Ast', 'Gal', 'Bez', 'Ego', 'Izv'] as const
export const AUTO_FEMALE_48K_VOICES = ['Ste', 'Tso', 'Chr'] as const
export const AUTO_MALE_24K_VOICES = [
  'Ana', 'Ann', 'Bek', 'Boc', 'Chp', 'Dsu', 'Klu', 'Min', 'Mir', 'Ovs',
  'San', 'Sdo', 'Shc', 'Shl', 'Sid', 'Sto', 'Str', 'Tar', 'Tre', 'Uso',
  'Vol'
] as const
export const AUTO_FEMALE_24K_VOICES = [
  'Aer', 'Bal', 'Buz', 'Dad', 'Dyu', 'Kab', 'Kud', 'Mak', 'Sko', 'Smi',
  'Sne', 'Sta', 'Ved'
] as const
export const AUTO_MALE_VOICES = [...AUTO_MALE_48K_VOICES, ...AUTO_MALE_24K_VOICES] as const
export const AUTO_FEMALE_VOICES = [...AUTO_FEMALE_48K_VOICES, ...AUTO_FEMALE_24K_VOICES] as const
export const CHILD_MALE_VOICES = ['Ksa', 'Kkr', 'Ktr'] as const
export const CHILD_FEMALE_VOICES = ['Saf', 'Bsa', 'Kbu', 'Koz'] as const
export const MANUAL_MALE_VOICES = ['Mar', 'Kas'] as const
// These voices synthesize successfully, but their gender/product role has not
// yet been approved from picker evidence. They remain selectable manually and
// are deliberately excluded from automatic book markup.
export const MANUAL_OTHER_VOICES = [
  'Aso', 'Bai', 'Bik', 'Bol', 'Gav', 'Gri', 'Gur', 'Igr', 'Kai', 'Kar',
  'Ker', 'Kha', 'Kis', 'Kka', 'Kor', 'Kov', 'Lil', 'Mel', 'Nag', 'Ore',
  'Peh', 'Pik', 'Pot', 'Pru', 'Rab', 'Res', 'Roz', 'Rum', 'Shi', 'Tob',
  'Tya', 'Voy'
] as const
export const SALUTE_24K_VOICES = [
  ...AUTO_MALE_24K_VOICES,
  ...AUTO_FEMALE_24K_VOICES,
  'Kkr', 'Ktr', 'Kbu', 'Koz',
  ...MANUAL_OTHER_VOICES
] as const
export const SALUTE_VOICES = [
  ...ASSISTANT_VOICES,
  ...AUTO_MALE_VOICES,
  ...AUTO_FEMALE_VOICES,
  ...CHILD_MALE_VOICES,
  ...CHILD_FEMALE_VOICES,
  ...MANUAL_MALE_VOICES,
  ...MANUAL_OTHER_VOICES
] as const
export type SaluteVoice = (typeof SALUTE_VOICES)[number]
export const DEFAULT_NARRATOR_VOICE: SaluteVoice = 'Che'

export function isSaluteVoice(value: unknown): value is SaluteVoice {
  return typeof value === 'string' && (SALUTE_VOICES as readonly string[]).includes(value)
}

export function saluteVoiceSampleRate(voice: SaluteVoice): 24000 | 48000 {
  return (SALUTE_24K_VOICES as readonly string[]).includes(voice) ? 24000 : 48000
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
  /** True only when the main protagonist is also the first-person narrator. */
  isNarrator?: boolean
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

/**
 * Deterministic book-level assignment. The first character is the protagonist,
 * as required by the markup contract. Assistant voices are reserved for the
 * narrator/protagonist; secondary characters use the reviewed library pools.
 */
export function assignBookCharacterVoices(
  characters: Character[],
  narratorVoice: SaluteVoice
): Character[] {
  let male = 0
  let female = 0
  let childMale = 0
  let childFemale = 0
  return characters.map((character, index) => {
    if (index === 0 && character.isNarrator) {
      return { ...character, voice: narratorVoice }
    }
    if (index === 0 && character.gender === 'male') {
      // If the user selected the only male assistant (Sber) as narrator, do
      // not duplicate it: the hero gets the first male library voice.
      if (narratorVoice === 'She') {
        return { ...character, voice: AUTO_MALE_VOICES[male++ % AUTO_MALE_VOICES.length] }
      }
      return { ...character, voice: 'She' }
    }
    if (index === 0) {
      // Pick the other female assistant deterministically.
      return { ...character, voice: narratorVoice === 'Che' ? 'Erm' : 'Che' }
    }
    const childAge = Number(character.passport?.age)
    const child = Number.isFinite(childAge) && childAge >= 0 && childAge <= 12
    if (child && character.gender === 'female') {
      return {
        ...character,
        voice: CHILD_FEMALE_VOICES[childFemale++ % CHILD_FEMALE_VOICES.length]
      }
    }
    if (child) {
      return {
        ...character,
        voice: CHILD_MALE_VOICES[childMale++ % CHILD_MALE_VOICES.length]
      }
    }
    if (character.gender === 'female') {
      return { ...character, voice: AUTO_FEMALE_VOICES[female++ % AUTO_FEMALE_VOICES.length] }
    }
    return { ...character, voice: AUTO_MALE_VOICES[male++ % AUTO_MALE_VOICES.length] }
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
