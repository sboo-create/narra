#!/usr/bin/env node
// Проверки мультиязычного TTS-детектора: `bun scripts/check-tts-language.mjs`
// (или node ≥23.6 — типы вырезаются нативно). Без внешних зависимостей.
import assert from 'node:assert/strict'
import {
  detectTtsLanguage,
  splitLanguageRuns,
  hasForeignLanguage,
  buildMultilingualSsml,
  SALUTE_TTS_LANGUAGES
} from '../src/renderer/lib/ttsLanguage.ts'

const PROSODY = { rate: '100%', pitch: '+0%', endPauseMs: 120 }

// --- Все 12 языков SaluteSpeech распознаются на типовых фразах ---
const samples = {
  ru: 'Сегодня хорошая погода, и мы идём гулять.',
  uz: 'Salom, bu o‘zbek tilidagi oddiy gap.',
  pt: 'Olá, como você está hoje? Muito obrigado.',
  pl: 'Dzień dobry, jak się masz? Dziękuję bardzo.',
  nl: 'Goedemorgen, dit is een Nederlandse zin.',
  kz: 'Бұл қазақ тіліндегі қарапайым сөйлем.',
  en: 'Hello, this is a simple English sentence.',
  de: 'Guten Morgen, das ist ein deutscher Satz.',
  es: 'Hola, buenos días. Esta es una frase española.',
  fr: 'Bonjour, ceci est une phrase française.',
  it: 'Ciao, questa è una semplice frase italiana.',
  ky: 'Бул кыргыз тилиндеги жөнөкөй сүйлөм.'
}
assert.equal(SALUTE_TTS_LANGUAGES.length, 12)
for (const [lang, text] of Object.entries(samples)) {
  assert.equal(detectTtsLanguage(text), lang, `detect ${lang}: ${text}`)
}

// --- «Война и мир»: французская цитата в русском абзаце ---
const tolstoy =
  'Князь улыбнулся. «Bonjour, mon ami. Je suis heureux de vous voir.» Затем он вышел.'
{
  const runs = splitLanguageRuns(tolstoy)
  assert.deepEqual(
    runs.map((r) => r.lang),
    ['ru', 'fr', 'ru'],
    'ru→fr→ru runs'
  )
  assert.ok(runs[1].text.includes('Bonjour, mon ami'))
  assert.equal(hasForeignLanguage(tolstoy), true)
}

// --- SSML: один голос, смена только языка; порядок текста сохранён ---
{
  const ssml = buildMultilingualSsml({ text: tolstoy, providerVoice: 'Nec_24000', prosody: PROSODY })
  assert.ok(ssml.startsWith('<speak>') && ssml.endsWith('</speak>'))
  const langs = [...ssml.matchAll(/<voice name="([^"]+)" lang="([^"]+)">/g)]
  assert.deepEqual(langs.map((m) => m[2]), ['ru', 'fr', 'ru'])
  assert.ok(langs.every((m) => m[1] === 'Nec_24000'), 'один и тот же голос во всех тегах')
  assert.ok(/<prosody rate="100%" pitch="\+0%">/.test(ssml), 'просодия эмоции сохранена')
  assert.ok(ssml.indexOf('Князь улыбнулся.') < ssml.indexOf('Bonjour'))
  assert.ok(ssml.indexOf('Bonjour') < ssml.indexOf('Затем он вышел.'))
}

// --- XML экранируется ---
{
  const ssml = buildMultilingualSsml({
    text: 'Анна сказала: «Bonjour & merci, monsieur <Пьер>».',
    providerVoice: 'Pon_24000',
    prosody: PROSODY
  })
  assert.ok(ssml.includes('&amp;') && ssml.includes('&lt;') && !/<Пьер>/.test(ssml))
}

// --- Чисто русский текст: мультиязычная ветка не включается, кэш не инвалидируется ---
assert.equal(
  buildMultilingualSsml({ text: samples.ru, providerVoice: 'Nec_24000', prosody: PROSODY }),
  null
)
assert.equal(hasForeignLanguage(samples.ru), false)
assert.equal(hasForeignLanguage('Она посмотрела на Pierre и улыбнулась.'), false, 'латинское имя в русской фразе не переключает язык')

// --- Неподдерживаемая письменность читается как сейчас (без lang-переключения) ---
{
  const runs = splitLanguageRuns('Он увидел надпись. 「こんにちは、元気ですか」 И остановился.')
  assert.ok(runs.every((r) => r.lang === 'ru'), 'японский не получает lang-тег')
}

// --- Короткая реплика наследует язык соседнего фрагмента ---
{
  const runs = splitLanguageRuns('«Bonjour, mon ami, comment allez-vous?» Oui. Он кивнул.')
  assert.equal(runs[0].lang, 'fr')
  assert.ok(runs[0].text.includes('Oui'), 'короткое Oui. остаётся во французском куске')
  assert.equal(runs[runs.length - 1].lang, 'ru')
}

// --- Немецкий и английский без сильных маркеров — по частотным словам ---
assert.equal(detectTtsLanguage('Ich weiß nicht, was soll es bedeuten, dass ich so traurig bin.'), 'de')
assert.equal(detectTtsLanguage('It was the best of times, it was the worst of times.'), 'en')

console.log('check-tts-language: все проверки прошли')
