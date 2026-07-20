import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    define: {
      // адрес прокси зашивается при сборке: NARRA_PROXY_URL=https://… npm run dist
      'process.env.NARRA_PROXY_URL': JSON.stringify(process.env.NARRA_PROXY_URL || '')
    },
    build: {
      rollupOptions: {
        // electron-store & uuid are ESM-ish; let vite bundle them but keep electron external
        external: ['electron']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        external: ['electron']
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()]
  }
})
