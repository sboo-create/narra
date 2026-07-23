const VOICES = new Map([
  ['Che', { providerVoice: 'Che_48000', gender: 'female', group: 'assistant' }],
  ['She', { providerVoice: 'She_48000', gender: 'male', group: 'assistant' }],
  ['Erm', { providerVoice: 'Erm_48000', gender: 'female', group: 'assistant' }],
  ['Ast', { providerVoice: 'Ast_48000', gender: 'male', group: 'library' }],
  ['Gal', { providerVoice: 'Gal_48000', gender: 'male', group: 'library' }],
  ['Bez', { providerVoice: 'Bez_48000', gender: 'male', group: 'library' }],
  ['Ego', { providerVoice: 'Ego_48000', gender: 'male', group: 'library' }],
  ['Izv', { providerVoice: 'Izv_48000', gender: 'male', group: 'library' }],
  ['Ste', { providerVoice: 'Ste_48000', gender: 'female', group: 'library' }],
  ['Tso', { providerVoice: 'Tso_48000', gender: 'female', group: 'library' }],
  ['Chr', { providerVoice: 'Chr_48000', gender: 'female', group: 'library' }],
  ['Ksa', { providerVoice: 'Ksa_48000', gender: 'male', group: 'child' }],
  ['Saf', { providerVoice: 'Saf_48000', gender: 'female', group: 'child' }],
  ['Bsa', { providerVoice: 'Bsa_48000', gender: 'female', group: 'child' }],
  ['Mar', { providerVoice: 'Mar_48000', gender: 'male', group: 'manual' }],
  ['Kas', { providerVoice: 'Kas_48000', gender: 'male', group: 'manual' }]
])

export function voiceConfig(voice) {
  return VOICES.get(voice)
}

export function isSupportedVoice(voice) {
  return VOICES.has(voice)
}

export const SUPPORTED_VOICES = Object.freeze([...VOICES.keys()])
