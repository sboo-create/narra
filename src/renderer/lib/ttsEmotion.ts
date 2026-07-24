import {
  saluteVoiceSampleRate,
  type Emotion,
  type SaluteVoice
} from '@shared/types'
import { buildMultilingualSsml } from './ttsLanguage'

// Маппинг эмоция → просодия SSML. Вынесен в конфиг — легко тюнить.
// SaluteSpeech поддерживает <prosody rate pitch> и <break>.
interface Prosody {
  rate: string // проценты, напр. '105%'
  pitch: string // напр. '+6%' / '-4%'
  endPauseMs: number
}

export const EMOTION_SSML: Record<Emotion, Prosody> = {
  neutral: { rate: '100%', pitch: '+0%', endPauseMs: 120 },
  joy: { rate: '110%', pitch: '+9%', endPauseMs: 90 },
  tenderness: { rate: '92%', pitch: '+3%', endPauseMs: 220 },
  anger: { rate: '112%', pitch: '+5%', endPauseMs: 80 },
  fear: { rate: '114%', pitch: '+11%', endPauseMs: 100 },
  irony: { rate: '96%', pitch: '+4%', endPauseMs: 180 },
  sadness: { rate: '86%', pitch: '-7%', endPauseMs: 260 }
}

export const EMOTION_LABEL: Record<Emotion, string> = {
  neutral: 'спокойно',
  joy: 'радостно',
  tenderness: 'нежно',
  anger: 'гневно',
  fear: 'испуганно',
  irony: 'с иронией',
  sadness: 'печально'
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildSsml(text: string, emotion: Emotion, voice?: SaluteVoice): string {
  const p = EMOTION_SSML[emotion] || EMOTION_SSML.neutral
  if (voice) {
    // Иноязычные вставки (французский в «Войне и мире» и т.п.) получают свой
    // lang в <voice name lang>; имя и sample rate совпадают с gateway registry.
    const multilingual = buildMultilingualSsml({
      text: text.trim(),
      providerVoice: `${voice}_${saluteVoiceSampleRate(voice)}`,
      prosody: p
    })
    if (multilingual) return multilingual
  }
  // паузы между предложениями — речь звучит естественнее
  const sentences = text
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .filter(Boolean)
    .map((s) => escapeXml(s))
    .join(`<break time="260ms"/>`)
  return `<speak><prosody rate="${p.rate}" pitch="${p.pitch}">${sentences}</prosody><break time="${p.endPauseMs}ms"/></speak>`
}

// Скорость 0.75–2× применяется отдельно на уровне плеера (playbackRate / utterance.rate).
