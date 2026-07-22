import type { Character } from '@shared/types'

/*
 * Единый конструктор промптов изображений.
 * ПРАВИЛО: любой промпт с персонажами собирается ТОЛЬКО отсюда —
 * паспорта внешности вшиваются дословно, чтобы портреты и сцены сходились.
 */

export const ART_STYLE =
  'стилизованная современная книжная иллюстрация, цифровая живопись с выразительными мазками, ' +
  'НЕ фотореализм, чистые уверенные формы, мягкий рассеянный свет, сдержанная благородная палитра, ' +
  'лёгкая текстура бумаги, единая серия работ одного художника, без текста и надписей'

/** Канонический текст паспорта — дословно в каждый промпт.
 *  outfitOverride: одежда из текста сцены важнее паспортной. */
export function passportText(c: Character, outfitOverride?: string | null): string {
  const p = c.passport
  if (!p) return c.appearancePrompt
  const g = p.gender === 'female' ? 'женщина' : 'мужчина'
  return `${g} ${p.age} лет, ${p.build}, ${p.hair}, ${p.eyes}, ${p.face}, одежда: ${outfitOverride || p.outfit}`
}

/** Участник сцены: персонаж + поза/действие + одежда из фрагмента (если описана). */
export interface ScenePerson {
  char: Character
  action?: string
  outfit?: string | null
}

/** Персонажи, присутствующие во фрагменте текста (по имени ИЛИ фамилии).
 *  Фамилия, общая для нескольких героев (Драко и Нарцисса — оба «Малфой»),
 *  не матчит никого: иначе каждый «Малфой» в тексте тащил в кадр Нарциссу. */
export function presentIn(fragment: string, characters: Character[]): Character[] {
  const low = fragment.toLowerCase()
  const stemOwners = new Map<string, number>()
  const stemsOf = (c: Character) =>
    [c.name, ...c.fullName.split(/\s+/)]
      .map((w) => w.toLowerCase().replace(/[аяйь]$/, ''))
      .filter((w) => w.length >= 4)
  for (const c of characters) for (const st of new Set(stemsOf(c))) stemOwners.set(st, (stemOwners.get(st) || 0) + 1)
  return characters.filter((c) => stemsOf(c).some((st) => stemOwners.get(st) === 1 && low.includes(st)))
}

/** Промпт портрета — из паспорта. */
export function portraitPrompt(c: Character): string {
  return (
    `Погрудный портрет: голова и плечи, небольшой отступ сверху, строго анфас, лицом к зрителю, ` +
    `ровный светлый однотонный фон. Выражение лица: ${c.expression || 'спокойное, сдержанное'}. ` +
    `Внешность (соблюдать точно): ${passportText(c)}. Стиль: ${ART_STYLE}.`
  )
}

/** Короткий паспорт для многолюдных сцен: влезть в лимит промпта Кандинского (950 зн.). */
function passportShort(c: Character, outfitOverride?: string | null): string {
  const p = c.passport
  if (!p) return c.appearancePrompt
  const g = p.gender === 'female' ? 'женщина' : 'мужчина'
  return `${g} ${p.age} лет, ${p.hair}, ${p.eyes}, одежда: ${outfitOverride || p.outfit}`
}

/** Промпт сцены: контекст + РОВНО эти люди в кадре, их позы, одежда из фрагмента важнее паспорта.
 *  ВАЖНО: Кандинский обрезает промпт на 950 знаках — стиль стоит В НАЧАЛЕ,
 *  а при 3+ героях паспорта сокращаются, иначе «НЕ фотореализм» отлетает
 *  и получаются фотоколлажи с киноактёрами. */
export function scenePrompt(sceneContext: string, present: ScenePerson[]): string {
  const head =
    'Рисованная книжная иллюстрация, цифровая живопись, НЕ фотореализм, НЕ кадр из фильма, НЕ фото. '
  const tail = ' Мягкий рассеянный свет, сдержанная палитра, лёгкая текстура бумаги, без текста и надписей.'
  if (!present.length)
    return `${head}Сцена: ${sceneContext}. Без людей крупным планом, широкая композиция.${tail}`
  const names = present.map((p) => p.char.name).join(' и ')
  // цензор Кандинского иногда принимает андрогинных героев за однополую пару — проговариваем пол явно
  const genders = present.map((p) => p.char.passport?.gender)
  const pairNote =
    present.length === 2 && genders.includes('male') && genders.includes('female')
      ? 'это пара — мужчина и женщина, '
      : ''
  const build = (short: boolean) =>
    `${head}Сцена: ${sceneContext}. Единая сцена в одном пространстве, персонажи взаимодействуют — НЕ коллаж, НЕ отдельные панели и портреты. ` +
    `В кадре РОВНО ${present.length} ${present.length === 1 ? 'человек' : 'человека'} — ${pairNote}только ${names}, никаких других людей и лиц. ` +
    `Внешность СТРОГО: ${present
      .map(
        (p) =>
          `${p.char.name} (${(short ? passportShort : passportText)(p.char, p.outfit)})${p.action ? ` — ${p.action}` : ''}`
      )
      .join('; ')}.${tail}`
  const full = build(false)
  return full.length <= 930 ? full : build(true)
}

/** Промпт обложки: описание + паспорта главных героев. */
export function coverPrompt(desc: string, mains: Character[]): string {
  const who = mains.length
    ? ` На обложке: ${mains.map((c) => `${c.name} — ${passportText(c)}`).join('; ')}.`
    : ''
  return `Обложка книги: изображение занимает ВЕСЬ кадр, без рамок, белых полей, виньеток и текста, вертикальная композиция.${who} ${desc}. Рисованная иллюстрация той же серии, что портреты героев. Стиль: ${ART_STYLE}.`
}
