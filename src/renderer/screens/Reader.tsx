import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, canTts, canChat } from '../store/useStore'
import { renderRich, linkifyPlain } from '../lib/rich'
import { SceneImage } from '../components/SceneImage'
import { CharAvatar } from '../components/CharAvatar'
import { portraitKey } from '../lib/imageStyle'
import { markupChapter, fallbackScenario } from '../lib/scenario'
import { visualMomentsRequest, summaryRequest } from '../lib/prompts'
import { parseBlocks, proseOnly } from '../lib/blocks'
import { sceneKey } from '../lib/imageStyle'
import { TtsController, TtsStatus } from '../lib/ttsController'
import type { ChapterScenario } from '@shared/types'

interface NamePopover {
  charId: string
  x: number
  y: number
}

function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// Находит абзац, наиболее совпадающий с цитатой (по общим словам).
function bestParagraph(quote: string, paragraphs: string[]): number {
  const words = quote
    .toLowerCase()
    .replace(/[^а-яёa-z\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
  if (!words.length) return Math.floor(paragraphs.length * 0.5)
  let best = -1
  let bestScore = 0
  paragraphs.forEach((p, i) => {
    const lp = p.toLowerCase()
    let score = 0
    for (const w of words) if (lp.includes(w)) score++
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  })
  return best >= 0 ? best : Math.floor(paragraphs.length * 0.5)
}

// максимум 4 точки сцен, соседние не ближе 12% главы
function spreadCap(list: number[], n: number): number[] {
  const sorted = [...new Set(list)].filter((x) => x >= 0 && x < n).sort((a, b) => a - b)
  const minGap = Math.max(2, Math.floor(n * 0.12))
  const out: number[] = []
  for (const idx of sorted) {
    if (out.length === 0 || idx - out[out.length - 1] >= minGap) out.push(idx)
    if (out.length >= 4) break
  }
  // мало точек (например, всё скучено сверху) — дополняем по глубине главы
  if (out.length < 3) {
    for (const f of [0.35, 0.6, 0.85]) {
      const idx = Math.floor(n * f)
      if (out.every((x) => Math.abs(idx - x) >= minGap)) out.push(idx)
      if (out.length >= 4) break
    }
    out.sort((a, b) => a - b)
  }
  return out
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]

export function Reader() {
  const fanfic = useStore((s) => s.fanfic)!
  const characters = useStore((s) => s.characters)
  const health = useStore((s) => s.health)
  const persisted = useStore((s) => s.persisted)
  const setSummary = useStore((s) => s.setSummary)
  const [chapSummary, setChapSummary] = useState<string | null>(null)
  const [summaryBusy, setSummaryBusy] = useState(false)
  const setChapter = useStore((s) => s.setChapter)
  const setScenario = useStore((s) => s.setScenario)
  const setAnchorList = useStore((s) => s.setAnchorList)
  const addExtraScene = useStore((s) => s.addExtraScene)
  const voiceFor = useStore((s) => s.voiceFor)
  const navigate = useStore((s) => s.navigate)
  const toast = useStore((s) => s.toast)

  const chapterNo = useStore((s) => s.chapter)
  const chapter = fanfic.chapters[chapterNo - 1]
  const total = fanfic.chapters.length
  const bkey = `${fanfic.id}-${chapterNo}`

  const [popover, setPopover] = useState<NamePopover | null>(null)
  const [audioStatus, setAudioStatus] = useState<TtsStatus>('idle')
  const [curSeg, setCurSeg] = useState(-1)
  const [speed, setSpeed] = useState(1)
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null)
  const [scenario, setScenarioState] = useState<ChapterScenario | null>(null)

  const ctrlRef = useRef<TtsController | null>(null)
  const listenGenRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const ttsReady = canTts(health)
  const gcReady = canChat(health)

  const blocks = useMemo(() => parseBlocks(chapter?.text || ''), [chapter])
  const paragraphs = useMemo(
    () => blocks.map((b) => (b.type === 'p' ? b.text : '')),
    [blocks]
  )

  // Точки сцен: 4–7 визуально сильных моментов (GigaChat находит, кэшируем).
  const [anchors, setAnchors] = useState<number[]>([])
  const [selBtn, setSelBtn] = useState<{ x: number; y: number; idx: number; text: string } | null>(null)

  function onProseMouseUp() {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) {
      setSelBtn(null)
      return
    }
    const text = sel.toString().trim()
    if (text.length < 15) {
      setSelBtn(null)
      return
    }
    const node = sel.anchorNode
    const el = (node instanceof Element ? node : node?.parentElement)?.closest('[data-pi]')
    if (!el) {
      setSelBtn(null)
      return
    }
    const idx = Number(el.getAttribute('data-pi'))
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setSelBtn({ x: rect.left + rect.width / 2, y: Math.max(70, rect.top - 14), idx, text })
  }

  useEffect(() => {
    const n = blocks.length
    if (n < 5) {
      setAnchors([])
      return
    }
    const cached = persisted.anchorLists[bkey]
    if (cached && cached.length > 0) {
      setAnchors(spreadCap(cached, n))
      return
    }
    if (!canChat(health)) {
      // без LLM — равномерно 4 точки
      const fallback = [0.25, 0.5, 0.75].map((f) => Math.floor(n * f))
      setAnchors(fallback)
      return
    }
    // мгновенные точки, пока LLM думает — потом заменим точными
    setAnchors(spreadCap([0.25, 0.5, 0.75].map((f) => Math.floor(n * f)), n))
    let alive = true
    ;(async () => {
      const r = await window.narra.llmJson<string[]>(visualMomentsRequest(proseOnly(chapter.text)))
      if (!alive) return
      let list: number[] = []
      if (r.ok && Array.isArray(r.data)) {
        list = r.data
          .filter((q) => typeof q === 'string' && q.trim())
          .map((q) => bestParagraph(q, paragraphs))
          .filter((x) => x >= 0)
      }
      if (list.length < 3) {
        const extra = [0.3, 0.55, 0.8].map((f) => Math.floor(n * f))
        list = [...list, ...extra]
      }
      list = spreadCap(list, n)
      setAnchors(list)
      setAnchorList(bkey, list)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterNo, blocks])

  // сброс при смене главы
  useEffect(() => {
    listenGenRef.current++
    ctrlRef.current?.stop()
    ctrlRef.current = null
    setAudioStatus('idle')
    setCurSeg(-1)
    setChapSummary(null)
    setSummaryBusy(false)
    setPreparing(null)
    setScenarioState(null)
    setPopover(null)
    setSelBtn(null)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [chapterNo])

  useEffect(
    () => () => {
      listenGenRef.current++ // отменяет подготовку, которая ещё в полёте
      ctrlRef.current?.stop()
    },
    []
  )

  // автоскролл к текущему сегменту
  useEffect(() => {
    if (curSeg < 0) return
    const el = document.querySelector(`[data-seg="${curSeg}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [curSeg])

  if (!chapter) return <div className="page">Глава не найдена.</div>

  const progress = Math.round((chapterNo / total) * 100)
  const audioActive = audioStatus !== 'idle' || !!scenario

  function goPrev() {
    if (chapterNo > 1) setChapter(chapterNo - 1)
  }
  function goNext() {
    if (chapterNo < total) setChapter(chapterNo + 1)
  }

  async function ensureScenario(): Promise<ChapterScenario> {
    const cached = persisted.scenarios[bkey]
    if (cached) return cached
    // офлайн-режим (без GigaChat) — простой сценарий без разметки
    if (!gcReady) {
      const fb = fallbackScenario(chapterNo, proseOnly(chapter.text))
      setScenario(bkey, fb)
      return fb
    }
    setPreparing({ done: 0, total: 1 })
    const sc = await markupChapter(chapterNo, proseOnly(chapter.text), characters, (done, tot) =>
      setPreparing({ done, total: tot })
    )
    setPreparing(null)
    setScenario(bkey, sc)
    return sc
  }

  function buildController(sc: ChapterScenario): TtsController {
    return new TtsController({
      mode: ttsReady ? 'salute' : 'browser',
      segments: sc.segments,
      voiceFor,
      cacheKeyFor: (idx) => `tts-${fanfic.id}-c${chapterNo}-${idx}-${hash(sc.segments[idx].text)}`,
      onIndex: setCurSeg,
      onStatus: setAudioStatus,
      onError: (m) => toast({ type: 'error', title: 'Озвучка', message: m })
    })
  }

  async function onListen() {
    // во время подготовки повторное нажатие = отмена (никаких вторых дорожек)
    if (preparing) {
      listenGenRef.current++
      setPreparing(null)
      return
    }
    if (audioStatus === 'playing') {
      ctrlRef.current?.pause()
      return
    }
    if (audioStatus === 'paused') {
      ctrlRef.current?.resume()
      return
    }
    // старт: глушим всё предыдущее и стартуем ровно один контроллер
    const myGen = ++listenGenRef.current
    ctrlRef.current?.stop()
    ctrlRef.current = null
    const sc = await ensureScenario()
    if (myGen !== listenGenRef.current) return // отменили или перезапустили, пока готовили
    setScenarioState(sc)
    const ctrl = buildController(sc)
    ctrl.setSpeed(speed)
    ctrlRef.current = ctrl
    ctrl.start(0)
  }

  function stopAudio() {
    ctrlRef.current?.stop()
    ctrlRef.current = null
    setAudioStatus('idle')
    setCurSeg(-1)
    setScenarioState(null)
  }

  function changeSpeed(s: number) {
    setSpeed(s)
    ctrlRef.current?.setSpeed(s)
  }

  function onNameClick(charId: string, rect: DOMRect) {
    const W = 270
    const H = 220
    const x = Math.max(12, Math.min(rect.left, window.innerWidth - W - 12))
    const y =
      rect.bottom + 6 + H > window.innerHeight ? Math.max(12, rect.top - H - 6) : rect.bottom + 6
    setPopover({ charId, x, y })
  }

  const popChar = popover ? characters.find((c) => c.id === popover.charId) : null
  const listenLabel = preparing
    ? '⏹ Отменить'
    : audioStatus === 'playing'
      ? '⏸ Пауза'
      : audioStatus === 'paused'
        ? '▶ Продолжить'
        : '🎧 Слушать'

  return (
    <div className="reader" ref={scrollRef}>
      <div className="reader__bar">
        <button className="reader__back" onClick={() => navigate({ name: 'book' })}>
          ‹ К книге
        </button>
        <div className="reader__bar-title">{fanfic.title}</div>
        <button
          className={`reader__voice ${audioStatus !== 'idle' || preparing ? 'is-playing' : ''}`}
          onClick={onListen}
        >
          {listenLabel}
        </button>
      </div>
      <div className="reader__progress">
        <div className="reader__progress-fill" style={{ width: `${progress}%` }} />
      </div>

      <article className="reader__page">
        <div className="reader__chapter-meta">Глава {chapterNo} из {total}</div>
        <h1 className="reader__title">{chapter.title}</h1>

        {preparing && (
          <div className="prepare-note">
            GigaChat размечает главу на реплики и эмоции… {preparing.done}/{preparing.total}
          </div>
        )}

        <div className="reader__prose" onMouseUp={onProseMouseUp}>
          {audioActive && scenario ? (
            // режим озвучки: рендер по сегментам с подсветкой
            scenario.segments.map((seg, i) => (
              <p
                key={i}
                data-seg={i}
                className={`prose-p seg ${i === 0 ? 'prose-p--first' : ''} ${
                  seg.type === 'speech' ? 'seg--speech' : ''
                } ${curSeg === i ? 'prose-p--speaking' : ''}`}
              >
                {renderRich(seg.text, characters, onNameClick)}
              </p>
            ))
          ) : (
            // обычное чтение: блоки (текст / примечания) + точки сцен
            blocks.map((b, i) => (
              <div key={i}>
                {b.type === 'note' ? (
                  <aside className="author-note">
                    <div className="author-note__title">{b.title}</div>
                    <div className="author-note__body">{linkifyPlain(b.text)}</div>
                  </aside>
                ) : (
                  <p data-pi={i} className={`prose-p ${i === 0 ? 'prose-p--first' : ''}`}>
                    {renderRich(b.text, characters, onNameClick)}
                  </p>
                )}
                {b.type === 'p' &&
                  (anchors.includes(i) || (persisted.extraScenes[bkey] || []).includes(i)) && (
                    <SceneImage
                      cacheKey={`${sceneKey(fanfic.id, chapterNo)}-p${i}`}
                      chapterText={paragraphs.slice(Math.max(0, i - 1), i + 2).join('\n\n')}
                      chapterTitle={chapter.title}
                      chapterSummary={b.text.slice(0, 160)}
                      characters={characters}
                      autoGenerate={(persisted.extraScenes[bkey] || []).includes(i)}
                    />
                  )}
              </div>
            ))
          )}
        </div>

        <div className="chapter-end">
          <div className="chapter-end__title">Итоги главы</div>
          {chapSummary ? (
            <div className="chapter-summary">{chapSummary}</div>
          ) : (
            <button
              className="chip reader__ask-chip"
              disabled={summaryBusy}
              onClick={async () => {
                if (persisted.summaries[bkey]) {
                  setChapSummary(persisted.summaries[bkey])
                  return
                }
                setSummaryBusy(true)
                const r = await window.narra.llmText(summaryRequest(proseOnly(chapter.text), chapter.title), 0.4)
                setSummaryBusy(false)
                if (r.ok && r.data!.text.trim()) {
                  const t = r.data!.text.trim()
                  setSummary(bkey, t)
                  setChapSummary(t)
                }
              }}
            >
              {summaryBusy ? '✦ Вспоминаю…' : '✦ Саммари главы'}
            </button>
          )}

          <div className="chapter-end__title">Обсудить главу</div>
          <div className="chapter-end__chips">
            {characters.filter((c) => (c.unlockChapter || 1) <= chapterNo).map((c) => (
              <button
                key={c.id}
                className="chip chip--accent reader__ask-chip"
                onClick={() =>
                  navigate({
                    name: 'chat',
                    id: c.id,
                    sceneContext: `${chapter.title}: ${persisted.summaries[bkey] || ''}`
                  })
                }
              >
                {c.name}
              </button>
            ))}
          </div>
          {characters.some((c) => (c.unlockChapter || 1) <= chapterNo) && (
            <div className="chapter-end__suggests">
              {[
                `Что ты чувствуешь после событий главы ${chapterNo}?`,
                'Что в этой главе осталось за кадром?'
              ].map((q) => {
                const first = characters.find((c) => (c.unlockChapter || 1) <= chapterNo)!
                return (
                  <button
                    key={q}
                    className="suggest-btn"
                    onClick={() => navigate({ name: 'chat', id: first.id, autoAsk: q })}
                  >
                    {q}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {selBtn && (
          <div className="sel-menu" style={{ left: selBtn.x, top: selBtn.y }}>
            <button
              onClick={() => {
                addExtraScene(bkey, selBtn.idx)
                window.getSelection()?.removeAllRanges()
                setSelBtn(null)
              }}
            >
              Проиллюстрировать
            </button>
            <button
              onClick={() => {
                const first = characters.find((c) => (c.unlockChapter || 1) <= chapterNo)
                const frag = selBtn.text.slice(0, 400)
                window.getSelection()?.removeAllRanges()
                setSelBtn(null)
                if (first)
                  navigate({
                    name: 'chat',
                    id: first.id,
                    autoAsk: `Обсудим фрагмент: «${frag}» — что ты об этом думаешь?`
                  })
              }}
            >
              Спросить героя
            </button>
          </div>
        )}

        <div className="reader__nav">
          <button className="btn btn--ghost" disabled={chapterNo <= 1} onClick={goPrev}>
            ‹ Назад
          </button>
          <span className="reader__nav-label">{chapterNo} / {total}</span>
          <button className="btn btn--ghost" disabled={chapterNo >= total} onClick={goNext}>
            Вперёд ›
          </button>
        </div>
      </article>

      {/* Плеер озвучки */}
      {audioStatus !== 'idle' && scenario && (
        <div className="player">
          <button className="player__btn" onClick={onListen}>
            {audioStatus === 'playing' ? '⏸' : '▶'}
          </button>
          <button className="player__btn player__btn--sm" onClick={stopAudio} title="Стоп">
            ⏹
          </button>
          <div className="player__info">
            <div className="player__mode">
              {ttsReady ? '🎙 Эмоциональная озвучка' : '🔈 Демо-озвучка без эмоций'}
            </div>
            <div className="player__pos">
              Сегмент {Math.max(0, curSeg) + 1} / {scenario.segments.length}
            </div>
          </div>
          <div className="player__speeds">
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={`player__speed ${speed === s ? 'is-active' : ''}`}
                onClick={() => changeSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      )}

      {popover && popChar && (
        <>
          <div className="popover-backdrop" onClick={() => setPopover(null)} />
          <div className="popover" style={{ left: popover.x, top: popover.y }}>
            <div className="popover__char">
              <CharAvatar cacheKey={portraitKey(popChar.id)} name={popChar.name} size={44} />
              <div>
                <strong>{popChar.fullName}</strong>
                <div className="popover__role">{popChar.role}</div>
              </div>
            </div>
            <div className="popover__hint">Помнит эту сцену — можно спросить, спойлеров не будет</div>
            <button
              className="btn btn--primary btn--sm"
              style={{ width: '100%' }}
              onClick={() => {
                const ctx = `${chapter.title}: ${persisted.summaries[bkey] || ''}`
                setPopover(null)
                navigate({ name: 'chat', id: popChar.id, sceneContext: ctx })
              }}
            >
              Открыть чат
            </button>
            <button
              className="btn btn--ghost btn--sm"
              style={{ width: '100%', marginTop: 6 }}
              onClick={() => {
                setPopover(null)
                navigate({ name: 'character', id: popChar.id })
              }}
            >
              Открыть карточку
            </button>
          </div>
        </>
      )}
    </div>
  )
}
