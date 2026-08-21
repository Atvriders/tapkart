import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * SOURCE-TEXT, and it has to be. barrel.test.ts bans importing the three adapter from
 * any test file in the repository — it needs a GPU (§8.3) — so no test has ever called
 * `resize`, read `camera.aspect`, or watched `applyFrame` set a fov. That is exactly
 * why the clobber below survived: the projection wiring is the one part of this feature
 * with no executable coverage available, so it is pinned as text and the behaviour it
 * wires up is proved in camera.test.ts against the pure function.
 *
 * The path is assembled from segments rather than written as one string on purpose:
 * barrel.test.ts sweeps every test file for anything that LOOKS like an import of the
 * adapter, and a literal 'src/three/renderer' after the word `from` would trip it.
 */
const RENDERER = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'three', 'renderer.ts'),
  'utf8',
)

/** The shell-lifecycle.test.ts slicing idiom: assert on a named region of the file, so
 *  "resize calls applyProjection" cannot be satisfied by a call somewhere else. */
function between(start: string, end: string): string {
  const from = RENDERER.indexOf(start)
  expect(from, `missing source marker: ${start}`).toBeGreaterThan(-1)
  const to = RENDERER.indexOf(end, from + start.length)
  expect(to, `missing source marker: ${end}`).toBeGreaterThan(from)
  return RENDERER.slice(from, to)
}

/**
 * Comments stripped, the way camera.test.ts's own purity scan does it. The adapter's
 * prose names the very calls these assertions ban — the comment in `resize` explains
 * why the separate `updateProjectionMatrix()` is gone — and a mention in a comment is
 * not a call. Every "must not contain" below therefore runs on code, not on English.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** The clobber this task exists to remove: `camera.fov` holds the SOLVED fov, so
 *  comparing it against the fov the frame requested is permanently true once the two
 *  differ — an updateProjectionMatrix every frame forever — and overwrites whatever
 *  `resize` solved on the very next frame. */
const CLOBBER = 'camera.fov !== frame.camera.fovDegrees'

describe('the three adapter reads the projection band (item 7)', () => {
  it('read the real adapter (guard: an empty read passes every scan below)', () => {
    // ANTI-VACUITY. Without this the "does not contain" assertions all pass on a typo'd
    // path, a renamed file, or an empty string — and pass while reporting nothing.
    expect(RENDERER).toContain('export function createThreeRenderer(')
    expect(RENDERER).toContain('resize(widthPx: number, heightPx: number')
    expect(RENDERER).toContain('applyFrame(frame: RenderFrame): void {')
    // ...and the needles themselves can match something, proved against synthetic text.
    expect(`if (${CLOBBER}) {`).toContain(CLOBBER)
    expect('camera.updateProjectionMatrix()').toContain('updateProjectionMatrix')
  })

  it('imports the band from the pure camera module rather than re-deriving it', () => {
    expect(RENDERER).toContain(
      "import { DEFAULT_CAMERA_PARAMS, projectionFovDegrees } from '../camera'",
    )
    expect(RENDERER).toContain('projectionFovDegrees(requestedFov, aspect)')
  })

  it('no longer uses camera.fov as its own dirty flag', () => {
    expect(code(RENDERER)).not.toContain(CLOBBER)
    // One writer of camera.fov, and it is applyProjection. Two writers is the bug in a
    // different costume: whichever runs last wins and the other silently does nothing.
    expect(code(RENDERER).match(/camera\.fov = /g)).toHaveLength(1)
    const applyProjection = between('function applyProjection(): void {', '\n  }\n')
    expect(applyProjection).toContain('camera.fov = solved')
  })

  it('caches the solved fov so a steady frame rebuilds no projection matrix', () => {
    const applyProjection = between('function applyProjection(): void {', '\n  }\n')
    expect(applyProjection).toContain('const solved = projectionFovDegrees(requestedFov, aspect)')
    expect(applyProjection).toContain('if (solved === appliedFov) return')
    expect(applyProjection).toContain('camera.updateProjectionMatrix()')
    // The early-out must come BEFORE the write, or it caches nothing at all.
    expect(applyProjection.indexOf('if (solved === appliedFov) return')).toBeLessThan(
      applyProjection.indexOf('appliedFov = solved'),
    )
    expect(RENDERER).toContain('let aspect = 1')
    expect(RENDERER).toContain('let requestedFov = DEFAULT_CAMERA_PARAMS.fovDegrees')
    expect(RENDERER).toContain('let appliedFov = Number.NaN')
  })

  it('applyFrame tracks the REQUESTED fov and defers the solve', () => {
    const applyFrame = between(
      'applyFrame(frame: RenderFrame): void {',
      'for (let i = 0; i < MAX_KARTS',
    )
    expect(applyFrame).toContain('if (frame.camera.fovDegrees !== requestedFov) {')
    expect(applyFrame).toContain('requestedFov = frame.camera.fovDegrees')
    expect(applyFrame).toContain('applyProjection()')
    // applyFrame must not touch the matrix itself: applyProjection is the only place
    // that knows whether the solved value actually moved.
    expect(code(applyFrame)).not.toContain('updateProjectionMatrix')
    expect(code(applyFrame)).not.toContain('camera.fov =')
  })

  it('resize feeds the new aspect in and invalidates the cache', () => {
    const resize = between('resize(widthPx: number, heightPx: number', 'stats(): RendererStats')
    expect(resize).toContain('camera.aspect = w / h')
    // Anchored to the start of its own line, NOT `toContain`: `camera.aspect = w / h`
    // contains the bare assignment as a substring, so a plain contains-check here can
    // never fail — deleting the local write leaves it green. (Found by mutation.)
    const localAspect = /(?:^|\n)\s*aspect = w \/ h\b/.exec(resize)
    expect(localAspect, 'resize does not write the local `aspect`').not.toBeNull()
    expect(resize).toContain('appliedFov = Number.NaN')
    expect(resize).toContain('applyProjection()')
    // The separate updateProjectionMatrix is GONE: applyProjection makes it, and a
    // second unconditional call would defeat the cache the assertion above installs.
    expect(code(resize)).not.toContain('updateProjectionMatrix')
    // Order matters: solving against the previous aspect and then updating it leaves a
    // frame projected for the old shape.
    expect((localAspect as RegExpExecArray).index).toBeLessThan(
      resize.indexOf('applyProjection()'),
    )
    expect(resize.indexOf('appliedFov = Number.NaN')).toBeLessThan(
      resize.indexOf('applyProjection()'),
    )
  })

  it('builds the camera from CameraParams, not from four coincidental literals', () => {
    // near/far are asserted by camera.test.ts and were read by NOTHING: the adapter
    // hardcoded 62/0.3/900, so editing the params moved no pixel and no test noticed.
    const construction = between('const camera = new PerspectiveCamera(', ')\n')
    expect(construction).toContain('DEFAULT_CAMERA_PARAMS.fovDegrees')
    expect(construction).toContain('DEFAULT_CAMERA_PARAMS.near')
    expect(construction).toContain('DEFAULT_CAMERA_PARAMS.far')
    expect(code(RENDERER)).not.toMatch(/new PerspectiveCamera\(\s*\d/)
    expect(code(RENDERER)).not.toContain('0.3, 900')
  })
})
