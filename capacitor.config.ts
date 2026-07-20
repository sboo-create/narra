import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.narra.reader',
  appName: 'Narra',
  webDir: 'dist-mobile',
  bundledWebRuntime: false,
  android: {
    path: 'android'
  }
}

export default config
