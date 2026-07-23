import { createHash } from 'node:crypto'

const CACHE_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,180}$/
const TTS_CACHE_VERSION = 'tts-cache-v2|48000|prosody-v1'

export function versionedAudioCacheKey(
  cacheKey: string,
  payload: { text?: string; ssml?: string; voice: string }
): string {
  if (!CACHE_KEY_PATTERN.test(cacheKey)) throw new Error('Некорректный ключ кэша')
  const baseKey = cacheKey.slice(0, 150)
  const fingerprint = createHash('sha256')
    .update(TTS_CACHE_VERSION)
    .update('\0')
    .update(payload.voice)
    .update('\0')
    .update(payload.ssml ?? payload.text ?? '')
    .digest('hex')
    .slice(0, 24)
  return `${baseKey}-${fingerprint}`
}
