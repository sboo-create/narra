import type { ChapterScenario, Character, Emotion, Segment } from '@shared/types'
import { progressiveChapterChunks } from '@shared/chapter-chunks'
import { splitFirstAudioText } from '@shared/first-audio'
import { scenarioMarkupRequest } from './prompts'

const EMOTIONS: Emotion[] = ['neutral', 'joy', 'tenderness', 'anger', 'fear', 'irony', 'sadness']
const MARKUP_CONCURRENCY = 3

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
  return normalizeFirstAudioScenario({ chapter, segments })
}

export function normalizeFirstAudioScenario(scenario: ChapterScenario): ChapterScenario {
  const segments = scenario.segments.map((segment) => ({ ...segment }))
  if (!segments[0]) return { ...scenario, segments }
  const [firstText, remainder] = splitFirstAudioText(segments[0].text)
  segments[0].text = firstText
  if (remainder) segments.splice(1, 0, { ...segments[0], text: remainder })
  return { ...scenario, segments }
}

export interface ChapterScenarioPreparation {
  origin: 'user' | 'background'
  firstReady: Promise<ChapterScenario>
  complete: Promise<ChapterScenario>
  subscribeProgress: (listener: (done: number, total: number) => void) => () => void
  cancel: () => boolean
  getFallbackCount: () => number
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function cancelledError(): Error {
  const error = new Error('Chapter preparation cancelled')
  error.name = 'AbortError'
  return error
}

const inFlightMarkup = new Map<string, ChapterScenarioPreparation>()

/**
 * Returns the first marked-up block separately from the ordered full result.
 * Failed provider chunks degrade to narrator-only text; explicit cancellation
 * is the only rejecting path.
 */
export function prepareChapterScenario(
  key: string,
  chapter: number,
  text: string,
  characters: Character[],
  origin: 'user' | 'background' = 'user'
): ChapterScenarioPreparation {
  const existing = inFlightMarkup.get(key)
  if (existing) return existing

  const charIds = new Set(characters.map((c) => c.id))
  const roster = characters.map((c) => ({ id: c.id, name: c.name }))
  const chunks = progressiveChapterChunks(text)
  let completed = 0
  let fallbackCount = 0
  let cancelled = false
  let terminal = false
  let firstSettled = false
  let latestProgress = { done: 0, total: chunks.length }
  const progressListeners = new Set<(done: number, total: number) => void>()
  const first = deferred<ChapterScenario>()
  const notify = () => {
    for (const listener of progressListeners) listener(latestProgress.done, latestProgress.total)
  }
  const markupChunk = async (chunk: string): Promise<Segment[]> => {
    if (cancelled) throw cancelledError()
    let segs: Segment[] | null = null
    try {
      const res = await window.narra.llmJson<unknown>(
        scenarioMarkupRequest(chunk, roster),
        origin
      )
      segs = res.ok ? validSegments(res.data, charIds) : null
    } catch {
      // IPC/provider failure degrades this chunk to narrator-only playback.
    }
    if (cancelled) throw cancelledError()
    completed += 1
    latestProgress = { done: completed, total: chunks.length }
    notify()
    if (segs) return segs
    fallbackCount += 1
    return chunk
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ type: 'narration', character: null, emotion: 'neutral', text: p }))
  }

  const complete = (async () => {
    try {
      if (!chunks.length) {
        const fallback = fallbackScenario(chapter, text)
        terminal = true
        firstSettled = true
        first.resolve(fallback)
        return fallback
      }
      const chunkSegments: Segment[][] = new Array(chunks.length)
      chunkSegments[0] = await markupChunk(chunks[0])
      const bootstrap = normalizeFirstAudioScenario({ chapter, segments: chunkSegments[0] })
      firstSettled = true
      first.resolve(bootstrap)

      let next = 1
      const worker = async () => {
        while (!cancelled && next < chunks.length) {
          const index = next++
          chunkSegments[index] = await markupChunk(chunks[index])
        }
        if (cancelled) throw cancelledError()
      }
      await Promise.all(
        Array.from(
          { length: Math.min(MARKUP_CONCURRENCY, Math.max(0, chunks.length - 1)) },
          () => worker()
        )
      )
      if (cancelled) throw cancelledError()
      const result = normalizeFirstAudioScenario({ chapter, segments: chunkSegments.flat() })
      terminal = true
      return result
    } catch (error) {
      terminal = true
      if (!firstSettled) {
        firstSettled = true
        first.reject(error instanceof Error ? error : cancelledError())
      }
      throw error
    }
  })()
  const preparation: ChapterScenarioPreparation = {
    origin,
    firstReady: first.promise,
    complete,
    subscribeProgress(listener) {
      progressListeners.add(listener)
      listener(latestProgress.done, latestProgress.total)
      return () => progressListeners.delete(listener)
    },
    cancel() {
      if (cancelled || terminal) return false
      cancelled = true
      terminal = true
      if (!firstSettled) {
        firstSettled = true
        first.reject(cancelledError())
      }
      return true
    },
    getFallbackCount: () => fallbackCount
  }
  void first.promise.catch(() => undefined)
  inFlightMarkup.set(key, preparation)
  void complete.finally(() => {
    if (inFlightMarkup.get(key) === preparation) inFlightMarkup.delete(key)
  }).catch(() => undefined)
  return preparation
}

export function cancelPreparedBook(bookId: string): Array<'user' | 'background'> {
  const cancelled: Array<'user' | 'background'> = []
  for (const [key, preparation] of inFlightMarkup) {
    if (key === bookId || key.startsWith(`${bookId}-`)) {
      if (preparation.cancel()) cancelled.push(preparation.origin)
    }
  }
  return cancelled
}
