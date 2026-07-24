import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCharacterMarkup } from '../src/shared/character-markup.ts'

function payload(overrides = {}) {
  return {
    mainCharacterId: 'hero',
    firstPersonNarratorCharacterId: null,
    characters: [
      { id: 'hero', name: 'Герой' },
      { id: 'friend', name: 'Друг' }
    ],
    ...overrides
  }
}

test('character markup rejects empty and ambiguous normalized identifiers', () => {
  assert.equal(normalizeCharacterMarkup(payload({ mainCharacterId: '---' })).ok, false)
  assert.equal(normalizeCharacterMarkup(payload({
    characters: [
      { id: 'Иван', name: 'Иван' },
      { id: 'ivan', name: 'Другой Иван' }
    ],
    mainCharacterId: 'Иван'
  })).ok, false)
})

test('character markup rejects a main character without a required name', () => {
  const normalized = normalizeCharacterMarkup(payload({
    characters: [
      { id: 'hero' },
      { id: 'friend', name: 'Друг' }
    ]
  }))
  assert.equal(normalized.ok, false)
})

test('character markup rejects a first-person narrator different from the main character', () => {
  const normalized = normalizeCharacterMarkup(payload({
    firstPersonNarratorCharacterId: 'friend'
  }))
  assert.equal(normalized.ok, false)
})

test('character markup puts the validated main first and preserves exact narrator identity', () => {
  const normalized = normalizeCharacterMarkup(payload({
    mainCharacterId: 'friend',
    firstPersonNarratorCharacterId: 'friend'
  }))
  assert.equal(normalized.ok, true)
  assert.equal(normalized.characters[0].id, 'friend')
  assert.equal(normalized.firstPersonNarratorCharacterId, 'friend')
})
