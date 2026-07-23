import { useEffect, useRef, useState } from 'react'
import { useStore, canChat, canTts, canImage, charKey } from '../store/useStore'
import { Locker } from '../components/Locker'
import { chatMessages, summaryRequest, memoryUpdateRequest, emotionRequest } from '../lib/prompts'
import { buildSsml, EMOTION_LABEL } from '../lib/ttsEmotion'
import { hasForeignLanguage } from '../lib/ttsLanguage'
import { speakOnce, SpeechController } from '../lib/voice'
import { LivingPortrait } from '../components/LivingPortrait'
import { CharAvatar } from '../components/CharAvatar'
import { portraitKey } from '../lib/imageStyle'
import { portraitPrompt } from '../lib/passport'
import { VoiceRecorder } from '../lib/recorder'
import type { ChatMessage, Emotion } from '@shared/types'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const EMOTIONS: Emotion[] = ['neutral', 'joy', 'tenderness', 'anger', 'fear', 'irony', 'sadness']

interface Props {
  id: string
  sceneContext?: string
  autoAsk?: string
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function Chat({ id, sceneContext, autoAsk }: Props) {
  const fanfic = useStore((s) => s.fanfic)!
  const characters = useStore((s) => s.characters)
  const health = useStore((s) => s.health)
  const persisted = useStore((s) => s.persisted)
  const setChats = useStore((s) => s.setChats)
  const clearChat = useStore((s) => s.clearChat)
  const recordAsk = useStore((s) => s.recordAsk)
  const setSummary = useStore((s) => s.setSummary)
  const setMemory = useStore((s) => s.setMemory)
  const voiceFor = useStore((s) => s.voiceFor)
  const navigate = useStore((s) => s.navigate)
  const toast = useStore((s) => s.toast)

  const char = characters.find((c) => c.id === id)!
  const readChapter = useStore((s) => s.chapter)

  const ckey = charKey(fanfic.id, id)
  const [messages, setMessages] = useState<ChatMessage[]>(persisted.chats[ckey] || [])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [emotion, setEmotion] = useState<Emotion>('neutral')
  const [avatarVideo, setAvatarVideo] = useState<string | null>(null)
  const [avatarBusy, setAvatarBusy] = useState<string | null>(null)
  const [micState, setMicState] = useState<'idle' | 'rec' | 'stt'>('idle')
  const recRef = useRef<VoiceRecorder | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  const speechRef = useRef<SpeechController | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speakTargetRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const streamIdRef = useRef<string | null>(null)

  const gcReady = canChat(health)
  const ttsReady = canTts(health)
  const videoReady = canImage(health) // видео-аватар использует Kandinsky-токен

  async function animateReply(m: ChatMessage) {
    if (avatarBusy) return
    const imgRes = await window.narra.getCachedImage(portraitKey(fanfic.id, id))
    if (!imgRes.ok) {
      toast({ type: 'info', title: 'Сначала портрет', message: 'Открой карточку персонажа — портрет сгенерится, потом оживим.' })
      return
    }
    setAvatarBusy(m.id)
    // эмоция → голос
    let emo: Emotion = 'neutral'
    if (gcReady) {
      const er = await window.narra.llmText(emotionRequest(m.content), 0)
      const w = (er.ok ? er.data!.text : '').trim().toLowerCase()
      const f = EMOTIONS.find((e) => w.includes(e))
      if (f) emo = f
    }
    const voice = voiceFor(id)
    const aud = await window.narra.synthesize(
      { ssml: buildSsml(m.content, emo, voice), voice },
      `chatmsg-${m.id}-${emo}${hasForeignLanguage(m.content) ? '-ml1' : ''}`
    )
    if (!aud.ok) {
      setAvatarBusy(null)
      toast({ type: 'error', title: 'Озвучка не удалась', message: aud.error })
      return
    }
    const vid = await window.narra.generateAvatar(imgRes.data!.dataUrl, aud.data!.dataUrl, `avatar-${m.id}-${emo}`)
    setAvatarBusy(null)
    if (vid.ok) {
      setEmotion(emo)
      setAvatarVideo(vid.data!.dataUrl)
    } else {
      toast({ type: 'error', title: 'Видео не удалось', message: vid.error, onRetry: () => animateReply(m) })
    }
  }

  useEffect(() => {
    const existing = persisted.chats[ckey] || []
    if (existing.length === 0 && char.greeting) {
      // приветствие персонажа как первая реплика
      const greet: ChatMessage = { id: uid(), role: 'assistant', content: char.greeting, ts: Date.now() }
      setMessages([greet])
      setChats(id, [greet])
    } else {
      setMessages(existing)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const autoAskedRef = useRef(false)
  useEffect(() => {
    if (autoAsk && gcReady && !autoAskedRef.current) {
      autoAskedRef.current = true
      setTimeout(() => send(autoAsk), 400)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk, gcReady])

  // фоново подготовить саммари ВСЕХ прочитанных глав: без них герой знает
  // из прошлого только заголовки и отвечает пусто. С текущей главы — назад.
  useEffect(() => {
    if (!gcReady) return
    let alive = true
    ;(async () => {
      const order = []
      for (let n = readChapter; n >= 1; n--) order.push(n)
      for (const n of order) {
        if (!alive) return
        const key = `${fanfic.id}-${n}`
        if (useStore.getState().persisted.summaries[key]) continue
        const ch = fanfic.chapters[n - 1]
        if (!ch) continue
        const r = await window.narra.llmText(summaryRequest(ch.text, ch.title), 0.4)
        if (!alive) return
        if (r.ok && r.data!.text.trim()) setSummary(key, r.data!.text.trim())
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readChapter, gcReady])

  useEffect(() => {
    return () => {
      cancelRef.current?.()
      speechRef.current?.stop()
      audioRef.current?.pause()
    }
  }, [])

  function send(text: string) {
    const clean = text.trim()
    if (!clean || streaming) return
    setInput('')

    const userMsg: ChatMessage = { id: uid(), role: 'user', content: clean, ts: Date.now() }
    const asstId = uid()
    const asstMsg: ChatMessage = { id: asstId, role: 'assistant', content: '', ts: Date.now() }
    streamIdRef.current = asstId

    const history = messages.map((m) => ({ role: m.role, content: m.content }))
    setMessages([...messages, userMsg, asstMsg])
    setStreaming(true)

    const bookSummaries: Record<string, string> = {}
    for (const c of fanfic.chapters) {
      const v = persisted.summaries[`${fanfic.id}-${c.number}`]
      if (v) bookSummaries[String(c.number)] = v
    }
    const recentText = fanfic.chapters[readChapter - 1]?.text || ''
    const llm = chatMessages(
      char,
      fanfic,
      readChapter,
      bookSummaries,
      persisted.memories[ckey],
      history,
      clean,
      sceneContext,
      recentText
    )

    cancelRef.current = window.narra.chat(llm, {
      onChunk: (delta) => {
        setMessages((prev) => prev.map((m) => (m.id === asstId ? { ...m, content: m.content + delta } : m)))
      },
      onDone: (fullText) => {
        setStreaming(false)
        cancelRef.current = null
        setMessages((prev) => {
          const finalMsgs = prev.map((m) => (m.id === asstId ? { ...m, content: fullText || m.content } : m))
          setChats(id, finalMsgs)
          maybeUpdateMemory(finalMsgs)
          return finalMsgs
        })
        recordAsk(id, clean.slice(0, 80), readChapter)
        classifyReplyEmotion(fullText)
      },
      onError: (error, code) => {
        setStreaming(false)
        cancelRef.current = null
        setMessages((prev) => {
          const cleaned = prev.filter((m) => !(m.id === asstId && !m.content))
          setChats(id, cleaned)
          return cleaned
        })
        toast({
          type: 'error',
          title: code === 'NO_PROXY' ? 'Нет связи с сервером' : 'Ошибка ответа',
          message: error,
          onRetry: () => send(clean)
        })
      }
    })
  }

  function stop() {
    cancelRef.current?.()
    cancelRef.current = null
    setStreaming(false)
    // onDone после отмены не придёт — персистим вопрос и частичный ответ сами
    setMessages((prev) => {
      const cleaned = prev.filter((m) => !(m.role === 'assistant' && !m.content))
      setChats(id, cleaned)
      return cleaned
    })
  }

  // Эмоция последней реплики → анимация портрета.
  async function classifyReplyEmotion(text: string) {
    if (!gcReady || !text.trim()) return
    const er = await window.narra.llmText(emotionRequest(text), 0)
    const w = (er.ok ? er.data!.text : '').trim().toLowerCase()
    const found = EMOTIONS.find((e) => w.includes(e))
    setEmotion(found || 'neutral')
  }

  // Раз в несколько реплик обновляем память персонажа о собеседнике.
  const memoryBusy = useRef(false)
  async function maybeUpdateMemory(all: ChatMessage[]) {
    if (!gcReady || memoryBusy.current) return
    const userCount = all.filter((m) => m.role === 'user').length
    if (userCount < 2 || userCount % 3 !== 0) return
    memoryBusy.current = true
    const recent = all.slice(-12).map((m) => ({ role: m.role, content: m.content }))
    const res = await window.narra.llmText(
      memoryUpdateRequest(char.name, recent, persisted.memories[ckey] || ''),
      0.3
    )
    memoryBusy.current = false
    if (res.ok && res.data!.text.trim()) setMemory(id, res.data!.text.trim())
  }

  async function toggleSpeak(m: ChatMessage) {
    if (speakTargetRef.current === m.id) {
      speechRef.current?.stop()
      audioRef.current?.pause()
      speakTargetRef.current = null
      setSpeakingId(null)
      return
    }
    speechRef.current?.stop()
    audioRef.current?.pause()
    speakTargetRef.current = m.id
    setSpeakingId(m.id)

    if (ttsReady) {
      // определяем эмоцию реплики, чтобы озвучить с нужной интонацией
      let emotion: Emotion = 'neutral'
      if (gcReady) {
        const er = await window.narra.llmText(emotionRequest(m.content), 0)
        const w = (er.ok ? er.data!.text : '').trim().toLowerCase()
        const found = EMOTIONS.find((e) => w.includes(e))
        if (found) emotion = found
      }
      if (speakTargetRef.current !== m.id) return // пользователь отменил, пока думали
      const voice = voiceFor(id)
      const res = await window.narra.synthesize(
        { ssml: buildSsml(m.content, emotion, voice), voice },
        `chatmsg-${m.id}-${emotion}${hasForeignLanguage(m.content) ? '-ml1' : ''}`
      )
      if (speakTargetRef.current !== m.id) return
      if (res.ok) {
        const a = new Audio(res.data!.dataUrl)
        audioRef.current = a
        a.onended = () => {
          speakTargetRef.current = null
          setSpeakingId(null)
        }
        a.play().catch(() => {
          speakTargetRef.current = null
          setSpeakingId(null)
        })
        return
      } else {
        toast({ type: 'error', title: 'Озвучка не удалась', message: res.error })
      }
    }
    // fallback (нет TTS)
    speechRef.current = speakOnce(m.content, () => {
      speakTargetRef.current = null
      setSpeakingId(null)
    })
  }

  async function toggleMic() {
    if (micState === 'stt') return
    if (micState === 'rec') {
      setMicState('stt')
      try {
        const rec = await recRef.current!.stop()
        recRef.current = null
        if (rec.seconds < 0.6) {
          setMicState('idle')
          return
        }
        const r = await window.narra.recognize(rec.base64, rec.mime)
        setMicState('idle')
        if (r.ok && r.data!.text.trim()) send(r.data!.text.trim())
        else if (!r.ok) toast({ type: 'error', title: 'Не расслышал', message: r.error })
        else toast({ type: 'info', title: 'Не расслышал', message: 'Попробуй ещё раз, ближе к микрофону.' })
      } catch (e) {
        setMicState('idle')
        toast({ type: 'error', title: 'Микрофон', message: String(e) })
      }
      return
    }
    try {
      recRef.current = new VoiceRecorder()
      await recRef.current.start()
      setMicState('rec')
    } catch {
      toast({ type: 'error', title: 'Нет доступа к микрофону', message: 'Разреши доступ в настройках macOS.' })
    }
  }

  const locked = (char.unlockChapter || 1) > readChapter
  if (locked) {
    return (
      <div className="chat">
        <header className="chat__head">
          <button className="reader__back" onClick={() => navigate({ name: 'library' })}>
            ‹ Библиотека
          </button>
          <div className="chat__who">
            <strong>{char.name}</strong>
          </div>
          <div style={{ width: 90 }} />
        </header>
        <div style={{ padding: '24px 28px' }}>
          <Locker text={`Герой откроется на главе ${char.unlockChapter}. Продолжай читать — и поговорите.`} />
        </div>
      </div>
    )
  }

  return (
    <div className="chat">
      <header className="chat__head">
        <button className="reader__back" onClick={() => navigate({ name: 'character', id })}>
          ‹
        </button>
        <div className="chat__who" onClick={() => navigate({ name: 'character', id })} title={char.role}>
          <CharAvatar cacheKey={portraitKey(fanfic.id, id)} name={char.name} size={38} />
          <div className="chat__who-text">
            <strong>{char.fullName}</strong>
            <div className="chat__role">{char.role}</div>
          </div>
        </div>
        <button
          className="chat__clear"
          title="Очистить переписку"
          disabled={messages.length === 0}
          onClick={() => {
            if (!window.confirm(`Удалить переписку с ${char.name}?\n\nОн забудет и разговор, и всё, что узнал о тебе.`)) return
            clearChat(id)
            setMessages([])
            speechRef.current?.stop()
            audioRef.current?.pause()
            toast({ type: 'success', title: 'Переписка удалена' })
          }}
        >
          🗑
        </button>
      </header>

      <div className="chat__banner">
        <span className="dot-online" />
        Персонаж знает события до главы {readChapter} — спойлеров не будет
        {sceneContext && <span className="chat__scene-tag"> · обсуждаем сцену</span>}
      </div>

      <div className="chat__stage">
        <div className="chat__stage-portrait">
          {avatarVideo ? (
            <video
              className="stage-video"
              src={avatarVideo}
              autoPlay
              playsInline
              onEnded={() => setAvatarVideo(null)}
            />
          ) : avatarBusy ? (
            <div className="stage-loading">
              <span className="spark">🎬</span>
              <span>Оживаю…<br />2–4 мин</span>
            </div>
          ) : (
            <LivingPortrait
              cacheKey={portraitKey(fanfic.id, id)}
              prompt={portraitPrompt(char)}
              speaking={streaming || !!speakingId}
              emotion={emotion}
              rounded={16}
              lockedHint="Портрет появится при подключении"
            />
          )}
        </div>
        <div className="chat__stage-info">
          {(streaming || speakingId || avatarBusy) && (
            <div className="chat__stage-mood">
              {avatarBusy ? 'готовит видео…' : streaming ? 'печатает…' : 'говорит…'}
            </div>
          )}
        </div>
      </div>

      {!gcReady ? (
        <div style={{ padding: '20px 28px' }}>
          <Locker text="Чтобы поговорить с героем вживую, подключи сервер (GigaChat)." />
          <div className="chat__preview-hint">
            Персонаж: <em>{char.speechExamples[0]}</em>
          </div>
        </div>
      ) : (
        <>
          <div className="chat__messages" ref={listRef}>
            {messages.length === 0 && (
              <div className="chat__empty">
                <span className="chat__avatar chat__avatar--lg">{char.name[0]}</span>
                <h3>{char.fullName}</h3>
                <p>{char.speechStyle}</p>
                <div className="chat__starters">
                  <button className="chip chip--accent" onClick={() => send('Расскажи о себе.')}>
                    Расскажи о себе
                  </button>
                  {sceneContext && (
                    <button
                      className="chip chip--accent"
                      onClick={() => send('Перескажи эту сцену своими словами — как её видел ты?')}
                    >
                      {char.gender === 'female' ? 'Её версия этой сцены' : 'Его версия этой сцены'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {messages.map((m, i) => {
              const isA = m.role === 'assistant'
              const next = messages[i + 1]
              const lastOfGroup = !next || next.role !== m.role
              return (
                <div
                  key={m.id}
                  className={`msg msg--${m.role} ${lastOfGroup ? 'msg--tail' : ''}`}
                >
                  {isA && (
                    <div className="msg__avatar-slot">
                      {lastOfGroup && <CharAvatar cacheKey={portraitKey(fanfic.id, id)} name={char.name} size={34} />}
                    </div>
                  )}
                  <div className="msg__col">
                    <div className="msg__bubble">
                      {m.content || (streaming && m.id === streamIdRef.current ? <TypingDots /> : '')}
                      {isA && m.content && (
                        <button
                          className={`msg__speak ${speakingId === m.id ? 'is-active' : ''}`}
                          onClick={() => toggleSpeak(m)}
                          title="Озвучить"
                        >
                          {speakingId === m.id ? '⏸' : '🔊'}
                        </button>
                      )}

                    </div>
                    {lastOfGroup && <div className="msg__time">{fmtTime(m.ts)}</div>}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="chat__suggestions">
            <button className="chip" disabled={streaming} onClick={() => send('Расскажи о себе.')}>
              Расскажи о себе
            </button>
            <button
              className="chip"
              disabled={streaming}
              onClick={() =>
                send(
                  sceneContext
                    ? 'Перескажи эту сцену своими словами — как её видел ты?'
                    : 'Расскажи, что сейчас происходит в твоей жизни, своими словами.'
                )
              }
            >
              {char.gender === 'female' ? 'Её версия этой сцены' : 'Его версия этой сцены'}
            </button>
          </div>

          <div className="chat__input">
            <textarea
              value={input}
              placeholder="Сообщение…"
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send(input)
                }
              }}
            />
            {ttsReady && (
              <button
                className={`mic-btn ${micState === 'rec' ? 'is-rec' : ''}`}
                title={micState === 'rec' ? 'Остановить и отправить' : 'Сказать голосом'}
                disabled={streaming || micState === 'stt'}
                onClick={toggleMic}
              >
                {micState === 'stt' ? '…' : micState === 'rec' ? '■' : '🎙'}
              </button>
            )}
            {streaming ? (
              <button className="btn btn--ghost" onClick={stop}>
                ⏹ Стоп
              </button>
            ) : (
              <button className="btn btn--primary" disabled={!input.trim()} onClick={() => send(input)}>
                Отправить
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function TypingDots() {
  return (
    <span className="typing">
      <span />
      <span />
      <span />
    </span>
  )
}
