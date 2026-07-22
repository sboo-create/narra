import { useMemo } from 'react'
import { useStore, charKey } from '../store/useStore'
import { GeneratedImage } from '../components/GeneratedImage'
import { CharAvatar } from '../components/CharAvatar'
import { coverKey, portraitKey } from '../lib/imageStyle'
import { coverPrompt } from '../lib/passport'

export function Profile() {
  const books = useStore((s) => s.books)
  const persisted = useStore((s) => s.persisted)
  const setActiveBook = useStore((s) => s.setActiveBook)
  const navigate = useStore((s) => s.navigate)

  const stats = useMemo(() => {
    const chaptersRead = books.reduce((n, b) => n + (persisted.chapters[b.fanfic.id] || 1), 0)
    const totalChapters = books.reduce((n, b) => n + b.fanfic.chapters.length, 0)
    let userMessages = 0
    const metIds = new Set<string>()
    for (const [charId, msgs] of Object.entries(persisted.chats)) {
      const mine = msgs.filter((m) => m.role === 'user').length
      userMessages += mine
      if (msgs.length > 0) metIds.add(charId)
    }
    const illustrations = Object.keys(persisted.covers).length
    return { chaptersRead, totalChapters, userMessages, metIds, illustrations }
  }, [books, persisted])

  const allCharacters = useMemo(
    () => books.flatMap((b) => b.characters.map((c) => ({ ...c, bookId: b.fanfic.id }))),
    [books]
  )

  return (
    <div className="page">
      <div className="page__head">
        <div className="page__eyebrow">Мой</div>
        <div className="page__title">Путь</div>
      </div>

      <div className="stat-row">
        <div className="stat-tile card">
          <div className="stat-tile__num">{stats.chaptersRead}</div>
          <div className="stat-tile__label">глав открыто из {stats.totalChapters}</div>
        </div>
        <div className="stat-tile card">
          <div className="stat-tile__num">{stats.userMessages}</div>
          <div className="stat-tile__label">сообщений героям</div>
        </div>
        <div className="stat-tile card">
          <div className="stat-tile__num">{stats.metIds.size}</div>
          <div className="stat-tile__label">героев встречено</div>
        </div>
        <div className="stat-tile card">
          <div className="stat-tile__num">{stats.illustrations}</div>
          <div className="stat-tile__label">изображений создано</div>
        </div>
      </div>

      <div className="section-head">
        <h3>Мои книги</h3>
      </div>
      <div className="path-books">
        {books.map((b) => {
          const total = b.fanfic.chapters.length
          const ch = persisted.chapters[b.fanfic.id] || 1
          const pct = Math.round((ch / total) * 100)
          return (
            <button
              key={b.fanfic.id}
              className="path-book card"
              onClick={() => {
                setActiveBook(b.fanfic.id)
                navigate({ name: 'reader' })
              }}
            >
              <div className="path-book__cover">
                <GeneratedImage
                  cacheKey={coverKey(b.fanfic.id)}
                  prompt={coverPrompt(b.fanfic.coverPrompt, b.characters.slice(0, 2))}
                  rounded={6}
                  lockedHint="обложка"
                />
              </div>
              <div className="path-book__body">
                <div className="path-book__title">{b.fanfic.title}</div>
                <div className="path-book__author">{b.fanfic.author}</div>
                <div className="path-book__row">
                  <div className="progress" style={{ flex: 1 }}>
                    <div className="progress__fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="path-book__pct">{pct}%</span>
                </div>
                <div className="path-book__meta">глава {ch} из {total}</div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="section-head">
        <h3>Герои</h3>
      </div>
      {books.map((b) => (
        <div key={b.fanfic.id} className="lib-chars">
          <div className="lib-chars__book">{b.fanfic.title}</div>
          <div className="path-chars">
            {b.characters.map((c0) => {
              const c = { ...c0, bookId: b.fanfic.id }
              const msgs = persisted.chats[charKey(c.bookId, c.id)]?.filter((m) => m.role === 'user').length || 0
              const met = (persisted.chats[charKey(c.bookId, c.id)]?.length || 0) > 0
              return (
                <button
                  key={c.id}
                  className={`path-char card ${met ? '' : 'path-char--dim'}`}
                  onClick={() => {
                    setActiveBook(c.bookId)
                    navigate({ name: 'character', id: c.id })
                  }}
                >
                  <CharAvatar cacheKey={portraitKey(c.bookId, c.id)} name={c.name} size={44} />
                  <div className="path-char__body">
                    <div className="path-char__name">{c.name}</div>
                    <div className="path-char__meta">{met ? `${msgs} сообщ.` : 'ещё не знакомы'}</div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <div style={{ display: 'none' }}>
        {allCharacters.map((c) => {
          const msgs = persisted.chats[charKey(c.bookId, c.id)]?.filter((m) => m.role === 'user').length || 0
          const met = (persisted.chats[charKey(c.bookId, c.id)]?.length || 0) > 0
          return (
            <button
              key={c.id}
              className={`path-char card ${met ? '' : 'path-char--dim'}`}
              onClick={() => {
                setActiveBook(c.bookId)
                navigate({ name: 'character', id: c.id })
              }}
            >
              <CharAvatar cacheKey={portraitKey(c.bookId, c.id)} name={c.name} size={44} />
              <div className="path-char__body">
                <div className="path-char__name">{c.name}</div>
                <div className="path-char__meta">
                  {met ? `${msgs} сообщ.` : 'ещё не знакомы'}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
