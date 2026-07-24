// Определение языка фрагментов текста для мультиязычной озвучки SaluteSpeech.
// Любой голос читает 12 языков через SSML <voice name lang> (доки Салюта:
// guides/synthesis/ssml/language). Иноязычные вставки («Война и мир» с французским)
// получают свой lang-тег, голос при этом не меняется.
//
// Детектор намеренно консервативен: сомнительный фрагмент остаётся русским —
// это ровно сегодняшнее поведение, ложное срабатывание хуже пропуска.
// Неподдерживаемые письменности (иероглифы, арабский и т.п.) тоже читаются
// как сейчас, без lang-тега; отдельный fallback для них продумаем позже.

export type SaluteLang =
  | 'ru'
  | 'en'
  | 'fr'
  | 'de'
  | 'es'
  | 'it'
  | 'pt'
  | 'pl'
  | 'nl'
  | 'kz'
  | 'ky'
  | 'uz'

export const SALUTE_TTS_LANGUAGES: readonly SaluteLang[] = [
  'ru', 'en', 'fr', 'de', 'es', 'it', 'pt', 'pl', 'nl', 'kz', 'ky', 'uz'
]

export interface LanguageRun {
  lang: SaluteLang
  text: string
}

// Письменности, которые SaluteSpeech не озвучивает — фрагмент остаётся без lang-тега.
const UNSUPPORTED_SCRIPTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Georgian}\p{Script=Armenian}]/gu

// Одно такое слово решает язык фрагмента сразу.
const STRONG_MARKERS: Record<string, SaluteLang> = {
  bonjour: 'fr', merci: 'fr', monsieur: 'fr', madame: 'fr', mademoiselle: 'fr',
  ciao: 'it', grazie: 'it', buongiorno: 'it', signore: 'it', signora: 'it',
  hola: 'es', gracias: 'es', señor: 'es', señora: 'es',
  olá: 'pt', obrigado: 'pt', obrigada: 'pt',
  dziękuję: 'pl', dzień: 'pl',
  hello: 'en', thanks: 'en',
  danke: 'de', guten: 'de', herr: 'de', frau: 'de',
  goedemorgen: 'nl', mevrouw: 'nl', meneer: 'nl',
  salom: 'uz', rahmat: 'uz',
  қазақ: 'kz', кыргыз: 'ky'
}

