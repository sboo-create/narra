import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/theme.css'
import './styles/screens.css'

async function bootstrap() {
  // В обычном браузере (без Electron) поднимаем dev-заглушку window.narra,
  // чтобы UI можно было открыть и проверить на localhost:5173.
  if (!window.narra) {
    try {
      const { installDevShim } = await import('./lib/devShim')
      installDevShim()
    } catch (e) {
      console.error('dev-shim не загрузился', e)
    }
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

bootstrap()
