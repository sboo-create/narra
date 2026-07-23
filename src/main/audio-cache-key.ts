import { createHash } from 'node:crypto'
import { isSaluteVoice, saluteVoiceSampleRate } from '../shared/types.ts'

const CACHE_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,180}$/
const TTS_CACHE_VERSION = 'tts-cache-v3|prosody-v1'

export function versionedAudioCacheKey(
  cacheKey: string,
  payload: { text?: string; ssml?: string; voice: string }
): string {
  if (!CACHE_KEY_PATTERN.test(cacheKey)) throw new Error('Некорректный ключ кэша')
  if (!isSaluteVoice(payload.voice)) throw new Error('Неподдерживаемый голос')
  const baseKey = cacheKey.slice(0, 150)
  const fingerprint = createHash('sha256')
    .update(TTS_CACHE_VERSION)
    .update('\0')
    .update(payload.voice)
    .update('\0')
    .update(String(saluteVoiceSampleRate(payload.voice)))
    .update('\0')
    .update(payload.ssml ?? payload.text ?? '')
    .digest('hex')
    .slice(0, 24)
  return `${baseKey}-${fingerprint}`
}
