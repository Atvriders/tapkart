import { connect } from 'node:net'
import { expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { SIGNAL_MAX_BYTES } from '@tapkart/net'
import { WS_PATH } from '../src/static'
import { main } from '../src/main'

async function rejectedUpgrade(port: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let response = ''
    let done = false

    const finish = (): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve(response)
    }

    socket.setTimeout(5_000)
    socket.on('connect', () => {
      socket.write(
        'POST ' + WS_PATH + ' HTTP/1.1\r\n' +
        'Host: 127.0.0.1:' + String(port) + '\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    socket.on('data', (chunk) => { response += chunk.toString('utf8') })
    socket.on('end', finish)
    socket.on('close', finish)
    socket.on('timeout', () => { reject(new Error('POST upgrade did not close')); socket.destroy() })
    socket.on('error', (err: NodeJS.ErrnoException) => {
      // Destroying a rejected upgrade can surface as a reset on some Node
      // versions. It is still a rejection; accepting it as 101 is the defect.
      if (err.code === 'ECONNRESET') finish()
      else reject(err)
    })
  })
}

/**
 * THE ONE LOOPBACK BIND (§0b, F-P4-46). The rule is "no EXTERNAL network in
 * tests", not "no network", and this is the only test in the repository allowed
 * to bind a socket. It binds 127.0.0.1:0 -- an OS-assigned ephemeral port -- so
 * it is hermetic and leaves the machine untouched. `no-network.test.ts` scans
 * every package and app test and fails if a second one appears.
 */
it('the composition root answers /healthz and completes a WebSocket upgrade on an ephemeral loopback port', async () => {
  const intervalSpy = vi.spyOn(globalThis, 'setInterval')
  let handle: Awaited<ReturnType<typeof main>> | null = null

  try {
    // Configuration errors are promise rejections, so the entry-point rejection
    // handler can report them instead of losing a synchronous throw.
    await expect(main({ PORT: 'not-a-port', BIND_HOST: '127.0.0.1' }))
      .rejects.toThrow('PORT: expected an integer')
    await expect(main({ SHADOW_ENABLED: 'false', BIND_HOST: '127.0.0.1' }))
      .rejects.toThrow('SHADOW_ENABLED: false is unsupported in TapKart v1')
    expect(intervalSpy).not.toHaveBeenCalled()

    const starting = main({ PORT: '0', BIND_HOST: '127.0.0.1' })
    // Polling cannot start until the listen callback proves the bind succeeded.
    expect(intervalSpy).not.toHaveBeenCalled()
    handle = await starting
    expect(intervalSpy).toHaveBeenCalledTimes(1)

    const port = handle.port()
    expect(port).toBeGreaterThan(0)

    const health = await fetch('http://127.0.0.1:' + String(port) + '/healthz')
    expect(health.status).toBe(200)
    expect(await health.text()).toContain('ok')

    const socket = new WebSocket('ws://127.0.0.1:' + String(port) + WS_PATH)
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => { resolve() })
      socket.on('error', (err) => { reject(err) })
    })
    expect(socket.readyState).toBe(WebSocket.OPEN)
    const socketClosed = new Promise<void>((resolve) => {
      socket.on('close', () => { resolve() })
    })

    // An Upgrade header does not override the HTTP method policy.
    expect(await rejectedUpgrade(port)).not.toContain('101 Switching Protocols')

    const oversized = new WebSocket('ws://127.0.0.1:' + String(port) + WS_PATH)
    await new Promise<void>((resolve, reject) => {
      oversized.on('open', () => { resolve() })
      oversized.on('error', (err) => { reject(err) })
    })
    const oversizedClosed = new Promise<number>((resolve) => {
      oversized.on('close', (code) => { resolve(code) })
    })
    oversized.send(new Uint8Array(SIGNAL_MAX_BYTES + 1))
    expect(await oversizedClosed).toBe(1009)

    // A failed listen rejects, does not start a second scheduler, and releases
    // the provisional hub it constructed.
    const timersBeforeFailedBind = intervalSpy.mock.calls.length
    await expect(main({ PORT: String(port), BIND_HOST: '127.0.0.1' }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(intervalSpy).toHaveBeenCalledTimes(timersBeforeFailedBind)

    const closing = handle.close()
    await expect(Promise.all([closing, handle.close(), handle.close()])).resolves.toEqual([
      undefined, undefined, undefined,
    ])
    await socketClosed
    expect(socket.readyState).toBe(WebSocket.CLOSED)
    await expect(handle.close()).resolves.toBeUndefined()
    handle = null
  } finally {
    intervalSpy.mockRestore()
    if (handle !== null) await handle.close()
  }
}, 20_000)
