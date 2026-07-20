import { useEffect, useState } from 'react'
import { useStore } from './store/useStore'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { Library } from './screens/Library'
import { Reader } from './screens/Reader'
import { Book } from './screens/Book'
import { CharacterCard } from './screens/CharacterCard'
import { Chat } from './screens/Chat'
import { Settings } from './screens/Settings'
import { Profile } from './screens/Profile'
import { Logo } from './components/Logo'

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const ready = useStore((s) => s.ready)
  const route = useStore((s) => s.route)
  const init = useStore((s) => s.init)
  const toast = useStore((s) => s.toast)

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    setSidebarOpen(false)
  }, [route])

  // проверка обновления: раз при запуске, ненавязчивый тост со ссылкой
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(async () => {
      const r = await window.narra.checkAppUpdate()
      if (r.ok && r.data!.hasUpdate) {
        toast({
          type: 'info',
          title: `Доступна новая версия ${r.data!.version}`,
          message: 'Скачай свежий установщик и перетащи Narra в «Программы» поверх старой.',
          actionLabel: '⬇ Скачать',
          onRetry: () => window.open(r.data!.url)
        })
      }
    }, 4000)
    return () => clearTimeout(t)
  }, [ready, toast])

  if (!ready) {
    return (
      <div className="boot">
        <Logo size={72} />
        <div className="boot__text">Открываем библиотеку…</div>
      </div>
    )
  }

  return (
    <div className={`app-shell ${sidebarOpen ? 'app-shell--menu-open' : ''}`}>
      <button
        className="mobile-menu-button"
        type="button"
        aria-label={sidebarOpen ? 'Закрыть меню' : 'Открыть меню'}
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen((open) => !open)}
      >
        <span />
        <span />
        <span />
      </button>
      <button
        className="sidebar-backdrop"
        type="button"
        aria-label="Закрыть меню"
        onClick={() => setSidebarOpen(false)}
      />
      <Sidebar onNavigate={() => setSidebarOpen(false)} />
      <main className="main-area">
        {route.name === 'library' && <Library />}
        {route.name === 'book' && <Book />}
        {route.name === 'reader' && <Reader />}
        {route.name === 'character' && <CharacterCard id={route.id} />}
        {route.name === 'chat' && <Chat id={route.id} sceneContext={route.sceneContext} autoAsk={route.autoAsk} />}
        {route.name === 'profile' && <Profile />}
        {route.name === 'settings' && <Settings />}
      </main>
      <Toasts />
    </div>
  )
}
