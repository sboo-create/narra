import type { Segment } from '@shared/types'
import { buildSsml } from './ttsEmotion'

export type TtsStatus = 'idle' | 'preparing' | 'playing' | 'paused'
export type TtsMode = 'salute' | 'browser'

interface Opts {
  mode: TtsMode
  segments: Segment[]
  voiceFor: (charId: string | null) => string
  cacheKeyFor: (idx: number) => string
  onIndex: (idx: number) => void
  onStatus: (s: TtsStatus) => void
  onError: (msg: string) => void
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
  private prefetch = new Map<number, string>()

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
    this.setStatus(this.opts.mode === 'salute' ? 'preparing' : 'playing')
    this.playFrom(fromIndex)
  }

  private async playFrom(idx: number) {
    const myGen = this.gen
    if (idx >= this.opts.segments.length) {
      this.finish()
      return
    }
    this.index = idx
    this.opts.onIndex(idx)

    if (this.opts.mode === 'browser') {
      this.playBrowser(idx, myGen)
      return
    }
    // salute
    let url = this.prefetch.get(idx)
    if (!url) {
      const got = await this.synth(idx)
      if (myGen !== this.gen) return
      if (!got) {
        // сегмент не синтезировался — озвучим браузером, чтобы не прерывать поток
        this.playBrowser(idx, myGen)
        return
      }
      url = got
    }
    if (myGen !== this.gen) return
    this.setStatus('playing')
    this.prefetchNext(idx + 1)
    this.audio.src = url
    this.audio.playbackRate = this.speed
    this.audio.onended = () => {
      if (myGen !== this.gen) return
      this.playFrom(idx + 1)
    }
    this.audio.onerror = () => {
      if (myGen !== this.gen) return
      this.playFrom(idx + 1)
    }
    try {
      await this.audio.play()
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
      this.playFrom(idx + 1)
    }
    u.onerror = () => {
      if (myGen !== this.gen) return
      this.playFrom(idx + 1)
    }
    this.setStatus('playing')
    window.speechSynthesis.speak(u)
  }

  private async synth(idx: number): Promise<string | null> {
    const seg = this.opts.segments[idx]
    const voice = this.opts.voiceFor(seg.character)
    const res = await window.narra.synthesize(
      { ssml: buildSsml(seg.text, seg.emotion), voice },
      this.opts.cacheKeyFor(idx)
    )
    if (res.ok) return res.data!.dataUrl
    return null
  }

  private async prefetchNext(idx: number) {
    if (this.opts.mode !== 'salute') return
    if (idx >= this.opts.segments.length) return
    if (this.prefetch.has(idx)) return
    const url = await this.synth(idx)
    if (url) this.prefetch.set(idx, url)
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
    this.stop()
    this.gen++
    this.index = idx
    this.opts.onIndex(idx)
    if (wasActive) this.playFrom(idx)
  }

  private finish() {
    this.gen++
    this.audio.pause()
    window.speechSynthesis?.cancel()
    this.index = 0
    this.setStatus('idle')
    this.opts.onIndex(-1)
  }

  stop() {
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
