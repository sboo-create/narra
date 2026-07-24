import type { SaluteVoice, Segment } from '@shared/types'
import { CoalescedTaskMap } from '@shared/coalesced-task'
import { listenedFraction } from '@shared/playback-progress'
import { buildSsml } from './ttsEmotion'

export type TtsStatus = 'idle' | 'preparing' | 'playing' | 'paused'
export type TtsMode = 'salute' | 'browser'

interface Opts {
  mode: TtsMode
  segments: Segment[]
  voiceFor: (charId: string | null) => SaluteVoice
  cacheKeyFor: (idx: number) => string
  onIndex: (idx: number) => void
  onStatus: (s: TtsStatus) => void
  onError: (msg: string) => void
  onFirstAudioReady?: (latencyMs: number, cached: boolean) => void
  onPlaybackStarted?: (cached: boolean) => void
  onPlaybackAbandoned?: (listenedFraction: number) => void
  waitForMore?: (currentLength: number) => Promise<boolean>
}

function pickRuVoice(): SpeechSynthesisVoice | null {
  const vs = window.speechSynthesis?.getVoices() || []
  return vs.find((v) => v.lang.toLowerCase().startsWith('ru')) || vs.find((v) => /russian/i.test(v.name)) || null
}

export class TtsController {
  private opts: Opts
  private audio = new Audio()
  private index = 0
  private speed = 1
  private status: TtsStatus = 'idle'
  private gen = 0 // отсекаем устаревшие асинхронные колбэки
  private prefetch = new CoalescedTaskMap<number, { url: string; cached: boolean } | null>()
  private requestedAt = 0
  private playbackStarted = false
  private playbackReported = false
  private completedChars = 0
  private currentCharIndex = 0

  constructor(opts: Opts) {
    this.opts = opts
    this.audio.preservesPitch = true
  }

  getStatus(): TtsStatus {
    return this.status
  }
  getIndex(): number {
    return this.index
  }

  private setStatus(s: TtsStatus) {
    this.status = s
    this.opts.onStatus(s)
  }

  setSpeed(s: number) {
    this.speed = s
    this.audio.playbackRate = s
    // для браузерного режима скорость применится на следующем сегменте
    if (this.opts.mode === 'browser' && this.status === 'playing') {
      const cur = this.index
      this.gen++ // иначе onend отменённой реплики запустит следующий сегмент параллельно
      window.speechSynthesis.cancel()
      this.playFrom(cur)
    }
  }

  async start(fromIndex = 0) {
    this.stop()
    this.gen++
    this.index = fromIndex
    this.completedChars = this.opts.segments
      .slice(0, fromIndex)
      .reduce((sum, segment) => sum + segment.text.length, 0)
    this.currentCharIndex = 0
    this.requestedAt = performance.now()
    this.playbackStarted = false
    this.playbackReported = false
    this.setStatus(this.opts.mode === 'salute' ? 'preparing' : 'playing')
    this.playFrom(fromIndex)
  }

  private async playFrom(idx: number) {
    const myGen = this.gen
    if (idx >= this.opts.segments.length) {
      if (this.opts.waitForMore && await this.opts.waitForMore(idx)) {
        if (myGen === this.gen) this.playFrom(idx)
        return
      }
      if (myGen !== this.gen) return
      this.finish()
      return
    }
    this.index = idx
    this.currentCharIndex = 0
    this.opts.onIndex(idx)

    if (this.opts.mode === 'browser') {
      this.playBrowser(idx, myGen)
      return
    }
    // salute
    const got = await this.audioFor(idx)
    if (myGen !== this.gen) return
    if (!got) {
      // сегмент не синтезировался — озвучим браузером, чтобы не прерывать поток
      this.playBrowser(idx, myGen)
      return
    }
    const { url, cached } = got
    if (idx === 0) {
      this.opts.onFirstAudioReady?.(Math.max(0, performance.now() - this.requestedAt), cached)
    }
    if (myGen !== this.gen) return
    this.setStatus('playing')
    this.prefetchNext(idx + 1)
    this.audio.src = url
    this.audio.playbackRate = this.speed
    this.audio.onended = () => {
      if (myGen !== this.gen) return
      this.completedChars += this.opts.segments[idx]?.text.length || 0
      this.currentCharIndex = 0
      this.playFrom(idx + 1)
    }
    this.audio.onerror = () => {
      if (myGen !== this.gen) return
      this.playFrom(idx + 1)
    }
    try {
      await this.audio.play()
      if (myGen === this.gen && !this.playbackReported) {
        this.playbackStarted = true
        this.playbackReported = true
        this.opts.onPlaybackStarted?.(cached)
      }
    } catch {
      if (myGen === this.gen) this.playFrom(idx + 1)
    }
  }

