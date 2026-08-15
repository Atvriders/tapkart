import { describe, expect, it } from 'vitest'
import * as barrel from '../src/index'
import * as app from '../src/app'
import * as clock from '../src/clock'
import * as composite from '../src/controls/composite'
import * as config from '../src/controls/config'
import * as controls from '../src/controls/index'
import * as controlTypes from '../src/controls/types'
import * as tilt from '../src/controls/tilt'
import * as localinput from '../src/localinput'
import * as results from '../src/results'
import * as session from '../src/session'
import * as settings from '../src/settings'
import * as view from '../src/view'

const MODULES: Array<[string, Record<string, unknown>]> = [
  ['clock', clock],
  ['controls/types', controlTypes],
  ['controls/config', config],
  ['controls/tilt', tilt],
  ['controls/composite', composite],
  ['controls/index', controls],
  ['settings', settings],
  ['app', app],
  ['results', results],
  ['session', session],
  ['localinput', localinput],
  ['view', view],
]

describe('@tapkart/game barrel', () => {
  it('re-exports every listed module with no name collisions', () => {
    const owner = new Map<string, string>()
    const clashes: string[] = []
    for (const [name, mod] of MODULES) {
      for (const key of Object.keys(mod)) {
        const prev = owner.get(key)
        if (prev !== undefined) clashes.push(`${key}: ${prev} and ${name}`)
        else owner.set(key, name)
      }
    }
    expect(clashes).toEqual([])
    for (const key of owner.keys()) expect(Object.keys(barrel)).toContain(key)
  })

  it('does NOT re-export either DOM adapter (§8.2)', () => {
    // A barrel that re-exported shell.ts or controls/source.ts would pull DOM
    // listeners — and, through the render barrel's sibling mistake, `three` and
    // a WebGL context — into every headless test in the repository. The failure
    // then shows up as an unrelated suite breaking.
    const keys = Object.keys(barrel)
    for (const forbidden of ['startShell', 'attachInputSource', 'requestTiltPermission']) {
      expect(keys).not.toContain(forbidden)
    }
    // …and not the sub-adapters either, which reach the outside world only
    // through makeControlAdapter.
    for (const forbidden of ['makeThumbZonesAdapter', 'makeVirtualStickAdapter', 'makeKeyboardAdapter']) {
      expect(keys).not.toContain(forbidden)
    }
    expect(keys).toContain('makeControlAdapter')
    expect(keys).toContain('createSession')
    expect(keys).toContain('createViewBuilder')
    expect(keys).toContain('buildResultRows')
  })
})
