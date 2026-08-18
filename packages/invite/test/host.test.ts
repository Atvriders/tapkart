import { describe, expect, it } from 'vitest'
import { type InviteSource, type NfcHost, nullNfcHost } from '../src/host'

const URI = 'https://tapkart.example/r/ABCDE'

describe('nullNfcHost — what browsers, desktop and startShell without opts.nfc get', () => {
  it('reports no hardware, no HCE and no adapter', async () => {
    expect(await nullNfcHost.supported()).toEqual({
      hardware: false,
      hce: false,
      adapterEnabled: false,
    })
  })

  it('resolves advertising and reader lifecycle calls, and all are idempotent', async () => {
    await expect(nullNfcHost.advertise(URI)).resolves.toBeUndefined()
    await expect(nullNfcHost.advertise(URI)).resolves.toBeUndefined()
    await expect(nullNfcHost.stop()).resolves.toBeUndefined()
    await expect(nullNfcHost.stop()).resolves.toBeUndefined()
    await expect(nullNfcHost.startReader()).resolves.toBeUndefined()
    await expect(nullNfcHost.startReader()).resolves.toBeUndefined()
    await expect(nullNfcHost.stopReader()).resolves.toBeUndefined()
    await expect(nullNfcHost.stopReader()).resolves.toBeUndefined()
  })

  it('never calls back, and its unsubscribe is safe to call twice', () => {
    let calls = 0
    const off = nullNfcHost.onInvite(() => {
      calls += 1
    })
    expect(typeof off).toBe('function')
    off()
    off()
    expect(calls).toBe(0)
  })

  it('resolves pendingInvite to null', async () => {
    expect(await nullNfcHost.pendingInvite()).toBeNull()
  })
})

describe('NfcHost — the seam', () => {
  /** A recording implementation, which is what `apps/web` supplies on Android.
   *  Writing one here proves the interface is implementable with the exact
   *  signatures the adapter and `packages/game` both compile against. */
  function recordingHost(): { host: NfcHost; emit: (uri: string, source: InviteSource) => void; advertised: string[] } {
    const listeners: Array<(uri: string, source: InviteSource) => void> = []
    const advertised: string[] = []
    const host: NfcHost = {
      supported: () => Promise.resolve({ hardware: true, hce: true, adapterEnabled: true }),
      advertise: (uri: string) => {
        advertised.push(uri)
        return Promise.resolve()
      },
      stop: () => Promise.resolve(),
      startReader: () => Promise.resolve(),
      stopReader: () => Promise.resolve(),
      onInvite(cb) {
        listeners.push(cb)
        return () => {
          const at = listeners.indexOf(cb)
          if (at >= 0) listeners.splice(at, 1)
        }
      },
      pendingInvite: () => Promise.resolve(URI),
    }
    const emit = (uri: string, source: InviteSource): void => {
      for (const cb of [...listeners]) cb(uri, source)
    }
    return { host, emit, advertised }
  }

  /** F-P5-16: both filters deliver the same URI to the same handler. It is one
   *  path with two entry points, and `source` exists for the log line. */
  it('delivers both entry points to ONE callback', () => {
    const seen: Array<[string, InviteSource]> = []
    const { host, emit } = recordingHost()
    host.onInvite((uri, source) => {
      seen.push([uri, source])
    })
    emit(URI, 'tag')
    emit(URI, 'appLink')
    expect(seen).toEqual([
      [URI, 'tag'],
      [URI, 'appLink'],
    ])
  })

  it('stops delivering after unsubscribe, and carries a pending cold-start invite', async () => {
    const seen: string[] = []
    const { host, emit, advertised } = recordingHost()
    const off = host.onInvite((uri) => {
      seen.push(uri)
    })
    emit(URI, 'tag')
    off()
    emit(URI, 'appLink')
    expect(seen).toEqual([URI])

    await host.advertise(URI)
    expect(advertised).toEqual([URI])
    expect(await host.pendingInvite()).toBe(URI)
  })
})