  private playBrowser(idx: number, myGen: number) {
    const seg = this.opts.segments[idx]
    const u = new SpeechSynthesisUtterance(seg.text)
    u.lang = 'ru-RU'
    const v = pickRuVoice()
    if (v) u.voice = v
    u.rate = Math.min(2, Math.max(0.75, this.speed))
    u.onend = () => {
      if (myGen !== this.gen) return
      this.completedChars += seg.text.length
      this.currentCharIndex = 0
      this.playFrom(idx + 1)
    }
    u.onerror = () => {
      if (myGen !== this.gen) return
      this.playFrom(idx + 1)
    }
    u.onboundary = (event) => {
      if (myGen === this.gen) this.currentCharIndex = Math.max(0, event.charIndex || 0)
    }
    this.setStatus('playing')
    if (!this.playbackReported) {
      this.playbackStarted = true
      this.playbackReported = true
      this.opts.onPlaybackStarted?.(false)
    }
    window.speechSynthesis.speak(u)
  }

  private async synth(idx: number): Promise<{ url: string; cached: boolean } | null> {
    const seg = this.opts.segments[idx]
    const voice = this.opts.voiceFor(seg.character)
    const res = await window.narra.synthesize(
      { ssml: buildSsml(seg.text, seg.emotion, voice), voice },
      this.opts.cacheKeyFor(idx)
    )
    if (res.ok) return { url: res.data!.dataUrl, cached: Boolean(res.data!.cached) }
    return null
  }

  private audioFor(idx: number): Promise<{ url: string; cached: boolean } | null> {
    return this.prefetch.getOrCreate(idx, async () => {
      const result = await this.synth(idx)
      if (!result) this.prefetch.delete(idx)
      return result
    })
  }

  private prefetchNext(idx: number) {
    if (this.opts.mode !== 'salute') return
    if (idx >= this.opts.segments.length) return
    void this.audioFor(idx)
  }

  pause() {
    if (this.status !== 'playing') return
    if (this.opts.mode === 'salute') this.audio.pause()
    else window.speechSynthesis.pause()
    this.setStatus('paused')
  }

  resume() {
    if (this.status !== 'paused') return
    if (this.opts.mode === 'salute') this.audio.play().catch(() => {})
    else window.speechSynthesis.resume()
    this.setStatus('playing')
  }

  toggle() {
    if (this.status === 'playing') this.pause()
    else if (this.status === 'paused') this.resume()
  }

  seek(idx: number) {
    const wasActive = this.status === 'playing' || this.status === 'preparing'
    this.stop(false)
    this.gen++
    this.index = idx
    this.completedChars = this.opts.segments
      .slice(0, idx)
      .reduce((sum, segment) => sum + segment.text.length, 0)
    this.currentCharIndex = 0
    this.playbackReported = false
    this.opts.onIndex(idx)
    if (wasActive) this.playFrom(idx)
  }

  private finish() {
    this.gen++
    this.audio.pause()
    window.speechSynthesis?.cancel()
    this.index = 0
    this.playbackStarted = false
    this.setStatus('idle')
    this.opts.onIndex(-1)
  }

  stop(reportAbandonment = true) {
    if (this.playbackStarted) {
      const totalChars = Math.max(
        1,
        this.opts.segments.reduce((sum, segment) => sum + segment.text.length, 0)
      )
      let partialChars = this.currentCharIndex
      if (
        this.opts.mode === 'salute' &&
        Number.isFinite(this.audio.duration) &&
        this.audio.duration > 0
      ) {
        partialChars = Math.round(
          (this.opts.segments[this.index]?.text.length || 0) *
          Math.min(1, Math.max(0, this.audio.currentTime / this.audio.duration))
        )
      }
      if (reportAbandonment) {
        this.opts.onPlaybackAbandoned?.(listenedFraction(
          this.completedChars,
          this.opts.segments[this.index]?.text.length || 0,
          (this.opts.segments[this.index]?.text.length || 0) > 0
            ? partialChars / (this.opts.segments[this.index]?.text.length || 1)
            : 0,
          totalChars
        ))
      }
    }
    this.playbackStarted = false
    this.gen++
    try {
      this.audio.pause()
      this.audio.onended = null
      this.audio.onerror = null
    } catch {
      /* ignore */
    }
    window.speechSynthesis?.cancel()
    this.setStatus('idle')
    this.opts.onIndex(-1)
  }
}
