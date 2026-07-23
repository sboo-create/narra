import {
  AUTO_FEMALE_VOICES,
  AUTO_MALE_VOICES,
  DEFAULT_NARRATOR_VOICE,
  assignBookCharacterVoices,
  type Character,
  type Gender,
  type LlmMessage,
  type SaluteVoice
} from '@shared/types'
import {
  characterId,
  normalizeCharacterMarkup,
  type CharacterMarkupPayload
} from '@shared/character-markup'

/*
 * Авторазметка загруженной книги: GigaChat строит 4–6 профилей главных героев
 * с паспортами внешности; голоса назначаются по полу; unlockChapter считает main.
 */

const MALE: readonly SaluteVoice[] = AUTO_MALE_VOICES
const FEMALE: readonly SaluteVoice[] = AUTO_FEMALE_VOICES

function markupPrompt(title: string, author: string, excerpt: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content: `Ты — редактор. По фрагментам книги выдели 5–8 ГЛАВНЫХ и заметных героев и верни СТРОГО JSON-объект без пояснений.
mainCharacterId — id главного героя: рассказчик при повествовании от первого лица, иначе самый значимый по прямой речи и упоминаниям.
firstPersonNarratorCharacterId — тот же id, если повествование идёт от первого лица героя; иначе null.
Бери только людей, реально действующих в тексте (не упомянутых вскользь). Имя — как чаще всего зовут в тексте.

⛔ БЕЗ СПОЙЛЕРОВ. Читатель ещё не начал книгу. Описывай героя ТОЛЬКО таким, каким он предстаёт в НАЧАЛЕ истории:
- никаких сюжетных поворотов, тайн, разоблачений, смертей, воскрешений, потери и возвращения памяти, предательств, финальных ролей;
- если герой сам не знает, кто он (амнезия, скрытая личность, чужое имя) — так и описывай: он не знает, и читатель пока тоже;
- в role пиши, кем он выглядит в первых главах и чего хочет, а не кем окажется потом;
- в speechStyle и traits — характер и манера, без раскрытия сюжета.
{"mainCharacterId":"id из characters","firstPersonNarratorCharacterId":null,"characters":[{"id":"латиницей","name":"Имя точно как в тексте (именительный падеж)","fullName":"полное имя","role":"кто в истории, 1 предложение","gender":"male|female","traits":["5 черт по-русски"],"speechStyle":"манера речи, 1-2 предложения","speechExamples":["3 реплики в духе героя"],"passport":{"age":число,"build":"телосложение","hair":"волосы","eyes":"глаза","face":"черты лица","outfit":"одежда по эпохе"},"expression":"выражение лица из характера","greeting":"САМА первая реплика героя читателю — прямая речь от первого лица, 1-2 предложения. НЕ описание («короткое сухое приветствие») , а живые слова: например «Грейнджер. Чего тебе?»","exampleDialogue":[{"user":"вопрос","char":"ответ"},{"user":"...","char":"..."},{"user":"...","char":"..."}],"idleAnimation":"живое движение лица по-английски, 6-12 слов: наклон головы, движение бровей, взгляд. ГЛАЗА ОТКРЫТЫ, рот закрыт. Без слов speak/talk/breathing/sleep/eyes closed"}]}
ВНЕШНОСТЬ (passport) — самое важное, её увидят на портретах:
- бери приметы ИЗ ТЕКСТА (в выборке есть блок «Упоминания внешности») — дословно;
- если герой из известной вселенной (Гарри Поттер, классика, кино), используй КАНОНИЧНУЮ внешность:
  Драко Малфой — платиновые светлые волосы, серые глаза, бледная кожа, острые черты;
  Гермиона — густые каштановые кудри, карие глаза; Гарри — чёрные вихры, зелёные глаза, шрам-молния;
  Рон — рыжий, веснушки, голубые глаза; Снейп — чёрные сальные волосы, чёрные глаза, крючковатый нос;
- НИКОГДА не ставь «тёмные волосы, карие глаза» просто по умолчанию — это заметная ошибка;
- чего нет ни в тексте, ни в каноне — придумай правдоподобно для эпохи. Возраст ЧИСЛОМ.`
    },
    { role: 'user', content: `Книга: «${title}», ${author}.\n\nФрагменты:\n${excerpt}\n\nJSON:` }
  ]
}

/** Уточняет пол героев, у которых модель его не вернула. */
async function askGenders(names: string[]): Promise<Record<string, Gender>> {
  if (names.length === 0) return {}
  const res = await window.narra.llmJson<Record<string, string>>([
    {
      role: 'system',
      content:
        'Определи пол каждого персонажа. Верни СТРОГО JSON-объект вида {"Имя":"male"|"female"} без пояснений.'
    },
    { role: 'user', content: names.join(', ') }
  ])
  const out: Record<string, Gender> = {}
  if (res.ok && res.data && typeof res.data === 'object') {
    for (const [k, v] of Object.entries(res.data)) {
      out[k.toLowerCase()] = String(v).toLowerCase() === 'female' ? 'female' : 'male'
    }
  }
  return out
}

