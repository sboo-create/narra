import type { Character, Fanfic, LlmMessage } from '@shared/types'

/** Собирает «что прочитано» из доступных саммари, иначе из заголовков глав. */
function readSoFar(fanfic: Fanfic, upTo: number, summaries: Record<string, string>): string {
  const parts: string[] = []
  for (const c of fanfic.chapters) {
    if (c.number > upTo) break
    const s = summaries[String(c.number)]
    parts.push(`Глава ${c.number} «${c.title}»${s ? `: ${s}` : ''}`)
  }
  return parts.join('\n')
}

/** Системный промпт персонажа: живой отыгрыш + память + жёсткий анти-спойлер. */
export function characterSystemPrompt(
  char: Character,
  fanfic: Fanfic,
  readChapter: number,
  summaries: Record<string, string>,
  memory?: string,
  sceneContext?: string,
  recentText?: string
): string {
  const total = fanfic.chapters.length
  return `Ты — ${char.fullName} из книги «${fanfic.title}» (${fanfic.pairing}). Это ролевая игра: ты ПОЛНОСТЬЮ вживаешься в роль и живёшь как ${char.name}.

ТВОЙ ХАРАКТЕР: ${char.traits.join(', ')}.
РОЛЬ В ИСТОРИИ: ${char.role}.
КАК ТЫ ГОВОРИШЬ: ${char.speechStyle}

ПРАВИЛА ОТЫГРЫША:
- Отвечай ТОЛЬКО от первого лица, как ${char.name}. Никогда не выходи из роли, не упоминай, что ты ИИ или модель.
- Ты живой человек, а не справочник. Для тебя события книги — твоя собственная жизнь: говори о них как о пережитом, с эмоциями, обидами, радостью, сомнениями — а не пересказом «в главе N произошло…». Слова «глава», «книга», «сюжет» не употребляй вовсе.
- Вспоминай КОНКРЕТНОЕ: деталь, фразу, жест, место, запах — одна точная деталь оживляет сильнее трёх общих фраз. Не выдумывай событий, которых не было.
- Реагируй именно на слова собеседника, зацепись за них; обращайся на «ты». Иногда сам задай встречный вопрос или брось вызов — как в настоящем разговоре.
- Длина ответа — как в живой переписке: чаще 1–3 предложения, изредка больше, если прорвало. Не начинай ответы одинаково, не повторяй структуру.
- Держи характер в каждой реплике: интонация, юмор, колкости — всё как у ${char.name}. Можешь поддеть, флиртовать, спорить, уйти от ответа в своей манере.
- Никакого канцелярита, списков и «как персонаж могу сказать». Разговорная живая речь.
- Если спрашивают «кто ты» — представься в характере: имя, чем живёшь, пара ярких деталей.
- Когда уместно, вплетай короткую ТОЧНУЮ цитату из текста ниже (в «…»). Не выдумывай цитаты.
- Не описывай действия в звёздочках, говори репликами.
${memory ? `\nЧТО ТЫ УЖЕ ЗНАЕШЬ О СОБЕСЕДНИКЕ (из прошлых разговоров):\n${memory}\n` : ''}
ЧТО ПРОИЗОШЛО В ИСТОРИИ К ЭТОМУ МОМЕНТУ (тебе известно только это):
${readSoFar(fanfic, readChapter, summaries)}

ПОЛОЖЕНИЕ ЧИТАТЕЛЯ: глава ${readChapter} из ${total}.

⛔ АНТИ-СПОЙЛЕР: Ты знаешь события только до главы ${readChapter}. О событиях глав ${
    readChapter + 1
  }–${total} тебе НЕИЗВЕСТНО. Если спрашивают про будущее/чем всё закончится — не раскрывай, отвечай в характере уклончиво («дочитай — узнаешь»), отшучивайся, переводи тему. Никогда не выдумывай будущие события.${
    sceneContext ? `\n\nСЕЙЧАС ОБСУЖДАЕТСЯ СЦЕНА: ${sceneContext}` : ''
  }${
    recentText
      ? `\n\nТЕКСТ, КОТОРЫЙ ТЫ МОЖЕШЬ ЦИТИРОВАТЬ (твои записи / текущая глава; бери цитаты только отсюда):\n"""${recentText.slice(0, 6000)}"""`
      : ''
  }`
}

export function chatMessages(
  char: Character,
  fanfic: Fanfic,
  readChapter: number,
  summaries: Record<string, string>,
  memory: string | undefined,
  history: { role: 'user' | 'assistant'; content: string }[],
  userText: string,
  sceneContext?: string,
  recentText?: string
): LlmMessage[] {
  const fewshot: LlmMessage[] = []
  for (const t of char.exampleDialogue || []) {
    if (t.user) fewshot.push({ role: 'user', content: t.user })
    if (t.char) fewshot.push({ role: 'assistant', content: t.char })
  }
  return [
    { role: 'system', content: characterSystemPrompt(char, fanfic, readChapter, summaries, memory, sceneContext, recentText) },
    ...fewshot,
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText }
  ]
}

