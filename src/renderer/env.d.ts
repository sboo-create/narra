/// <reference types="vite/client" />
import type { NarraApi } from '../preload'

declare global {
  interface Window {
    narra: NarraApi
  }
}

export {}
