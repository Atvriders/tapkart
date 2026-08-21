import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SHELL_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/shell.ts', import.meta.url)),
  'utf8',
)

function between(start: string, end: string): string {
  const from = SHELL_SOURCE.indexOf(start)
  const to = SHELL_SOURCE.indexOf(end, from + start.length)
  expect(from, `missing source marker: ${start}`).toBeGreaterThan(-1)
  expect(to, `missing source marker: ${end}`).toBeGreaterThan(from)
  return SHELL_SOURCE.slice(from, to)
}

describe('GameShell audio lifecycle (§9.4)', () => {
  it('uses one silent model and a mutable backend everywhere', () => {
    expect(SHELL_SOURCE.match(/createAudioModel\(\)/g)).toHaveLength(2)
    expect(SHELL_SOURCE).toContain('const silentAudioModel = createAudioModel()')
    expect(SHELL_SOURCE).toContain('let activeAudio = opts.audio')
    expect(SHELL_SOURCE).not.toContain('const { canvas, root, clock, store, renderer, audio } = opts')
    expect(SHELL_SOURCE).toContain('activeAudio.apply(r.audioModel)')
    expect(SHELL_SOURCE).toContain(
      'activeAudio.setConfig({ masterGain: settings.audioVolume, enabled: settings.audioEnabled })',
    )
  })

  it('silences before dropping a race and before closing the active backend', () => {
    const endRace = between('function endRace()', 'function dispatch')
    expect(endRace).toContain('silenceAudio()')
    expect(endRace.indexOf('silenceAudio()')).toBeLessThan(endRace.indexOf('race.session.close()'))
    expect(endRace.indexOf('race.session.close()')).toBeLessThan(endRace.indexOf('race = null'))

    const stop = between('return {\n    stop(): void', '    setAudio(next: AudioBackend): void {')
    expect(stop).toContain('silenceAudio()')
    expect(stop.indexOf('silenceAudio()')).toBeLessThan(stop.indexOf('activeAudio.close()'))
  })

  it('silences and closes the outgoing backend, then configures the incoming one immediately', () => {
    const swap = between(
      '    setAudio(next: AudioBackend): void {',
      '    onIdle(cb: () => void): void {',
    )
    expect(swap).toContain('silenceAudio()')
    expect(swap).toContain('activeAudio.close()')
    expect(swap).toContain('activeAudio = next')
    expect(swap).toContain(
      'activeAudio.setConfig({ masterGain: settings.audioVolume, enabled: settings.audioEnabled })',
    )
    expect(swap).toContain('activeAudio.apply(silentAudioModel)')
    expect(swap.indexOf('silenceAudio()')).toBeLessThan(swap.indexOf('activeAudio.close()'))
    expect(swap.indexOf('activeAudio.close()')).toBeLessThan(swap.indexOf('activeAudio = next'))
    const replacedAt = swap.indexOf('activeAudio = next')
    expect(replacedAt).toBeLessThan(swap.indexOf('activeAudio.setConfig', replacedAt))
  })
})

