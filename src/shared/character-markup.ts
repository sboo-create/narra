import type { Character } from './types'

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
}

export function characterId(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .split('')
    .map((character) => TRANSLIT[character] ?? character)
    .join('')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24)
}

export interface CharacterMarkupPayload {
  mainCharacterId: string
  firstPersonNarratorCharacterId: string | null
  characters: Partial<Character>[]
}

type SanitizedCharacter = Partial<Character> & { id: string; name: string }

export type NormalizedCharacterMarkup =
  | {
      ok: true
      mainCharacterId: string
      firstPersonNarratorCharacterId: string | null
      characters: SanitizedCharacter[]
    }
  | { ok: false; error: string }

export function normalizeCharacterMarkup(payload: CharacterMarkupPayload): NormalizedCharacterMarkup {
  const mainCharacterId = characterId(payload.mainCharacterId)
  if (!mainCharacterId) return { ok: false, error: 'Модель вернула пустой id главного героя' }

  const firstPersonNarratorCharacterId = payload.firstPersonNarratorCharacterId === null
    ? null
    : characterId(payload.firstPersonNarratorCharacterId)
  if (
    payload.firstPersonNarratorCharacterId !== null &&
    !firstPersonNarratorCharacterId
  ) {
    return { ok: false, error: 'Модель вернула пустой id рассказчика' }
  }
  if (
    firstPersonNarratorCharacterId &&
    firstPersonNarratorCharacterId !== mainCharacterId
  ) {
    return { ok: false, error: 'Модель вернула противоречивого рассказчика' }
  }

  const seen = new Set<string>()
  const characters: SanitizedCharacter[] = []
  for (const candidate of payload.characters) {
    if (!candidate || typeof candidate !== 'object') {
      return { ok: false, error: 'Модель вернула некорректного героя' }
    }
    const id = characterId(candidate.id)
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
    if (!id || !name) {
      return { ok: false, error: 'У героя отсутствует корректный id или имя' }
    }
    if (seen.has(id)) {
      return { ok: false, error: 'Модель вернула дублирующиеся id героев' }
    }
    seen.add(id)
    characters.push({ ...candidate, id, name })
  }

  const mainIndex = characters.findIndex((candidate) => candidate.id === mainCharacterId)
  if (mainIndex < 0) {
    return { ok: false, error: 'Модель не связала главного героя со списком' }
  }
  return {
    ok: true,
    mainCharacterId,
    firstPersonNarratorCharacterId,
    characters: [
      characters[mainIndex],
      ...characters.filter((_candidate, index) => index !== mainIndex)
    ]
  }
}
