import type { ChapterScenario, Character, Emotion, Segment } from '@shared/types'
import { scenarioMarkupRequest } from './prompts'

const EMOTIONS: Emotion[] = ['neutral', 'joy', 'tenderness', 'anger', 'fear', 'irony', 'sadness']

function chunkParagraphs(text: string, maxChars = 1500): string[] {
  const paras = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
  const chunks: string[] = []
  let cur = ''
  for (const p of paras) {
    if (cur && cur.length + p.length > maxChars) {
      chunks.push(cur)
      cur = p
    } else {
      cur = cur ? `${cur}\n\n${p}` : p
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

function validSegments(raw: unknown, charIds: Set<string>): Segment[] | null {
  if (!Array.isArray(raw)) return null
  const out: Segment[] = []
  for (const s of raw) {
    if (!s || typeof s.text !== 'string' || !s.text.trim()) continue
    const type = s.type === 'speech' ? 'speech' : 'narration'
    let character: string | null = null
    if (type === 'speech' && typeof s.character === 'string' && charIds.has(s.character)) {
      character = s.character
    }
    const emotion: Emotion = EMOTIONS.includes(s.emotion) ? s.emotion : 'neutral'
    out.push({ type, character, emotion, text: s.text.trim() })
  }
  return out.length ? out : null
}

/** Наивный сценарий без LLM: каждый абзац — сегмент-нарратор. */
export function fallbackScenario(chapter: number, text: string): ChapterScenario {
  const segments: Segment[] = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ type: 'narration' as const, character: null, emotion: 'neutral' as Emotion, text: p }))
  return { chapter, segments }
}

/**
 * Размечает главу в сценарий через GigaChat (по чанкам). Если чанк не размечается —
 * он остаётся как нарраторный сегмент. Никогда не бросает исключение.
 */
export async function markupChapter(
  chapter: number,
  text: string,
  characters: Character[],
  onProgress?: (done: number, total: number) => void
): Promise<ChapterScenario> {
  const charIds = new Set(characters.map((c) => c.id))
  const roster = characters.map((c) => ({ id: c.id, name: c.name }))
  const chunks = chunkParagraphs(text)
  const segments: Segment[] = []

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length)
    const res = await window.narra.llmJson<unknown>(scenarioMarkupRequest(chunks[i], roster))
    const segs = res.ok ? validSegments(res.data, charIds) : null
    if (segs) segments.push(...segs)
    else {
      // fallback для этого чанка
      chunks[i]
        .split(/\n\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .forEach((p) => segments.push({ type: 'narration', character: null, emotion: 'neutral', text: p }))
    }
  }
  onProgress?.(chunks.length, chunks.length)
  return { chapter, segments: segments.length ? segments : fallbackScenario(chapter, text).segments }
}