describe('GameShell invite/lifecycle composition (§2.3, §15.2)', () => {
  it('keeps NFC and origin optional and exposes only the three lifecycle methods', () => {
    const options = between('export interface ShellOptions', 'export interface GameShell')
    expect(options).toContain('nfc?: NfcHost')
    expect(options).toContain('origin?: string')
    const shell = between('export interface GameShell', 'const PAYLOAD_EVENTS')
    expect(shell).toContain('setAudio(next: AudioBackend): void')
    expect(shell).toContain('onIdle(cb: () => void): void')
    expect(shell).toContain('onRaceStateChange(cb: (racing: boolean) => void): void')
  })

  it('mounts tap and QR fallback beside the existing room code only for a real room', () => {
    expect(SHELL_SOURCE).toContain("panel.setAttribute('data-testid', 'invite-panel')")
    expect(SHELL_SOURCE).toContain("tap.setAttribute('data-testid', 'invite-tap')")
    expect(SHELL_SOURCE).toContain("qr.setAttribute('data-testid', 'invite-qr')")
    expect(SHELL_SOURCE).toContain('uri = buildInviteUri(args.origin, args.roomCode)')
    expect(SHELL_SOURCE).toContain('QR_QUIET_ZONE')
    expect(SHELL_SOURCE).toContain("app.screen === 'lobby' && app.role === 'host' && app.roomCode !== ''")
    expect(SHELL_SOURCE).toContain(
      "if (app.screen !== 'lobby' || app.role !== 'host' || app.roomCode === '')",
    )
    expect(SHELL_SOURCE).toContain("roomCodeDisplay: 'room-code'")
  })

  it('routes live, cold-start and typed invites through one real join path', () => {
    expect(SHELL_SOURCE).toContain('function handleInvite(uri: string): void')
    expect(SHELL_SOURCE).toContain('const invite = parseInviteUri(uri)')
    expect(SHELL_SOURCE).toContain('invite.origin !== origin')
    expect(SHELL_SOURCE).toContain('joinByCode(invite.roomCode)')
    expect(SHELL_SOURCE).toContain('joinByCode(normalizeRoomCode(input.value))')
    expect(SHELL_SOURCE).toContain("beginMultiplayer('guest', app.roomCode)")
    expect(SHELL_SOURCE).toContain('const offInvite = nfc.onInvite(handleInvite)')
    expect(SHELL_SOURCE).toContain('nfc.pendingInvite().then((uri) =>')
    expect(SHELL_SOURCE).toContain('handleInvite(uri)')

    const stop = between('return {\n    stop(): void', '    setAudio(next: AudioBackend): void {')
    expect(stop).toContain('disposeInvitePanel()')
    expect(stop).toContain('offInvite()')
  })

  it('reconciles foreground reader mode on state edges and always stops it at teardown', () => {
    expect(SHELL_SOURCE).toContain('const wanted = canAcceptInvite(app)')
    expect(SHELL_SOURCE).toContain('wanted ? nfc.startReader() : nfc.stopReader()')
    const dispatch = between('function dispatch(ev: AppEvent)', 'function joinByCode')
    expect(dispatch).toContain('app = next\n    reconcileReader()')
    const stop = between('return {\n    stop(): void', '    setAudio(next: AudioBackend): void {')
    expect(stop).toContain('nfc.stopReader()')
  })

  it('publishes a reclaimed host role and leaves results before starting a rematch', () => {
    const welcome = between('next.onWelcome((message) => {', '    next.onLobby((message) => {')
    expect(welcome).toContain('role: next.state().role')

    const start = between('next.onStart((message) => {', '    next.onClosed((reason) => {')
    const leaveOldRace = "if (app.screen === 'race' || app.screen === 'results')"
    const prepare = "dispatch({ kind: 'serverStartReceived' })"
    expect(start).toContain(leaveOldRace)
    expect(start).toContain(prepare)
    expect(start.indexOf(prepare)).toBeLessThan(start.indexOf("dispatch({ kind: 'raceStarting' })"))
  })

  it('surfaces degraded direct play and makes results Back recover safely', () => {
    expect(SHELL_SOURCE).toContain("dispatch({ kind: 'serverLostDuringRace' })")
    expect(SHELL_SOURCE).toContain('hudConnection.textContent = app.serverLost ? SERVER_LOST_RACE_WARNING')
    expect(SHELL_SOURCE).toContain('multiplayer?.finishRace()')

    const actions = between("if (kind === 'raceStarting'", '            dispatch({ kind } as AppEvent)')
    expect(actions).toContain("if (kind === 'backToLobby')")
    expect(actions).toContain('if (app.serverLost)')
    expect(actions).toContain("dispatch({ kind: 'connectFailed', message: SERVER_LOST_RECOVERY_MESSAGE })")
    expect(actions).toContain('multiplayer?.returnToLobby()')
  })

  it('clears latched control state at both race boundaries', () => {
    const start = between('function startRace(st: AppState)', 'function silenceAudio()')
    const end = between('function endRace()', 'function dispatch(ev: AppEvent)')
    expect(start).toContain('adapter.reset()')
    expect(end).toContain('adapter.reset()')
    expect(end.indexOf('adapter.reset()')).toBeLessThan(end.indexOf('race.session.close()'))
  })

  it('closes an in-flight room before switching host, join, or solo mode', () => {
    const dispatch = between('function dispatch(ev: AppEvent)', 'function joinByCode')
    for (const kind of ['hostPressed', 'joinPressed', 'soloPressed']) {
      expect(dispatch).toContain(`ev.kind === '${kind}'`)
    }
    expect(dispatch.indexOf(') closeMultiplayer()')).toBeLessThan(
      dispatch.indexOf('const next = reduceApp(app, ev)'),
    )
  })
})

