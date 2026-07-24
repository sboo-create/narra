const MIN_FIRST_AUDIO_CHARS = 150
const MAX_FIRST_AUDIO_CHARS = 300

/**
 * Keeps the first provider request short enough to start playback quickly,
 * without cutting early when the opening sentence is already small.
 */
export function splitFirstAudioText(text: string): [string, string?] {
  const value = text.trim()
  if (value.length <= MAX_FIRST_AUDIO_CHARS) return [value]
  const window = value.slice(0, MAX_FIRST_AUDIO_CHARS + 1)
  const sentenceBreak = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('… ')
  )
  const whitespaceBreak = window.lastIndexOf(' ')
  const cut = sentenceBreak >= MIN_FIRST_AUDIO_CHARS
    ? sentenceBreak + 1
    : whitespaceBreak >= MIN_FIRST_AUDIO_CHARS
      ? whitespaceBreak
      : MAX_FIRST_AUDIO_CHARS
  return [value.slice(0, cut).trim(), value.slice(cut).trim()]
}
