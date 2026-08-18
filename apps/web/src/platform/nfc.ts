// ADAPTER. Contract §10.2. This is the only Capacitor plugin registration in
// the repository and the browser branch returns the inert shipped host.

import { registerPlugin } from '@capacitor/core'
import {
  nullNfcHost,
  type InviteSource,
  type NfcHost,
  type NfcSupport,
} from '@tapkart/invite'
import { IS_NATIVE } from './env'

/** Mirrors the six @PluginMethod surfaces implemented by the Android plugin. */
export interface TapkartNfcPluginBridge {
  isSupported(): Promise<NfcSupport>
  startAdvertising(options: { uri: string }): Promise<void>
  stopAdvertising(): Promise<void>
  startReader(): Promise<void>
  stopReader(): Promise<void>
  getPendingInvite(): Promise<{ uri: string | null }>
  addListener(
    eventName: 'inviteUri',
    cb: (ev: { uri: string; source: InviteSource }) => void,
  ): Promise<{ remove(): Promise<void> }>
}

/** Selects a real native host or the browser-safe inert host. */
export function capacitorNfcHost(): NfcHost {
  if (!IS_NATIVE) return nullNfcHost

  const plugin = registerPlugin<TapkartNfcPluginBridge>('TapkartNfc')
  return {
    supported(): Promise<NfcSupport> {
      return plugin.isSupported()
    },
    advertise(uri: string): Promise<void> {
      return plugin.startAdvertising({ uri })
    },
    stop(): Promise<void> {
      return plugin.stopAdvertising()
    },
    startReader(): Promise<void> {
      return plugin.startReader()
    },
    stopReader(): Promise<void> {
      return plugin.stopReader()
    },
    onInvite(cb: (uri: string, source: InviteSource) => void): () => void {
      const handle = plugin.addListener('inviteUri', (ev) => cb(ev.uri, ev.source))
      return () => {
        void handle.then((listener) => listener.remove())
      }
    },
    async pendingInvite(): Promise<string | null> {
      const { uri } = await plugin.getPendingInvite()
      return uri
    },
  }
}
