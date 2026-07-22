import { useMemo, useState } from 'react'
import { useStore } from '../store/useStore'
import type { Bookmark, Note, ReaderPrefs } from '../store/useStore'
import type { Fanfic } from '@shared/types'
import { proseOnly } from '../lib/blocks'

/* Панели читалки: «Темы и настройки» (АА) и навигация (оглавление/закладки/поиск). */

interface SettingsProps {
  onClose: () => void
}

/** Темы-пресеты: плитка показывает, как будет выглядеть страница. */
const THEMES: { id: ReaderPrefs['theme']; label: string; bg: string; ink: string; bold?: boolean }[] = [
  { id: 'original', label: 'Оригинал', bg: '#ffffff', ink: '#1a1a17' },
  { id: 'quiet', label: 'Тишина', bg: '#3a3a3c', ink: '#c9c7c2' },
  { id: 'paper', label: 'Бумага', bg: '#e9e9ea', ink: '#22221f' },
  { id: 'accent', label: 'Акцент', bg: '#ffffff', ink: '#111', bold: true },
  { id: 'calm', label: 'Покой', bg: '#efe1c6', ink: '#3b3125' },
  { id: 'focus', label: 'Фокус', bg: '#fbf7ef', ink: '#2b2822' }
]

export function ReaderSettings({ onClose }: SettingsProps) {
  const prefs = useStore((s) => s.persisted.readerPrefs)
  const set = useStore((s) => s.setReaderPrefs)
  const [more, setMore] = useState(false)

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <div className="reader-panel reader-panel--settings">
        <div className="rp-head">Темы и настройки</div>

        <div className="rp-sizerow">
          <button
            className="rp-size"
            disabled={prefs.fontSize <= 15}
            onClick={() => set({ fontSize: prefs.fontSize - 1 })}
          >
            A
          </button>
          <span className="rp-size-sep" />
          <button
            className="rp-size rp-size--big"
            disabled={prefs.fontSize >= 26}
            onClick={() => set({ fontSize: prefs.fontSize + 1 })}
          >
            A
          </button>
          <span className="rp-size-value">{prefs.fontSize} pt</span>
        </div>

        <div className="rp-themes">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`rp-tile ${prefs.theme === t.id ? 'is-on' : ''}`}
              style={{ background: t.bg, color: t.ink }}
              onClick={() => set({ theme: t.id })}
            >
              <span className="rp-tile__aa" style={{ fontWeight: t.bold ? 800 : 500 }}>
                Aa
              </span>
              <span className="rp-tile__label">{t.label}</span>
            </button>
          ))}
        </div>

        <button className={`rp-more ${more ? 'is-on' : ''}`} onClick={() => setMore(!more)}>
          ⚙ Настроить
        </button>

        {more && (
          <div className="rp-more-body">
            <div className="rp-label">Шрифт</div>
            <div className="rp-seg">
              <button
                className={`rp-seg__btn ${prefs.font === 'serif' ? 'is-on' : ''}`}
                style={{ fontFamily: 'var(--font-book)' }}
                onClick={() => set({ font: 'serif' })}
              >
                С засечками
              </button>
              <button
                className={`rp-seg__btn ${prefs.font === 'sans' ? 'is-on' : ''}`}
                onClick={() => set({ font: 'sans' })}
              >
                Гротеск
              </button>
            </div>

            <div className="rp-label">Ширина колонки</div>
            <div className="rp-seg">
              {(['narrow', 'normal', 'wide'] as const).map((w) => (
                <button
                  key={w}
                  className={`rp-seg__btn ${prefs.width === w ? 'is-on' : ''}`}
                  onClick={() => set({ width: w })}
                >
                  {w === 'narrow' ? 'Узкая' : w === 'normal' ? 'Обычная' : 'Широкая'}
                </button>
              ))}
            </div>

            <div className="rp-label">Межстрочный интервал</div>
            <div className="rp-seg">
              {([1.5, 1.75, 2.0] as const).map((lh) => (
                <button
                  key={lh}
                  className={`rp-seg__btn ${prefs.lineHeight === lh ? 'is-on' : ''}`}
                  onClick={() => set({ lineHeight: lh })}
                >
                  {lh === 1.5 ? 'Плотно' : lh === 1.75 ? 'Обычно' : 'Свободно'}
                </button>
              ))}
            </div>

            <div className="rp-label">Прокрутка</div>
            <div className="rp-seg">
              <button className={`rp-seg__btn ${!prefs.paged ? 'is-on' : ''}`} onClick={() => set({ paged: false })}>
                Лента
              </button>
              <button className={`rp-seg__btn ${prefs.paged ? 'is-on' : ''}`} onClick={() => set({ paged: true })}>
                Постранично
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

interface NavProps {
  fanfic: Fanfic
  chapterNo: number
  onClose: () => void
  onJump: (chapter: number, block?: number) => void
}

type Tab = 'toc' | 'marks' | 'search'

export function ReaderNav({ fanfic, chapterNo, onClose, onJump }: NavProps) {
  const [tab, setTab] = useState<Tab>('toc')
  const [query, setQuery] = useState('')
  const persisted = useStore((s) => s.persisted)
  const removeBookmark = useStore((s) => s.removeBookmark)
  const removeNote = useStore((s) => s.removeNote)

  const bookmarks: Bookmark[] = persisted.bookmarks[fanfic.id] || []
  const notes: Note[] = persisted.notes[fanfic.id] || []

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 3) return []
    const out: { chapter: number; title: string; snippet: string }[] = []
    for (const ch of fanfic.chapters) {
      const text = proseOnly(ch.text)
      const low = text.toLowerCase()
      let from = 0
      let hits = 0
      while (hits < 3) {
        const i = low.indexOf(q, from)
        if (i < 0) break
        out.push({
          chapter: ch.number,
          title: ch.title,
          snippet: text.slice(Math.max(0, i - 60), i + q.length + 70).replace(/\s+/g, ' ')
        })
        from = i + q.length
        hits++
      }
      if (out.length > 60) break
    }
    return out
  }, [query, fanfic])

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <div className="reader-panel reader-panel--nav">
        <div className="rp-tabs">
          <button className={tab === 'toc' ? 'is-on' : ''} onClick={() => setTab('toc')}>
            Оглавление
          </button>
          <button className={tab === 'marks' ? 'is-on' : ''} onClick={() => setTab('marks')}>
            Закладки{bookmarks.length + notes.length ? ` · ${bookmarks.length + notes.length}` : ''}
          </button>
          <button className={tab === 'search' ? 'is-on' : ''} onClick={() => setTab('search')}>
            Поиск
          </button>
        </div>

        <div className="rp-body">
          {tab === 'toc' &&
            fanfic.chapters.map((ch) => (
              <button
                key={ch.number}
                className={`rp-item ${ch.number === chapterNo ? 'is-current' : ''}`}
                onClick={() => {
                  onJump(ch.number)
                  onClose()
                }}
              >
                <span className="rp-item__num">{ch.number}</span>
                <span className="rp-item__text">{ch.title}</span>
              </button>
            ))}

          {tab === 'marks' && (
            <>
              {bookmarks.length === 0 && notes.length === 0 && (
                <div className="rp-empty">
                  Пока пусто. Закладку ставит флажок в шапке, заметку — выделение текста.
                </div>
              )}
              {bookmarks.map((b) => (
                <div key={b.id} className="rp-mark">
                  <button
                    className="rp-mark__body"
                    onClick={() => {
                      onJump(b.chapter, b.block)
                      onClose()
                    }}
                  >
                    <span className="rp-mark__meta">Глава {b.chapter}</span>
                    <span className="rp-mark__quote">{b.quote}</span>
                  </button>
                  <button className="rp-mark__del" onClick={() => removeBookmark(fanfic.id, b.id)}>
                    ✕
                  </button>
                </div>
              ))}
              {notes.map((n) => (
                <div key={n.id} className="rp-mark rp-mark--note">
                  <button
                    className="rp-mark__body"
                    onClick={() => {
                      onJump(n.chapter, n.block)
                      onClose()
                    }}
                  >
                    <span className="rp-mark__meta">Заметка · глава {n.chapter}</span>
                    <span className="rp-mark__quote">{n.quote}</span>
                    {n.note && <span className="rp-mark__note">{n.note}</span>}
                  </button>
                  <button className="rp-mark__del" onClick={() => removeNote(fanfic.id, n.id)}>
                    ✕
                  </button>
                </div>
              ))}
            </>
          )}

          {tab === 'search' && (
            <>
              <input
                autoFocus
                className="rp-search"
                placeholder="Найти в книге…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query.trim().length >= 3 && results.length === 0 && (
                <div className="rp-empty">Ничего не нашлось</div>
              )}
              {results.map((r, i) => (
                <button
                  key={i}
                  className="rp-item rp-item--result"
                  onClick={() => {
                    onJump(r.chapter)
                    onClose()
                  }}
                >
                  <span className="rp-mark__meta">
                    Глава {r.chapter} · {r.title}
                  </span>
                  <span className="rp-item__text">…{r.snippet}…</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  )
}
