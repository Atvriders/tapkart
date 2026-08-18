import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.atvriders.tapkart',
  appName: 'Tapkart',
  webDir: '../web/dist',

  // The generated native project is deliberately flat inside this workspace.
  android: { path: '.' },
}

export default config