describe('every viewport lays out (R40 superseded, 2026-08-21)', () => {
  const frameHead = (): string => between('function frame(): void', 'inputSource.drain(rawInputs)')

  /** Comments explain the change; only the CODE may be asserted about. Without
   * this, a comment that merely NAMES the removed behaviour fails the gate. */
  const codeOnly = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

  it('resizes the renderer unconditionally and resets the adapter on the size edge', () => {
    const slice = frameHead()
    // The resize used to sit inside `if (!portrait)`, which left a portrait tablet
    // showing a stale drawing buffer stretched by CSS, with no way out.
    expect(slice).toContain('renderer.resize(viewport.width, viewport.height, dpr)')
    // A steering origin latched in the old geometry means nothing in the new one.
    expect(slice).toContain('adapter.reset()')
    expect(slice).toContain('controlMetrics(viewport, insets, metrics)')
  })

  it('has no orientation gate anywhere in the shell', () => {
    // Anti-vacuity: prove the pattern CAN match this file before trusting that it
    // does not. Without this, deleting the word from the codebase would make the
    // assertion below pass for the wrong reason forever.
    expect(/portrait/i.test(SHELL_SOURCE)).toBe(true) // the superseding note says the word
    expect(/portrait/i.test(codeOnly(SHELL_SOURCE))).toBe(false)
    expect(codeOnly(frameHead())).not.toMatch(/portrait|landscape/i)
    expect(SHELL_SOURCE).not.toContain('Rotate your device')
    expect(SHELL_SOURCE).not.toContain('tk-rotate')
  })

  it('guards the device pixel ratio, which some WebViews report as zero', () => {
    // Math.min(NaN, x) is NaN and a NaN-sized drawing buffer renders nothing.
    expect(frameHead()).toContain('window.devicePixelRatio > 0 ? window.devicePixelRatio : 1')
  })

  it('feeds the simulation a coasting intent when the viewport cannot be laid out', () => {
    // The overlay covers the controls; it does not disable them. Hiding an element
    // is not input handling, which is precisely how the old rotate overlay let a
    // tap on its own text press DRIFT.
    expect(SHELL_SOURCE).toContain('if (metrics.fits) adapter.sample(')
    expect(SHELL_SOURCE).toContain('else neutralIntent(')
  })

  it('stops pointer and key events reaching the race from the blocked overlay', () => {
    const slice = between("blockedEl.className = 'tk-blocked tk-hidden'", 'const controlsEl')
    expect(slice).toContain('stopPropagation')
  })

  it('reads the safe-area insets only when something can have moved a system bar', () => {
    // A getComputedStyle read forces a style flush; per frame it would be a
    // measurable cost for a value that changes a handful of times per session.
    expect(SHELL_SOURCE).toContain('if (insetsDirty) {')
    expect(frameHead()).not.toContain('getComputedStyle')
    for (const kind of ['resize', 'orientationchange', 'fullscreenchange']) {
      expect(SHELL_SOURCE).toContain(kind)
    }
  })
})

describe('the menu UI scales with the same metric as the race controls', () => {
  it('writes --tk-ui-scale, and only when it changes', () => {
    // The CSS consumes it with a fallback of 1, so a shell that never writes it
    // degrades SILENTLY to phone-sized buttons on a tablet -- nothing throws and
    // nothing looks broken in a screenshot at one size.
    expect(SHELL_SOURCE).toContain("root.style.setProperty('--tk-ui-scale'")
    expect(SHELL_SOURCE).toContain('metrics.buttonPx !== lastUiScaleButtonPx')
  })
})

describe('fullscreen is asked for from a gesture, and only from a gesture', () => {
  it('routes every menu control through the gate', () => {
    // `button()` is the single choke point for HOST/JOIN/SOLO/START/BACK, the
    // character buttons, READY, QUIT and the settings rows. Its click handler is
    // the one place in the shell that runs with transient user activation.
    expect(between('function button(', 'return b')).toContain("noteGesture('gesture')")
  })

  it('never requests fullscreen from a lifecycle or invite path', () => {
    // User activation does not survive a navigation, so requesting on arrival
    // rejects 100% of the time -- and on iOS the rejection is a synchronous
    // TypeError inside whatever handler asked.
    const code = SHELL_SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
    for (const m of code.matchAll(/display\.request\(\)/g)) {
      const before = code.slice(Math.max(0, m.index - 400), m.index)
      expect(before, 'display.request() outside the gesture reducer').toContain('next.ask')
    }
    expect(code).not.toMatch(/pendingInvite[\s\S]{0,200}display\.request/)
  })

  it('re-reads the safe area when fullscreen changes, and unhooks on stop', () => {
    // Entering fullscreen removes a system bar: same viewport reported, different
    // usable area. Without the re-read the controls stay inset for a bar that is
    // no longer there.
    // NOT a between() slice: the callback contains `})` in `{ kind: ev }).gate`,
    // so the naive end marker cuts the body off before the line under test and
    // the assertion fails for a reason that has nothing to do with the shell.
    expect(SHELL_SOURCE).toMatch(
      /const offFullscreen = display\.onChange\([\s\S]{0,400}?insetsDirty = true/,
    )
    expect(SHELL_SOURCE).toContain('offFullscreen()')
  })
})
