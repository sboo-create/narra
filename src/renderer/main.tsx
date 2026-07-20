import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/theme.css'
import './styles/screens.css'

if (!Promise.allSettled) {
  Promise.allSettled = ((promises: Iterable<PromiseLike<unknown> | unknown>) =>
    Promise.all(
      Array.from(promises, (promise) =>
        Promise.resolve(promise).then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason }) as PromiseRejectedResult
        )
      )
    )
  ) as typeof Promise.allSettled
}

async function bootstrap() {
  // В Android WebView поднимаем Capacitor-мост вместо Electron preload.
  let nativePlatform = false
  if (!window.narra) {
    try {
      const { Capacitor } = await import('@capacitor/core')
      nativePlatform = Capacitor.isNativePlatform()
      if (nativePlatform) {
        const { installMobileBridge } = await import('./lib/mobileBridge')
        await installMobileBridge()
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const stack = e instanceof Error ? e.stack : ''
      console.error(`[narra] mobile bridge failed: ${message}\n${stack}`)
    }
  }

  // В обычном браузере (без Electron/Capacitor) поднимаем dev-заглушку window.narra,
  // чтобы UI можно было открыть и проверить на localhost:5173.
  if (!window.narra && !nativePlatform) {
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
