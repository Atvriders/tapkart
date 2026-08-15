// The entry module. It calls startShell and nothing else — every decision lives
// behind that call, in packages/game.
import { realFrameClock } from '@tapkart/game'
import { startShell } from '@tapkart/game/shell'
import { nullAudioBackend } from '@tapkart/render'
import { DEFAULT_THREE_OPTIONS, createThreeRenderer } from '@tapkart/render/three'

const canvas = document.getElementById('tk-canvas')
const root = document.getElementById('tk-root')
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('main: #tk-canvas is missing from index.html')
}
if (!(root instanceof HTMLElement)) throw new Error('main: #tk-root is missing from index.html')

// localStorage throws outright in some privacy modes, so both halves are
// guarded. Losing settings is a worse-but-playable game; a thrown exception here
// is a black screen.
const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // Storage denied: the session still plays, it just does not persist.
    }
  },
}

const shell = startShell({
  canvas,
  root,
  clock: realFrameClock,
  store,
  renderer: createThreeRenderer(canvas, DEFAULT_THREE_OPTIONS),
  audio: nullAudioBackend, // Q26: the seam is authored, Web Audio is Plan 5's
})

// `pagehide` fires on mobile Safari where `beforeunload` does not.
window.addEventListener('pagehide', () => shell.stop())