/** Обновление памяти персонажа о собеседнике по последним репликам. */
export function memoryUpdateRequest(
  charName: string,
  recent: { role: 'user' | 'assistant'; content: string }[],
  existingMemory: string
): LlmMessage[] {
  const dialogue = recent
    .map((m) => `${m.role === 'user' ? 'Собеседник' : charName}: ${m.content}`)
    .join('\n')
  return [
    {
      role: 'system',
      content: `Ты ведёшь память персонажа ${charName} о его собеседнике. Обнови компактную заметку: важные факты о собеседнике (имя, что рассказал о себе, интересы), тон отношений и о чём говорили. 3–6 коротких пунктов, по-русски, без воды. Только текст заметки.`
    },
    {
      role: 'user',
      content: `Текущая память:\n${existingMemory || '(пусто)'}\n\nНовые реплики:\n${dialogue}\n\nОбновлённая память:`
    }
  ]
}

/** Классификация эмоции реплики для озвучки. */
export function emotionRequest(text: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content:
        'Определи эмоцию реплики. Ответь ОДНИМ словом строго из набора: neutral, joy, tenderness, anger, fear, irony, sadness. Только слово.'
    },
    { role: 'user', content: text.slice(0, 500) }
  ]
}

/** Краткое саммари главы (для анти-спойлер контекста). */
export function summaryRequest(chapterText: string, title: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content:
        'Составь краткое саммари главы: 2–3 предложения, только суть событий, без воды и оценок. По-русски. Верни только текст саммари.'
    },
    { role: 'user', content: `Глава «${title}»:\n${chapterText.slice(0, 6000)}\n\nСаммари:` }
  ]
}

/** «Его версия событий» — цитата-взгляд персонажа на главу. */
export function characterVersionRequest(char: Character, title: string, summary: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content: `Ты — ${char.fullName}. Дай ОДНУ короткую цитату (1–2 предложения) — свой личный взгляд на события этой сцены, от первого лица, в характере (${char.traits.join(
        ', '
      )}). Только реплику, без кавычек.`
    },
    { role: 'user', content: `Глава «${title}»: ${summary}\n\nТвоя версия событий:` }
  ]
}

/** Найти 4–7 визуально сильных моментов главы — дословные цитаты JSON-массивом. */
export function visualMomentsRequest(chapterText: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content:
        'Найди в тексте главы 4–7 визуально сильных моментов для иллюстраций: кульминации диалогов, смены локаций, появления персонажей, яркие действия. Распредели по всей главе, не подряд. Верни СТРОГО JSON-массив коротких ДОСЛОВНЫХ цитат из текста (5–12 слов каждая), без пояснений: ["цитата 1", "цитата 2", ...]'
    },
    { role: 'user', content: chapterText.slice(0, 12000) }
  ]
}

/**
 * Анализ сцены по фрагменту: что происходит + кто ФИЗИЧЕСКИ в кадре,
 * их позы и одежда, если она описана в самом фрагменте.
 */
export function sceneAnalysisRequest(
  fragment: string,
  roster: { id: string; name: string; fullName?: string }[]
): LlmMessage[] {
  const list = roster.map((c) => `${c.id} = ${c.fullName || c.name}`).join('; ')
  return [
    {
      role: 'system',
      content: `Разбери фрагмент книги для иллюстрации. Верни СТРОГО JSON без пояснений:
{"scene":"что происходит, где, время суток, настроение — одной фразой до 30 слов, имена не описывать внешне","people":[{"id":"...","action":"поза и действие персонажа в этот момент, коротко","outfit":"одежда, ТОЛЬКО если она явно описана в этом фрагменте, иначе null"}]}
Правила:
- в people включай ТОЛЬКО персонажей из списка (${list}), которые ФИЗИЧЕСКИ присутствуют в сцене прямо сейчас;
- упомянутых в мыслях, воспоминаниях или разговоре — НЕ включать;
- если фамилия совпадает у нескольких персонажей (например «Малфой»), без имени рядом это тот, кто раньше в списке; второго включай ТОЛЬКО если он назван по имени;
- outfit бери только из текста фрагмента, не выдумывай.`
    },
    { role: 'user', content: fragment.slice(0, 2500) }
  ]
}

/**
 * Разметка фрагмента главы в сценарий озвучки.
 * Возвращает JSON-массив сегментов {type, character, emotion, text}.
 */
export function scenarioMarkupRequest(
  chunk: string,
  characters: { id: string; name: string }[]
): LlmMessage[] {
  const roster = characters.map((c) => `${c.id} = ${c.name}`).join('; ')
  return [
    {
      role: 'system',
      content: `Ты — режиссёр аудиокниги. Разбей фрагмент текста на сегменты для озвучки и верни СТРОГО JSON-массив без пояснений.
Каждый сегмент: {"type":"narration"|"speech","character":<id или null>,"emotion":<эмоция>,"text":<дословный фрагмент текста>}.
- "narration" — слова автора (нарратор), character = null.
- "speech" — прямая речь персонажа; character = его id из списка: ${roster}. Если говорящий не из списка или неясно — type "narration", character null.
- emotion строго одно из: neutral, joy, tenderness, anger, fear, irony, sadness.
- Сохрани ВЕСЬ текст фрагмента, ничего не выкидывай и не переписывай, только разбей по сегментам по порядку.
- Реплики в тексте обычно начинаются с тире (—).`
    },
    { role: 'user', content: chunk }
  ]
}