// Частотные слова: побеждает язык со счётом ≥2 и строго выше второго места.
const MARKERS: Record<Exclude<SaluteLang, 'ru'>, ReadonlySet<string>> = {
  fr: new Set(['le', 'la', 'les', 'des', 'une', 'et', 'est', 'il', 'elle', 'je', 'vous', 'nous',
    'ne', 'pas', 'que', 'qui', 'dans', 'pour', 'avec', 'sur', 'mais', 'ce', 'cette', 'mon',
    'ma', 'mes', 'ami', 'amie', 'très', 'être', 'avoir', 'comme', 'plus', 'bien', 'tout',
    'oui', 'non', 'suis', 'êtes', 'c’est', "c'est", 'moi', 'toi', 'ici', 'voir']),
  it: new Set(['il', 'lo', 'gli', 'di', 'che', 'una', 'non', 'per', 'con', 'si', 'mi', 'ma',
    'come', 'sono', 'ho', 'ha', 'del', 'della', 'più', 'questo', 'questa', 'anche', 'se',
    'io', 'lei', 'lui', 'noi', 'voi', 'cosa', 'molto', 'bene', 'stai', 'mio', 'mia']),
  es: new Set(['el', 'los', 'las', 'del', 'que', 'en', 'un', 'una', 'es', 'no', 'con', 'por',
    'para', 'su', 'se', 'lo', 'como', 'más', 'pero', 'sus', 'le', 'ya', 'este', 'esta',
    'cuando', 'muy', 'sin', 'sobre', 'también', 'me', 'hay', 'todo', 'nos', 'cómo', 'estás',
    'buenos', 'días', 'usted']),
  pt: new Set(['os', 'as', 'do', 'da', 'dos', 'das', 'que', 'um', 'uma', 'não', 'para', 'com',
    'por', 'se', 'na', 'no', 'mais', 'mas', 'como', 'muito', 'você', 'está', 'são', 'foi',
    'ele', 'ela', 'eu', 'seu', 'sua', 'hoje', 'bem', 'senhor', 'senhora']),
  de: new Set(['der', 'die', 'das', 'und', 'ist', 'ich', 'nicht', 'ein', 'eine', 'zu', 'den',
    'von', 'mit', 'sich', 'auf', 'für', 'als', 'auch', 'es', 'an', 'werden', 'aus', 'er',
    'hat', 'dass', 'sie', 'nach', 'wird', 'bei', 'einer', 'um', 'am', 'sind', 'noch', 'wie',
    'einem', 'über', 'mein', 'meine', 'was', 'wir', 'morgen', 'gut', 'sehr']),
  nl: new Set(['de', 'het', 'een', 'en', 'van', 'ik', 'te', 'dat', 'die', 'in', 'is', 'niet',
    'op', 'aan', 'met', 'als', 'voor', 'er', 'maar', 'om', 'dan', 'zou', 'of', 'wat', 'mijn',
    'men', 'dit', 'zo', 'door', 'over', 'ze', 'zich', 'bij', 'ook', 'tot', 'je', 'mij',
    'uit', 'naar', 'heb', 'hoe', 'heeft', 'hebben', 'deze', 'wel', 'dank', 'goed', 'zijn']),
  pl: new Set(['i', 'w', 'nie', 'na', 'się', 'z', 'do', 'to', 'że', 'o', 'jak', 'jest', 'po',
    'co', 'tak', 'za', 'od', 'ale', 'czy', 'pan', 'pani', 'dobry', 'bardzo', 'jestem',
    'być', 'ja', 'ty', 'my', 'wy', 'jego', 'jej', 'masz']),
  en: new Set(['the', 'and', 'of', 'to', 'in', 'is', 'was', 'he', 'she', 'it', 'you', 'that',
    'his', 'her', 'with', 'for', 'as', 'but', 'not', 'they', 'this', 'have', 'from', 'at',
    'by', 'be', 'on', 'are', 'what', 'good', 'morning', 'my', 'me', 'your', 'thank', 'sir',
    'do', 'did', 'will', 'would', 'there', 'here']),
  kz: new Set(['бұл', 'және', 'үшін', 'бар', 'жоқ', 'мен', 'сен', 'біз', 'олар', 'деп',
    'тіліндегі', 'сөйлем', 'қарапайым']),
  ky: new Set(['бул', 'жана', 'үчүн', 'менен', 'эмес', 'мен', 'сен', 'биз', 'алар',
    'тилиндеги', 'сүйлөм', 'жөнөкөй']),
  uz: new Set(['bu', 'va', 'uchun', 'bilan', 'emas', 'men', 'sen', 'biz', 'ular', 'tilidagi',
    'oddiy', 'gap', "o'zbek", 'o‘zbek', 'ha', "yo'q"])
}

// Диакритика как дополнительная улика (вес — как одно слово-маркер).
const DIACRITICS: Partial<Record<Exclude<SaluteLang, 'ru'>, RegExp>> = {
  fr: /[àâçèêëîïôûùœ]/iu,
  de: /[äöüß]/iu,
  es: /[ñ¿¡]/u,
  pt: /[ãõ]/iu,
  it: /[àèìòù]/iu,
  pl: /[ąćęłńśźż]/iu
}

