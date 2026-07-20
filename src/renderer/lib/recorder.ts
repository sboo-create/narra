// Запись голоса с микрофона в PCM16 16кГц — формат, который понимает SaluteSpeech ASR.

export interface VoiceRecording {
  base64: string
  mime: string
  seconds: number
}

export class VoiceRecorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private proc: ScriptProcessorNode | null = null
  private chunks: Float32Array[] = []
  private startedAt = 0

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.ctx = new AudioContext({ sampleRate: 16000 })
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1)
    this.chunks = []
    this.proc.onaudioprocess = (e) => {
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }
    src.connect(this.proc)
    this.proc.connect(this.ctx.destination)
    this.startedAt = Date.now()
  }

  async stop(): Promise<VoiceRecording> {
    const seconds = (Date.now() - this.startedAt) / 1000
    this.proc?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    const rate = this.ctx?.sampleRate || 16000
    await this.ctx?.close()

    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const pcm = new Int16Array(total)
    let off = 0
    for (const c of this.chunks) {
      for (let i = 0; i < c.length; i++) {
        const s = Math.max(-1, Math.min(1, c[i]))
        pcm[off++] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
    }
    const bytes = new Uint8Array(pcm.buffer)
    let bin = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    this.chunks = []
    return { base64: btoa(bin), mime: `audio/x-pcm;bit=16;rate=${rate}`, seconds }
  }
}
