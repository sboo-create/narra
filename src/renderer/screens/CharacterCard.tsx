import { useEffect, useState } from 'react'
import { canImage } from '../store/useStore'
import { useStore, canTts } from '../store/useStore'
import { LivingPortrait } from '../components/LivingPortrait'
import { portraitKey } from '../lib/imageStyle'
import { ensureIdleAnimation, frameKey, framePhases, isIdleInFlight } from '../lib/idleManager'
import { portraitPrompt } from '../lib/passport'
import { buildSsml } from '../lib/ttsEmotion'

interface Props {
  id: string
}

export function CharacterCard({ id }: Props) {
  const fanfic = useStore((s) => s.fanfic)!
  const characters = useStore((s) => s.characters)
  const persisted = useStore((s) => s.persisted)
  const health = useStore((s) => s.health)
  const navigate = useStore((s) => s.navigate)
  const voiceFor = useStore((s) => s.voiceFor)
  const toast = useStore((s) => s.toast)

  const char = characters.find((c) => c.id === id)!
  const total = fanfic.chapters.length
  const readChapter = useStore((s) => s.chapter)
  const dossier = Math.round((readChapter / total) * 100)
  const ttsReady = canTts(health)
  const imgReady = canImage(health)

  const [sampling, setSampling] = useState(false)
  const [reviving, setReviving] = useState(false)
  const [redrawing, setRedrawing] = useState(false)
  const [portraitBump, setPortraitBump] = useState(0)
  // кадры оживления: портрет живёт за счёт мягкого перехода между выражениями
  const [frames, setFrames] = useState<string[]>([])

  useEffect(() => {
    setFrames([])
    setReviving(false)
    let alive = true
    async function check() {
      const got = await Promise.all(
        framePhases(char).map((p) => window.narra.getCachedImage(frameKey(fanfic.id, id, p.key)))
      )
      if (!alive) return false
      const urls = got.filter((r) => r.ok).map((r) => r.data!.dataUrl)
      if (urls.length === framePhases(char).length) {
        setFrames(urls)
        setReviving(false)
        return true
      }
      setReviving(isIdleInFlight(id))
      return false
    }
    ;(async () => {
      const done = await check()
      if (done || !imgReady) return
      // фоновое оживление — живёт вне компонента, выход из карточки его не убивает
      ensureIdleAnimation(fanfic.id, char, true)
      setReviving(isIdleInFlight(id))
      const iv = setInterval(async () => {
        if (!alive) {
          clearInterval(iv)
          return
        }
        if (await check()) clearInterval(iv)
      }, 12000)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, imgReady])

  function revive() {
    ensureIdleAnimation(fanfic.id, char)
    setReviving(true)
    toast({ type: 'info', title: 'Оживает в фоне', message: 'Можно уйти с карточки — герой оживёт сам (~1 мин).' })
  }

  // Перерисовать портрет из паспорта (сбрасывает анимацию).
  async function redraw() {
    if (redrawing) return
    setRedrawing(true)
    const res = await window.narra.generateImage(portraitPrompt(char), portraitKey(fanfic.id, id), 1024, 1024, true, 'kandinsky')
    setRedrawing(false)
    if (res.ok) {
      // кадры оживления рисовались от старого портрета — сбрасываем
      for (const p of framePhases(char)) await window.narra.deleteCachedImage(frameKey(fanfic.id, id, p.key))
      setFrames([])
      setPortraitBump((x) => x + 1)
      toast({ type: 'success', title: 'Портрет перерисован' })
    } else {
      toast({ type: 'error', title: 'Не удалось', message: res.error, onRetry: redraw })
    }
  }


  async function playSample() {
    if (!ttsReady) {
      toast({ type: 'info', title: 'Озвучка выключена', message: 'Подключи SaluteSpeech на сервере.' })
      return
    }
    setSampling(true)
    const res = await window.narra.synthesize(
      { ssml: buildSsml(char.speechExamples[0] || 'Здравствуй.', 'neutral'), voice: voiceFor(id) },
      `voicesample-${id}`
    )
    setSampling(false)
    if (res.ok) new Audio(res.data!.dataUrl).play().catch(() => {})
    else toast({ type: 'error', title: 'Не удалось озвучить', message: res.error })
  }

  function askVersion(chapterNo: number) {
    const ch = fanfic.chapters[chapterNo - 1]
    const ask = `Расскажи от первого лица свою версию событий главы ${chapterNo} («${ch.title}»): что ты ${
      char.gender === 'female' ? 'делала и чувствовала' : 'делал и чувствовал'
    }, что осталось за кадром. Подробно, в своём характере.`
    navigate({ name: 'chat', id, autoAsk: ask })
  }

  const locked = (char.unlockChapter || 1) > readChapter
  if (locked) {
    return (
      <div className="page cardv2">
        <button className="reader__back" onClick={() => navigate({ name: 'library' })}>
          ‹ Библиотека
        </button>
        <div className="char-teaser card">
          <div className="char-teaser__mark">?</div>
          <div>
            <h1 className="char-teaser__name">{char.name}</h1>
            <p className="char-teaser__hint">
              Появится в главе {char.unlockChapter}. Дочитай — и герой откроется: портрет, характер
              и живой разговор.
            </p>
            <button className="btn btn--primary" onClick={() => navigate({ name: 'reader' })}>
              Продолжить чтение
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page cardv2">
      <button className="reader__back" onClick={() => navigate({ name: 'library' })}>
        ‹ Библиотека
      </button>

      <div className="cardv2__panel">
        <div className="cardv2__portrait">
          {frames.length ? (
            // «живой» портрет: базовый кадр + плавные переходы к другим выражениям
            <div className="alive-portrait">
              <LivingPortrait
                key={portraitBump}
                cacheKey={portraitKey(fanfic.id, id)}
                prompt={portraitPrompt(char)}
                width={1024}
                height={1024}
                rounded={16}
                lockedHint="Портрет появится при подключении"
              />
              {frames.map((src, i) => (
                <img key={i} src={src} className={`alive-portrait__frame alive-portrait__frame--${i + 1}`} alt="" />
              ))}
            </div>
          ) : (
            <LivingPortrait
              key={portraitBump}
              cacheKey={portraitKey(fanfic.id, id)}
              prompt={portraitPrompt(char)}
              width={1024}
              height={1024}
              rounded={16}
              lockedHint="Портрет появится при подключении"
            />
          )}
        </div>
        {imgReady && (
          <div className="portrait-actions">
            {!frames.length && (
              <button className="portrait-anim-btn" disabled={reviving} onClick={revive}>
                {reviving ? 'оживает в фоне… (~1 мин)' : '✦ Оживить героя'}
              </button>
            )}
            <button
              className="portrait-anim-btn portrait-anim-btn--sm"
              disabled={redrawing}
              onClick={redraw}
              title="Перерисовать портрет"
            >
              {redrawing ? '…' : '↻'}
            </button>
          </div>
        )}
      </div>

      <div className="cardv2__status">
        <span className="dot-online" /> онлайн
      </div>
      <h1 className="cardv2__name">{char.fullName}</h1>
      <p className="cardv2__role">{char.role}</p>

      <div className="cardv2__traits">
        {char.traits.map((t) => (
          <span key={t} className="chip">{t}</span>
        ))}
      </div>

      <div className="cardv2__block">
        <span className="label">Манера речи</span>
        <p>{char.speechStyle}</p>
      </div>

      <div className="cardv2__actions">
        <button className="btn btn--primary" onClick={() => navigate({ name: 'chat', id })}>
          Поговорить
        </button>
        {ttsReady && (
          <button className="btn btn--ghost" disabled={sampling} onClick={playSample}>
            {sampling ? 'звучит…' : 'Послушать голос'}
          </button>
        )}
      </div>

      <div className="card cardv2__dossier">
        <div className="cardv2__dossier-head">
          <span className="label" style={{ margin: 0 }}>Досье раскрыто</span>
          <span className="cardv2__pct">{dossier}%</span>
        </div>
        <div className="progress">
          <div className="progress__fill" style={{ width: `${dossier}%` }} />
        </div>
        <p className="cardv2__dossier-sub">
          Открыто {readChapter} из {total} глав — читай дальше, герой расскажет больше.
        </p>
      </div>

      <div className="cardv2__timeline-head">
        {char.gender === 'female' ? 'Её версия событий' : 'Его версия событий'}
      </div>

      <div className="timeline">
        {fanfic.chapters.map((ch) => {
          const unlocked = ch.number <= readChapter
          return (
            <div key={ch.number} className={`tl-item ${unlocked ? '' : 'tl-item--locked'}`}>
              <div className="tl-node">
                <span className={`tl-dot ${unlocked ? 'tl-dot--on' : ''}`} />
                {ch.number < total && <span className="tl-line" />}
              </div>
              <div className="tl-body">
                <div className="tl-title">Глава {ch.number} · {ch.title}</div>
                {unlocked ? (
                  <button className="btn btn--ghost btn--sm" onClick={() => askVersion(ch.number)}>
                    Обсудить в чате
                  </button>
                ) : (
                  <div className="tl-locked">🔒 Откроется на главе {ch.number}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
