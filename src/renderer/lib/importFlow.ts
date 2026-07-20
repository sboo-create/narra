import type { Character, Gender, LlmMessage, SaluteVoice } from '@shared/types'

/*
 * Авторазметка загруженной книги: GigaChat строит 4–6 профилей главных героев
 * с паспортами внешности; голоса назначаются по полу; unlockChapter считает main.
 */

const MALE: SaluteVoice[] = ['Bys', 'Tur', 'Pon']
const FEMALE: SaluteVoice[] = ['Ost', 'May', 'Nec']

function markupPrompt(title: string, author: string, excerpt: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content: `Ты — редактор. По началу книги выдели 4–6 ГЛАВНЫХ героев и верни СТРОГО JSON-массив объектов без пояснений:
[{"id":"латиницей","name":"Имя точно как в тексте (именительный падеж)","fullName":"полное имя","role":"кто в истории, 1 предложение","gender":"male|female","traits":["5 черт по-русски"],"speechStyle":"манера речи, 1-2 предложения","speechExamples":["3 реплики в духе героя"],"passport":{"age":число,"build":"телосложение","hair":"волосы","eyes":"глаза","face":"черты лица","outfit":"одежда по эпохе"},"expression":"выражение лица из характера","greeting":"приветствие в характере","exampleDialogue":[{"user":"вопрос","char":"ответ"},{"user":"...","char":"..."},{"user":"...","char":"..."}],"idleAnimation":"small facial motion in english, no smile if stern"}]
Паспорт: чего нет в тексте — зафиксируй правдоподобно для эпохи. Возраст ЧИСЛОМ.`
    },
    { role: 'user', content: `Книга: «${title}», ${author}.\n\nНачало:\n${excerpt}\n\nJSON:` }
  ]
}

export async function buildCharacters(
  title: string,
  author: string,
  excerpt: string
): Promise<{ ok: true; characters: Character[] } | { ok: false; error: string }> {
  const res = await window.narra.llmJson<Partial<Character>[]>(markupPrompt(title, author, excerpt))
  if (!res.ok || !Array.isArray(res.data)) {
    return { ok: false, error: !res.ok ? res.error || 'ошибка' : 'Модель не вернула героев' }
  }
  let m = 0
  let f = 0
  const chars: Character[] = []
  for (const raw of res.data.slice(0, 6)) {
    if (!raw?.name || !raw?.gender) continue
    const gender: Gender = raw.gender === 'female' ? 'female' : 'male'
    const voice = gender === 'female' ? FEMALE[f++ % FEMALE.length] : MALE[m++ % MALE.length]
    const p = raw.passport
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
      id: String(raw.id || raw.name).toLowerCase().replace(/[^a-z0-9]+/g, '') || `c${chars.length}`,
      name: String(raw.name),
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
      idleAnimation: raw.idleAnimation ? String(raw.idleAnimation) : undefined
    })
  }
  if (chars.length === 0) return { ok: false, error: 'Не удалось разметить героев' }
  return { ok: true, characters: chars }
}
