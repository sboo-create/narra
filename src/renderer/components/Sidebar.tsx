import { useStore, canChat, canImage, canTts } from '../store/useStore'
import { Logo } from './Logo'
import type { Route } from '../store/useStore'

const items: { label: string; route: Route; match: string[] }[] = [
  { label: 'Библиотека', route: { name: 'library' }, match: ['library'] },
  { label: 'Читалка', route: { name: 'reader' }, match: ['reader'] },
  { label: 'Мой путь', route: { name: 'profile' }, match: ['profile'] },
  { label: 'Настройки', route: { name: 'settings' }, match: ['settings'] }
]

export function Sidebar() {
  const route = useStore((s) => s.route)
  const navigate = useStore((s) => s.navigate)
  const characters = useStore((s) => s.characters)
  const chapter = useStore((s) => s.chapter)

  const health = useStore((s) => s.health)

  const anyReady = canChat(health) || canImage(health) || canTts(health)

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <Logo size={36} />
        <div>
          <h1 className="wordmark">narra.</h1>
          <span>живые книги</span>
        </div>
      </div>

      <nav className="nav">
        {items.map((it) => (
          <button
            key={it.label}
            className={`nav__item ${it.match.includes(route.name) ? 'nav__item--active' : ''}`}
            onClick={() => navigate(it.route)}
          >
            {it.label}
          </button>
        ))}

        <div className="nav__section">Персонажи</div>
        {characters.map((c) => {
          const locked = (c.unlockChapter || 1) > chapter
          return (
            <button
              key={c.id}
              className={`nav__item ${
                route.name === 'character' && route.id === c.id ? 'nav__item--active' : ''
              } ${locked ? 'nav__item--locked' : ''}`}
              onClick={() => navigate({ name: 'character', id: c.id })}
            >
              {c.name}
              {locked && <span className="nav__lock">гл. {c.unlockChapter}</span>}
            </button>
          )
        })}
      </nav>

      <div className="sidebar__spacer" />

      <button
        className="sidebar__status"
        onClick={() => navigate({ name: 'settings' })}
        title="Настройки подключения"
      >
        <span className={`dot-online ${anyReady ? '' : 'dot-online--off'}`} />
        {anyReady ? 'Сервер подключён' : 'Сервер не подключён'}
      </button>
    </aside>
  )
}