/** Дозаполняет внешность тем героям, у кого модель её не вернула. */
async function askAppearance(
  names: string[],
  title: string
): Promise<Record<string, Character['passport']>> {
  if (names.length === 0) return {}
  const res = await window.narra.llmJson<Record<string, Record<string, unknown>>>([
    {
      role: 'system',
      content:
        'Опиши внешность персонажей. Верни СТРОГО JSON: {"Имя":{"age":число,"build":"...","hair":"...","eyes":"...","face":"...","outfit":"..."}}. ' +
        'Для героев известных вселенных используй каноничную внешность. Без пояснений.'
    },
    { role: 'user', content: `Книга «${title}». Персонажи: ${names.join(', ')}` }
  ])
  const out: Record<string, Character['passport']> = {}
  if (res.ok && res.data && typeof res.data === 'object') {
    for (const [k, v] of Object.entries(res.data)) {
      if (!v || typeof v !== 'object') continue
      const p = v as Record<string, unknown>
      out[k.toLowerCase()] = {
        age: Number(p.age) || 30,
        gender: 'male',
        build: String(p.build || 'обычное телосложение'),
        hair: String(p.hair || 'тёмные волосы'),
        eyes: String(p.eyes || 'карие глаза'),
        face: String(p.face || 'выразительные черты'),
        outfit: String(p.outfit || 'одежда по эпохе книги')
      }
    }
  }
  return out
}

export async function buildCharacters(
  title: string,
  author: string,
  excerpt: string,
  narratorVoice: SaluteVoice = DEFAULT_NARRATOR_VOICE
): Promise<{ ok: true; characters: Character[] } | { ok: false; error: string }> {
  const res = await window.narra.llmJson<CharacterMarkupPayload>(markupPrompt(title, author, excerpt))
  if (
    !res.ok ||
    !res.data ||
    typeof res.data !== 'object' ||
    !Array.isArray(res.data.characters) ||
    typeof res.data.mainCharacterId !== 'string' ||
    !(
      res.data.firstPersonNarratorCharacterId === null ||
      typeof res.data.firstPersonNarratorCharacterId === 'string'
    )
  ) {
    return { ok: false, error: !res.ok ? res.error || 'ошибка' : 'Модель не вернула героев' }
  }
  const normalized = normalizeCharacterMarkup(res.data)
  if (!normalized.ok) return normalized
  const ordered = normalized.characters
  // спрашиваем пол только для тех, у кого модель его не указала
  const unknown = ordered
    .filter((r) => r?.name && !r.gender && !r.passport?.gender)
    .map((r) => String(r!.name).split(/\s+/)[0])
  const genderHints = await askGenders(unknown)
  // внешность важнее всего (её рисуют на портретах) — дозапрашиваем, если модель пропустила
  const noLook = ordered
    .filter((r) => r?.name && (!r.passport || !r.passport.hair))
    .map((r) => String(r!.name).split(/\s+/)[0])
  const lookHints = noLook.length ? await askAppearance(noLook, title) : {}

  let m = 0
  let f = 0
  const chars: Character[] = []
  for (const raw of ordered.slice(0, 8)) {
    if (!raw?.name) continue
    // пол модель отдаёт не всегда — раньше такой герой молча терялся (так пропал главный).
    // Определяем сами: сперва паспорт, потом окончание имени.
    const first = String(raw.name).split(/\s+/)[0]
    const guessed =
      raw.passport?.gender ||
      genderHints[first.toLowerCase()] ||
      (/(а|я)$/i.test(first) ? 'female' : 'male')
    const gender: Gender = (raw.gender || guessed) === 'female' ? 'female' : 'male'
    const voice = gender === 'female' ? FEMALE[f++ % FEMALE.length] : MALE[m++ % MALE.length]
    const p = raw.passport?.hair ? raw.passport : lookHints[first.toLowerCase()] || raw.passport
    const passport = p
      ? {
          age: Number(p.age) || 30,
          gender,
          build: String(p.build || 'обычное телосложение'),
          hair: String(p.hair || 'тёмные волосы'),
          eyes: String(p.eyes || 'карие глаза'),
          face: String(p.face || 'выразительные черты'),
          outfit: String(p.outfit || 'одежда по эпохе книги')
        }
      : undefined
    const g = gender === 'female' ? 'женщина' : 'мужчина'
    chars.push({
      id: characterId(raw.id),
      name: String(raw.name).split(/\s+/)[0],
      fullName: String(raw.fullName || raw.name),
      role: String(raw.role || ''),
      gender,
      voice,
      traits: Array.isArray(raw.traits) ? raw.traits.slice(0, 5).map(String) : [],
      speechStyle: String(raw.speechStyle || ''),
      speechExamples: Array.isArray(raw.speechExamples) ? raw.speechExamples.slice(0, 3).map(String) : [],
      appearancePrompt: passport
        ? `${g} ${passport.age} лет, ${passport.build}, ${passport.hair}, ${passport.eyes}, ${passport.face}, одежда: ${passport.outfit}`
        : '',
      passport,
      expression: raw.expression ? String(raw.expression) : undefined,
      greeting: raw.greeting ? String(raw.greeting) : undefined,
      exampleDialogue: Array.isArray(raw.exampleDialogue) ? (raw.exampleDialogue.slice(0, 3) as never) : undefined,
      idleAnimation: raw.idleAnimation ? String(raw.idleAnimation) : undefined,
      isNarrator: raw.id === normalized.firstPersonNarratorCharacterId
    })
  }
  if (chars.length === 0) return { ok: false, error: 'Не удалось разметить героев' }
  return { ok: true, characters: assignBookCharacterVoices(chars, narratorVoice) }
}
