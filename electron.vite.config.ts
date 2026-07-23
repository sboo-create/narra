import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    define: {
      // адрес прокси зашивается при сборке: NARRA_PROXY_URL=https://… npm run dist
      'process.env.NARRA_PROXY_URL': JSON.stringify(process.env.NARRA_PROXY_URL || ''),
      // Cohort token — только мягкий distribution gate. До внешней beta он
      // дополняется auto-enrollment, revocation, короткими bearer и квотами.
      'process.env.NARRA_ACTIVATION_TOKEN': JSON.stringify(process.env.NARRA_ACTIVATION_TOKEN || ''),
      'process.env.NARRA_UPDATE_BASE_URL': JSON.stringify(process.env.NARRA_UPDATE_BASE_URL || ''),
      'process.env.NARRA_ALLOW_CUSTOM_PROXY': JSON.stringify('false')
    },
    build: {
      rollupOptions: {
        // Bundle application dependencies, keep only Electron external.
        external: ['electron'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'pdf-worker': resolve(__dirname, 'src/main/pdf-worker.ts')
        }
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
