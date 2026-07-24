import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { GeneratedImage } from '../components/GeneratedImage'
import { coverKey } from '../lib/imageStyle'
import { buildCharacters } from '../lib/importFlow'
import { coverPrompt } from '../lib/passport'
import { DEFAULT_NARRATOR_VOICE, type BookContent } from '@shared/types'
import { prepareChapterScenario } from '../lib/scenario'
import { proseOnly } from '../lib/blocks'

type SortKey = 'title' | 'progress'

function categoryOf(b: BookContent): string {
  if (b.fanfic.tags.some((t) => /мои книги/i.test(t))) return 'Мои книги'
  return b.fanfic.tags.some((t) => /классика/i.test(t)) ? 'Классика' : 'Фанфики'
}

const SHELF_TINT: Record<string, string> = {
  Фанфики: 'var(--glass-amber)',
  Классика: 'var(--glass-blue)',
  'Мои книги': 'rgba(217, 74, 43, 0.26)'
}

const CARD_W = 168
const CARD_GAP = 44
const backgroundBookPreparation = new Set<string>()

function durationBucket(startedAt: number): string {
  const elapsed = performance.now() - startedAt
  if (elapsed < 1_000) return '<1s'
  if (elapsed < 5_000) return '1-4s'
  if (elapsed < 15_000) return '5-14s'
  if (elapsed < 60_000) return '15-59s'
  if (elapsed < 300_000) return '1-4m'
  return '5m+'
}

function resultSizeBucket(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  if (bytes < 256 * 1024) return '<256kb'
  if (bytes < 1024 * 1024) return '256kb-1mb'
  if (bytes < 10 * 1024 * 1024) return '1-9mb'
  return '10mb+'
}

async function prepareImportedBook(
  meta: { id: string; title: string; author: string; excerpt: string },
  toast: ReturnType<typeof useStore.getState>['toast']
): Promise<void> {
  if (backgroundBookPreparation.has(meta.id)) return
  backgroundBookPreparation.add(meta.id)
  const analysisStartedAt = performance.now()
  void window.narra.trackEvent('book_analysis_started', {
    analysis_version: 'v1',
    origin: 'background'
  })
  try {
    const built = await buildCharacters(
      meta.title, meta.author, meta.excerpt, DEFAULT_NARRATOR_VOICE, 'background'
    )
    if (!built.ok) {
      void window.narra.trackEvent('book_analysis_failed', {
        analysis_version: 'v1',
        stage: 'character_markup',
        safe_error_code: 'PARSE',
        origin: 'background'
      })
      toast({
        type: 'error',
        title: 'Герои пока не разметились',
        message: 'Книга уже доступна. Подготовку можно повторить позднее.'
      })
      return
    }
    const saved = await window.narra.saveBookCharacters(
      meta.id,
      DEFAULT_NARRATOR_VOICE,
      built.characters
    )
    if (!saved.ok) {
      void window.narra.trackEvent('book_analysis_failed', {
        analysis_version: 'v1',
        stage: 'character_markup',
        safe_error_code: 'UNKNOWN',
        origin: 'background'
      })
      toast({ type: 'error', title: 'Герои не сохранились', message: saved.error })
      return
    }
    await useStore.getState().reloadBooks()
    void window.narra.trackEvent('book_analysis_completed', {
      analysis_version: 'v1',
      character_count_bucket: built.characters.length <= 3 ? '1-3' : built.characters.length <= 8 ? '4-8' : '9+',
      duration_bucket: durationBucket(analysisStartedAt),
      origin: 'background'
    })
    toast({ type: 'success', title: `Герои готовы: ${built.characters.map((c) => c.name).join(', ')}` })

    const book = useStore.getState().books.find((candidate) => candidate.fanfic.id === meta.id)
    const firstChapter = book?.fanfic.chapters[0]
    if (!book || !firstChapter || !proseOnly(firstChapter.text).trim()) return
    const key = `${meta.id}-1`
    if (useStore.getState().persisted.scenarios[key]) return
    const markupStartedAt = performance.now()
    void window.narra.trackEvent('media_job_enqueued', {
      job_type: 'chapter_markup',
      quality: 'standard',
      origin: 'background'
    })
    void window.narra.trackEvent('media_job_started', {
      job_type: 'chapter_markup',
      origin: 'background'
    })
    try {
      const preparation = prepareChapterScenario(
        key,
        1,
        proseOnly(firstChapter.text),
        built.characters,
        'background'
      )
      const scenario = await preparation.complete
      // A deletion while preparation was running must not resurrect state.
      if (!useStore.getState().books.some((candidate) => candidate.fanfic.id === meta.id)) return
      useStore.getState().setScenario(key, scenario)
      if (preparation.getFallbackCount() > 0) {
        void window.narra.trackEvent('media_job_failed', {
          job_type: 'chapter_markup',
          stage: 'provider',
          safe_error_code: 'UNKNOWN',
          retry_count_bucket: '0',
          origin: 'background'
        })
      } else {
        void window.narra.trackEvent('media_job_completed', {
          job_type: 'chapter_markup',
          job_latency_bucket: durationBucket(markupStartedAt),
          cache_hit: false,
          result_size_bucket: resultSizeBucket(scenario),
          origin: 'background'
        })
      }
      toast({ type: 'success', title: 'Первая глава готова к озвучке' })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      void window.narra.trackEvent('media_job_failed', {
        job_type: 'chapter_markup',
        stage: 'chapter_markup',
        safe_error_code: 'UNKNOWN',
        retry_count_bucket: '0',
        origin: 'background'
      })
      toast({
        type: 'error',
        title: 'Первая глава пока не подготовилась',
        message: 'Книга и герои уже готовы; разметка повторится при запуске озвучки.'
      })
    }
  } catch {
    void window.narra.trackEvent('book_analysis_failed', {
      analysis_version: 'v1',
      stage: 'character_markup',
      safe_error_code: 'UNKNOWN',
      origin: 'background'
    })
    toast({
      type: 'error',
      title: 'Фоновая подготовка не завершилась',
      message: 'Книга уже доступна. Подготовку можно повторить позднее.'
    })
  } finally {
    backgroundBookPreparation.delete(meta.id)
  }
}

