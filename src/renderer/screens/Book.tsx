import { useState } from 'react'
import { buildCharacters } from '../lib/importFlow'
import { useStore } from '../store/useStore'
import { GeneratedImage } from '../components/GeneratedImage'
import { CharAvatar } from '../components/CharAvatar'
import { coverKey, portraitKey } from '../lib/imageStyle'
import { coverPrompt } from '../lib/passport'

export function Book() {
  const fanfic = useStore((s) => s.fanfic)
  const characters = useStore((s) => s.characters)
  const persisted = useStore((s) => s.persisted)
  const chapter = useStore((s) => s.chapter)
  const setChapter = useStore((s) => s.setChapter)
  const deleteBook = useStore((s) => s.deleteBook)
  const reloadBooks = useStore((s) => s.reloadBooks)
  const toast = useStore((s) => s.toast)
  const [menu, setMenu] = useState(false)
  const [remarking, setRemarking] = useState(false)
  const navigate = useStore((s) => s.navigate)

  if (!fanfic) return null
  const total = fanfic.chapters.length
  const progress = Math.round((chapter / total) * 100)

  function openChapter(n: number) {
    setChapter(n)
    navigate({ name: 'reader' })
  }

  return (
    <div className="page book-page">
      <button className="reader__back" onClick={() => navigate({ name: 'library' })}>
        ‹ Библиотека
      </button>

      {/* Хиро: обложка + мета */}
      <div className="book-hero2">
        <div className="book-hero2__cover">
          <GeneratedImage
            cacheKey={coverKey(fanfic.id)}
            prompt={coverPrompt(fanfic.coverPrompt, characters.slice(0, 2))}
            rounded={10}
            lockedHint="обложка"
            engine="kandinsky"
            regenerable
          />
        </div>
        <div className="book-hero2__info">
          <h1 className="book-hero2__title">{fanfic.title}</h1>
          <div className="book-hero2__author">{fanfic.author}</div>
          <div className="book-hero2__progress">
            <div className="progress" style={{ flex: 1 }}>
              <div className="progress__fill" style={{ width: `${progress}%` }} />
            </div>
            <span>{progress}%</span>
          </div>
          <div className="book-hero2__meta">
            Глава {chapter} из {total}
          </div>
          <div className="book-hero2__actions">
            <button className="btn btn--primary" onClick={() => navigate({ name: 'reader' })}>
              {chapter > 1 ? 'Продолжить чтение' : 'Начать читать'}
            </button>
            <div className="book-menu">
              <button className="book-menu__btn" title="Ещё" onClick={() => setMenu(!menu)}>
                ⋯
              </button>
              {menu && (
                <>
                  <div className="panel-scrim" onClick={() => setMenu(false)} />
                  <div className="book-menu__pop">
                    <button
                      disabled={remarking}
                      onClick={async () => {
                        setMenu(false)
                        setRemarking(true)
                        const ex = await window.narra.bookExcerpt(fanfic.id)
                        if (!ex.ok) {
                          setRemarking(false)
                          toast({ type: 'error', title: 'Только для загруженных книг', message: ex.error })
                          return
                        }
                        const built = await buildCharacters(ex.data!.title, ex.data!.author, ex.data!.excerpt)
                        if (built.ok) {
                          await window.narra.saveBookCharacters(fanfic.id, built.characters)
                          await reloadBooks()
                          toast({
                            type: 'success',
                            title: 'Герои перерисованы',
                            message: built.characters.map((c) => c.name).join(', ')
                          })
                        } else {
                          toast({ type: 'error', title: 'Не удалось', message: built.error })
                        }
                        setRemarking(false)
                      }}
                    >
                      ✦ Разметить героев заново
                    </button>
                    <button
                      className="is-danger"
                      onClick={() => {
                        setMenu(false)
                        if (!window.confirm(`Убрать «${fanfic.title}» из библиотеки?\n\nПрогресс чтения, закладки и заметки по книге будут удалены.`)) return
                        deleteBook(fanfic.id).then(() => navigate({ name: 'library' }))
                      }}
                    >
                      Удалить книгу
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Персонажи */}
      <div className="section-head"><h3>Персонажи</h3></div>
      <div className="book-chars">
        {characters.map((c) => {
          const locked = (c.unlockChapter || 1) > chapter
          return (
            <button
              key={c.id}
              className={`book-char ${locked ? 'book-char--locked' : ''}`}
              onClick={() => navigate({ name: 'character', id: c.id })}
            >
              <CharAvatar cacheKey={portraitKey(fanfic.id, c.id)} name={c.name} size={62} />
              <span>{c.name}</span>
              {locked && <em>гл. {c.unlockChapter}</em>}
            </button>
          )
        })}
      </div>

      {/* Описание */}
      <div className="section-head"><h3>Описание</h3></div>
      <p className="book-desc">{fanfic.description}</p>

      {/* Главы */}
      <div className="section-head"><h3>Главы</h3></div>
      <div className="chapter-list">
        {fanfic.chapters.map((ch) => {
          const read = ch.number < chapter
          const current = ch.number === chapter
          return (
            <button
              key={ch.number}
              className={`chapter-row ${current ? 'chapter-row--current' : ''} ${
                read ? 'chapter-row--read' : ''
              }`}
              onClick={() => openChapter(ch.number)}
            >
              <span className="chapter-row__num">{read ? '✓' : ch.number}</span>
              <span className="chapter-row__title">{ch.title}</span>
              {current && <span className="chapter-row__badge">читаю</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
