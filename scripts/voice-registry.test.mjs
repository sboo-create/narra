import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  AUTO_FEMALE_VOICES,
  AUTO_MALE_VOICES,
  CHILD_FEMALE_VOICES,
  CHILD_MALE_VOICES,
  SALUTE_24K_VOICES,
  SALUTE_VOICES,
  assignBookCharacterVoices,
  normalizeCharacterVoices,
  normalizeNarratorVoice,
  saluteVoiceSampleRate
} from '../src/shared/types.ts'
import { SUPPORTED_VOICES, voiceConfig } from '../server/voices.mjs'

const manifest = JSON.parse(
  fs.readFileSync(new URL('../docs/evidence/salutespeech-active-voices.json', import.meta.url), 'utf8')
)
const probeRows = fs
  .readFileSync(new URL('../docs/evidence/salutespeech-voice-probe-2026-07-23.csv', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const [code, sampleRate, status, contentType, actualRate] = line.split(',')
    return { code, sampleRate: Number(sampleRate), status: Number(status), contentType, actualRate: Number(actualRate) }
  })

function character(id, gender, voice) {
  return {
    id,
    name: id,
    fullName: id,
    role: '',
    gender,
    voice,
    traits: [],
    speechStyle: '',
    speechExamples: [],
    appearancePrompt: ''
  }
}

test('legacy narrator and character voices migrate to the 48 kHz registry', () => {
  assert.equal(normalizeNarratorVoice('Pon'), 'Che')
  assert.equal(normalizeNarratorVoice('She'), 'She')

  const migrated = normalizeCharacterVoices([
    character('m1', 'male', 'Bys'),
    character('m2', 'male', 'Tur'),
    character('f1', 'female', 'Nec'),
    character('f2', 'female', 'May'),
    character('kept', 'female', 'Erm')
  ])
  assert.deepEqual(migrated.map((item) => item.voice), ['Ast', 'Gal', 'Ste', 'Tso', 'Erm'])
})

test('client, gateway, reviewed manifest and saved provider probes agree', () => {
  const reviewed = manifest.groups.flatMap((group) =>
    group.codes.map((code) => ({
      code,
      sampleRate: group.sample_rate,
      gender: group.gender,
      group: group.group
    }))
  )
  assert.equal(SALUTE_VOICES.length, 86)
  assert.equal(new Set(SALUTE_VOICES).size, SALUTE_VOICES.length)
  assert.deepEqual(new Set(SUPPORTED_VOICES), new Set(SALUTE_VOICES))
  assert.deepEqual(new Set(reviewed.map((row) => row.code)), new Set(SALUTE_VOICES))
  assert.equal(SALUTE_24K_VOICES.length, 70)

  for (const voice of SALUTE_VOICES) {
    const config = voiceConfig(voice)
    const evidence = reviewed.find((row) => row.code === voice)
    assert.ok(config)
    assert.ok(evidence)
    assert.equal(config.sampleRate, saluteVoiceSampleRate(voice))
    assert.equal(config.providerVoice, `${voice}_${config.sampleRate}`)
    assert.equal(config.sampleRate, evidence.sampleRate)
    assert.equal(config.gender, evidence.gender)
    assert.equal(config.group, evidence.group)
    assert.ok(
      probeRows.some(
        (row) =>
          row.code === voice &&
          row.sampleRate === config.sampleRate &&
          row.status === 200 &&
          row.contentType === 'audio/wav' &&
          row.actualRate === config.sampleRate
      ),
      `${voice}_${config.sampleRate} has no saved successful WAV probe`
    )
  }
})

test('automatic pools prioritize 48 kHz and exclude probe-only manual voices', () => {
  assert.deepEqual(AUTO_MALE_VOICES.slice(0, 5), ['Ast', 'Gal', 'Bez', 'Ego', 'Izv'])
  assert.deepEqual(AUTO_FEMALE_VOICES.slice(0, 3), ['Ste', 'Tso', 'Chr'])
  assert.equal(AUTO_MALE_VOICES.length, 26)
  assert.equal(AUTO_FEMALE_VOICES.length, 16)
  assert.deepEqual(CHILD_MALE_VOICES, ['Ksa', 'Kkr', 'Ktr'])
  assert.deepEqual(CHILD_FEMALE_VOICES, ['Saf', 'Bsa', 'Kbu', 'Koz'])
  const automatic = new Set([
    ...AUTO_MALE_VOICES,
    ...AUTO_FEMALE_VOICES,
    ...CHILD_MALE_VOICES,
    ...CHILD_FEMALE_VOICES
  ])
  const pending = manifest.groups.find(
    (group) => group.evidence_id === 'probe-only-pending-product-review'
  )
  assert.ok(pending)
  for (const voice of pending.codes) assert.equal(automatic.has(voice), false)
})

test('main-character voices follow narrator gender rules without duplicating Sber', () => {
  const maleHero = character('hero', 'male', 'She')
  const maleFriend = character('friend', 'male', 'She')
  const femaleFriend = character('friend-f', 'female', 'Che')
  assert.deepEqual(
    assignBookCharacterVoices([maleHero, maleFriend, femaleFriend], 'She').map((item) => item.voice),
    ['Ast', 'Gal', 'Ste'],
    'Sber narrator must send a male protagonist to the first male library voice'
  )
  assert.equal(assignBookCharacterVoices([maleHero], 'Che')[0].voice, 'She')
  assert.equal(assignBookCharacterVoices([character('hero-f', 'female', 'Che')], 'Che')[0].voice, 'Erm')
  assert.equal(
    assignBookCharacterVoices([{ ...maleHero, isNarrator: true }], 'She')[0].voice,
    'She',
    'a first-person protagonist shares the narrator voice'
  )
  assert.deepEqual(
    assignBookCharacterVoices([
      maleHero,
      {
        ...character('girl', 'female', 'Che'),
        passport: { age: 10, gender: 'female', build: '', hair: '', eyes: '', face: '', outfit: '' }
      },
      {
        ...character('boy', 'male', 'She'),
        passport: { age: 9, gender: 'male', build: '', hair: '', eyes: '', face: '', outfit: '' }
      }
    ], 'Che').map((item) => item.voice),
    ['She', 'Saf', 'Ksa']
  )
})