/** Сколько книг помещается в ряд — чтобы под каждым рядом была своя полка. */
function useColumns(ref: React.RefObject<HTMLDivElement>): number {
  const [cols, setCols] = useState(4)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      setCols(Math.max(1, Math.floor((w + CARD_GAP) / (CARD_W + CARD_GAP))))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return cols
}

/** Полка с книгами: ряд карточек + стеклянная планка под ними. */
function Shelf({
  list,
  tint,
  children
}: {
  list: BookContent[]
  tint: string
  children: (b: BookContent) => React.ReactNode
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const cols = useColumns(wrapRef)
  const rows: BookContent[][] = []
  for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols))
  return (
    <div className="shelf__rows" ref={wrapRef}>
      {rows.map((row, i) => (
        <div className="shelf__row" key={i}>
          <div className="shelf__books">{row.map(children)}</div>
          <div className="shelf__glass" style={{ background: tint }}>
            <i className="shelf__screw" />
            <i className="shelf__screw shelf__screw--r" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function Library() {
  const books = useStore((s) => s.books)
  const persisted = useStore((s) => s.persisted)
  const setActiveBook = useStore((s) => s.setActiveBook)
  const navigate = useStore((s) => s.navigate)

  const reloadBooks = useStore((s) => s.reloadBooks)
  const toast = useStore((s) => s.toast)
  const [importing, setImporting] = useState(false)
  const [filter, setFilter] = useState<string>('Все')

  const [urlOpen, setUrlOpen] = useState(false)
  const [bookUrl, setBookUrl] = useState('')

  async function afterImport(meta: { id: string; title: string; author: string; chapters: number; excerpt: string }) {
    toast({
      type: 'success',
      title: `«${meta.title}» загружена`,
      message: `${meta.chapters} глав · книга уже доступна, героев и первую главу готовлю в фоне`
    })
    await reloadBooks()
    void prepareImportedBook(meta, toast)
  }

  const deleteBook = useStore((s) => s.deleteBook)

  function askDelete(id: string, title: string) {
    if (!window.confirm(`Убрать «${title}» из библиотеки?\n\nПрогресс чтения и заметки по этой книге будут удалены. Загруженные книги удаляются с диска, встроенные — можно вернуть переустановкой.`)) return
    deleteBook(id).then(() => toast({ type: 'success', title: `«${title}» убрана` }))
  }

  async function importOwnBook() {
    if (importing) return
    setImporting(true)
    const res = await window.narra.importBook()
    if (!res.ok) {
      setImporting(false)
      if (res.error !== 'Отменено') toast({ type: 'error', title: 'Импорт не удался', message: res.error })
      return
    }
    await afterImport(res.data!)
    setImporting(false)
  }

  async function importByUrl() {
    const url = bookUrl.trim()
    if (!url || importing) return
    setImporting(true)
    setUrlOpen(false)
    toast({ type: 'info', title: 'Качаю по ссылке…', message: 'Главы тянутся по одной — может занять пару минут.' })
    const res = await window.narra.importBookFromUrl(url)
    if (!res.ok) {
      setImporting(false)
      toast({ type: 'error', title: 'Импорт не удался', message: res.error })
      return
    }
    setBookUrl('')
    await afterImport(res.data!)
    setImporting(false)
  }
  const [sort, setSort] = useState<SortKey>('title')

  const categories = useMemo(() => {
    const set = new Set(books.map(categoryOf))
    return ['Все', ...set]
  }, [books])

  const progressOf = (b: BookContent) =>
    (persisted.chapters[b.fanfic.id] || 1) / b.fanfic.chapters.length

  const sorted = useMemo(() => {
    const arr = [...books]
    if (sort === 'title') arr.sort((a, b) => a.fanfic.title.localeCompare(b.fanfic.title, 'ru'))
    else arr.sort((a, b) => progressOf(b) - progressOf(a))
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books, sort, persisted.chapters])

  const shelves = useMemo(() => {
    const list = filter === 'Все' ? sorted : sorted.filter((b) => categoryOf(b) === filter)
    const groups = new Map<string, BookContent[]>()
    for (const b of list) {
      const c = categoryOf(b)
      if (!groups.has(c)) groups.set(c, [])
      groups.get(c)!.push(b)
    }
    return [...groups.entries()]
  }, [sorted, filter])


  if (!books.length) return null

  function open(id: string) {
    setActiveBook(id)
    navigate({ name: 'book' })
  }

  return (
    <div className="page">
      <div className="page__head">
        <div className="page__title">Библиотека</div>
      </div>


      {/* фильтры и сортировка */}
      <div className="toolbar">
        <div className="toolbar__chips">
          {categories.map((c) => (
            <button
              key={c}
              className={`chip ${filter === c ? 'chip--on' : ''}`}
              onClick={() => setFilter(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="toolbar__right">
          <button className="btn btn--ghost btn--sm" disabled={importing} onClick={importOwnBook}>
            {importing ? 'загружаю…' : '+ Своя книга'}
          </button>
          <button className="chip" disabled={importing} onClick={() => setUrlOpen((v) => !v)}>
            + По ссылке
          </button>
          {urlOpen && (
            <span className="url-import">
              <input
                autoFocus
                placeholder="Ссылка на AO3 или Фикбук"
                value={bookUrl}
                onChange={(e) => setBookUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && importByUrl()}
              />
              <button className="chip chip--accent" disabled={!bookUrl.trim() || importing} onClick={importByUrl}>
                Загрузить
              </button>
            </span>
          )}
        <div className="toolbar__sort">
          <button
            className={`sort-btn ${sort === 'title' ? 'is-active' : ''}`}
            onClick={() => setSort('title')}
          >
            По названию
          </button>
          <button
            className={`sort-btn ${sort === 'progress' ? 'is-active' : ''}`}
            onClick={() => setSort('progress')}
          >
            По прогрессу
          </button>
        </div>
        </div>
      </div>

      {shelves.map(([cat, list]) => (
        <section key={cat} className="shelf">
          <div className="shelf__head">
            <h2>{cat}</h2>
            <span>
              {list.length}{' '}
              {list.length === 1 ? 'книга' : list.length < 5 ? 'книги' : 'книг'}
            </span>
          </div>
          <Shelf list={list} tint={SHELF_TINT[cat] || 'var(--glass-amber)'}>
            {(b) => {
                const total = b.fanfic.chapters.length
                const ch = persisted.chapters[b.fanfic.id] || 1
                const started = (persisted.chapters[b.fanfic.id] || 0) > 0
                return (
                  <div key={b.fanfic.id} className="book-spine-wrap">
                  <button
                    className="book-spine__del"
                    title="Убрать книгу"
                    onClick={(e) => {
                      e.stopPropagation()
                      askDelete(b.fanfic.id, b.fanfic.title)
                    }}
                  >
                    ✕
                  </button>
                  <button className="book-spine" onClick={() => open(b.fanfic.id)}>
                    <div className="book-spine__cover">
                      <GeneratedImage
                        cacheKey={coverKey(b.fanfic.id)}
                        prompt={coverPrompt(b.fanfic.coverPrompt, b.characters.slice(0, 2))}
                        className="cover-img"
                        rounded={6}
                        lockedHint="обложка"
                      />
                    </div>
                    <div className="book-spine__meta">
                      <div className="book-spine__title">{b.fanfic.title}</div>
                      <div className="book-spine__author">{b.fanfic.author}</div>
                      <div className="book-spine__row">
                        <div className="progress book-spine__progress">
                          <div
                            className="progress__fill"
                            style={{ width: `${Math.round((ch / total) * 100)}%` }}
                          />
                        </div>
                        <span className="book-spine__cta">
                          {started ? `гл. ${ch}/${total}` : 'читать'}
                        </span>
                      </div>
                    </div>
                  </button>
                  </div>
                )
              }}
          </Shelf>
        </section>
      ))}
    </div>
  )
}
