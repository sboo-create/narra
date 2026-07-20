// Обёртка над браузерным speechSynthesis: последовательное чтение абзацев
// с колбэком подсветки текущего абзаца.

function pickRussianVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  return (
    voices.find((v) => v.lang.toLowerCase().startsWith('ru')) ||
    voices.find((v) => /russian/i.test(v.name)) ||
    null
  )
}

export interface SpeechController {
  stop: () => void
}

export function speak(
  paragraphs: string[],
  opts: {
    onParagraph?: (index: number) => void
    onEnd?: () => void
    startIndex?: number
  } = {}
): SpeechController {
  const synth = window.speechSynthesis
  synth.cancel()

  let cancelled = false
  let idx = opts.startIndex ?? 0

  const voice = pickRussianVoice()

  const next = () => {
    if (cancelled) return
    if (idx >= paragraphs.length) {
      opts.onEnd?.()
      return
    }
    const text = paragraphs[idx].trim()
    if (!text) {
      idx++
      next()
      return
    }
    opts.onParagraph?.(idx)
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ru-RU'
    if (voice) u.voice = voice
    u.rate = 0.98
    u.pitch = 1.0
    u.onend = () => {
      if (cancelled) return
      idx++
      next()
    }
    u.onerror = () => {
      if (cancelled) return
      idx++
      next()
    }
    synth.speak(u)
  }

  // голоса могут подгрузиться асинхронно
  if (window.speechSynthesis.getVoices().length === 0) {
    const handler = () => {
      window.speechSynthesis.onvoiceschanged = null
      next()
    }
    window.speechSynthesis.onvoiceschanged = handler
    setTimeout(next, 250)
  } else {
    next()
  }

  return {
    stop: () => {
      cancelled = true
      synth.cancel()
    }
  }
}

export function speakOnce(text: string, onEnd?: () => void): SpeechController {
  return speak([text], { onEnd })
}