interface FragmentLanguage {
  lang: SaluteLang | null // null — уверенного решения нет, фрагмент наследует язык соседа
  unsupported: boolean // письменность вне 12 языков — всегда дефолтный язык, без наследования
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{M}]+(?:[’'][\p{L}\p{M}]+)?/gu) || [])
}

function classifyFragment(text: string, defaultLang: SaluteLang): FragmentLanguage {
  const letters = text.match(/\p{L}/gu) || []
  if (letters.length < 4) return { lang: null, unsupported: false }

  const unsupportedHits = text.match(UNSUPPORTED_SCRIPTS) || []
  if (unsupportedHits.length >= Math.max(3, Math.floor(letters.length / 3))) {
    return { lang: null, unsupported: true }
  }

  const cyr = letters.filter((ch) => /\p{Script=Cyrillic}/u.test(ch))
  if (cyr.length * 2 >= letters.length) {
    // Кириллица: русский по умолчанию, тюркские языки — по особым буквам.
    if (/[ўҳ]/i.test(text)) return { lang: 'uz', unsupported: false }
    if (/[әқғұһ]/i.test(text)) return { lang: 'kz', unsupported: false }
    if (/[ңөү]/i.test(text)) {
      const ws = words(text)
      const kyScore = ws.filter((w) => MARKERS.ky.has(w)).length
      const kzScore = ws.filter((w) => MARKERS.kz.has(w)).length
      return { lang: kzScore > kyScore ? 'kz' : 'ky', unsupported: false }
    }
    return { lang: 'ru', unsupported: false }
  }

  // Латиница и прочее.
  if (/(?:o[‘’']|g[‘’'])/i.test(text)) return { lang: 'uz', unsupported: false }
  const ws = words(text)
  for (const w of ws) {
    const strong = STRONG_MARKERS[w]
    if (strong) return { lang: strong, unsupported: false }
  }
  let best: SaluteLang | null = null
  let bestScore = 0
  let runnerUp = 0
  for (const [lang, set] of Object.entries(MARKERS) as [Exclude<SaluteLang, 'ru'>, ReadonlySet<string>][]) {
    let score = ws.filter((w) => set.has(w)).length
    const dia = DIACRITICS[lang]
    if (dia && dia.test(text)) score += 1
    if (score > bestScore) {
      runnerUp = bestScore
      bestScore = score
      best = lang
    } else if (score > runnerUp) {
      runnerUp = score
    }
  }
  if (best && bestScore >= 2 && bestScore > runnerUp) return { lang: best, unsupported: false }
  return { lang: null, unsupported: false }
}

/** Язык фрагмента или null, если уверенного решения нет (тогда читаем как русский). */
export function detectTtsLanguage(text: string, defaultLang: SaluteLang = 'ru'): SaluteLang | null {
  const res = classifyFragment(String(text || '').trim(), defaultLang)
  return res.unsupported ? null : res.lang
}

// Кавычки выделяются в отдельные фрагменты: иноязычная цитата — типичный случай смены языка.
const QUOTED = /(«[^»]+»|“[^”]+”|"[^"]+")/g

function fragments(text: string): string[] {
  const value = String(text || '').trim()
  if (!value) return []
  const out: string[] = []
  for (const outer of value.split(QUOTED)) {
    if (!outer || !outer.trim()) continue
    if (new RegExp(`^${QUOTED.source}$`, 'u').test(outer)) {
      out.push(outer.trim())
      continue
    }
    for (const part of outer.match(/[^.!?…]+(?:[.!?…]+|$)/g) || []) {
      if (part.trim()) out.push(part.trim())
    }
  }
  return out
}

/** Текст, разбитый на подряд идущие куски одного языка, в исходном порядке. */
export function splitLanguageRuns(text: string, defaultLang: SaluteLang = 'ru'): LanguageRun[] {
  const runs: LanguageRun[] = []
  for (const fragment of fragments(text)) {
    const res = classifyFragment(fragment, defaultLang)
    // Неподдерживаемая письменность — дефолтный язык; неуверенный фрагмент — язык соседа.
    const lang: SaluteLang = res.unsupported
      ? defaultLang
      : res.lang ?? (runs.length ? runs[runs.length - 1].lang : defaultLang)
    if (runs.length && runs[runs.length - 1].lang === lang) {
      runs[runs.length - 1].text += ' ' + fragment
    } else {
      runs.push({ lang, text: fragment })
    }
  }
  return runs
}

/** Есть ли в тексте иноязычные (не defaultLang) куски — влияет на ключ аудио-кэша. */
export function hasForeignLanguage(text: string, defaultLang: SaluteLang = 'ru'): boolean {
  return splitLanguageRuns(text, defaultLang).some((run) => run.lang !== defaultLang)
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export interface MultilingualSsmlOptions {
  text: string
  /** Полное имя голоса как в query шлюза, например Nec_24000 — иначе Салют сменит голос. */
  providerVoice: string
  prosody: { rate: string; pitch: string; endPauseMs: number }
  sentencePauseMs?: number
  defaultLang?: SaluteLang
}

/**
 * SSML c <voice name lang> по языковым кускам. Возвращает null, когда весь текст
 * на defaultLang — тогда вызывающий строит прежний одноязычный SSML байт-в-байт
 * и накопленный аудио-кэш остаётся валидным.
 */
export function buildMultilingualSsml(opts: MultilingualSsmlOptions): string | null {
  const defaultLang = opts.defaultLang || 'ru'
  const runs = splitLanguageRuns(opts.text, defaultLang)
  if (!runs.length || runs.every((run) => run.lang === defaultLang)) return null
  const voice = String(opts.providerVoice || '').replace(/[^A-Za-z0-9_]/g, '')
  if (!voice) return null
  const pause = `<break time="${opts.sentencePauseMs ?? 260}ms"/>`
  const body = runs
    .map((run) => {
      const sentences = run.text
        .split(/(?<=[.!?…])\s+/)
        .filter(Boolean)
        .map((s) => escapeXml(s))
        .join(pause)
      const inner = `<prosody rate="${opts.prosody.rate}" pitch="${opts.prosody.pitch}">${sentences}</prosody>`
      return `<voice name="${voice}" lang="${run.lang}">${inner}</voice>`
    })
    .join('')
  return `<speak>${body}<break time="${opts.prosody.endPauseMs}ms"/></speak>`
}
