import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeCharacterVoices,
  normalizeNarratorVoice
} from '../src/shared/types.ts'

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
