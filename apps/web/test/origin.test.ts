import { describe, expect, it } from 'vitest'
import { chooseOrigin, stripTrailingSlash } from '../src/pwa/origin'

describe('stripTrailingSlash', () => {
  it('removes one trailing slash', () => {
    expect(stripTrailingSlash('https://tapkart.example/')).toBe('https://tapkart.example')
  })

  it('leaves an origin without one alone', () => {
    expect(stripTrailingSlash('https://tapkart.example')).toBe('https://tapkart.example')
  })

  it("leaves '' as ''", () => {
    expect(stripTrailingSlash('')).toBe('')
  })

  it('does not trim whitespace — that is chooseOrigin\'s job, not this one\'s', () => {
    expect(stripTrailingSlash('  https://tapkart.example  ')).toBe('  https://tapkart.example  ')
  })
})

describe('chooseOrigin — C-3, as a function (contract §10.3)', () => {
  it('takes location.origin in a browser, so a self-hoster rebuilds nothing', () => {
    expect(chooseOrigin(false, 'https://tapkart.example', 'https://kart.example.com')).toBe(
      'https://kart.example.com',
    )
  })

  it('ignores an absent build origin in a browser', () => {
    expect(chooseOrigin(false, '', 'https://kart.example.com')).toBe('https://kart.example.com')
  })

  /** Inside the Capacitor WebView `location.origin` is the WebView's local
   *  scheme. Taking it here would put an invite URI nobody can open into the
   *  NDEF record, on the only device that has HCE. */
  it('takes the baked build origin in the native WebView', () => {
    expect(chooseOrigin(true, 'https://tapkart.example', 'https://localhost')).toBe(
      'https://tapkart.example',
    )
  })

  it('throws when native and the build origin is empty', () => {
    expect(() => chooseOrigin(true, '', 'https://localhost')).toThrow(
      'chooseOrigin: native build has no TAPKART_ORIGIN',
    )
  })

  it('throws when native and the build origin is whitespace, which is what an empty .env line leaves', () => {
    expect(() => chooseOrigin(true, '   ', 'https://localhost')).toThrow(
      'chooseOrigin: native build has no TAPKART_ORIGIN',
    )
  })

  it('throws when native and the build origin is a bare slash', () => {
    expect(() => chooseOrigin(true, '/', 'https://localhost')).toThrow(
      'chooseOrigin: native build has no TAPKART_ORIGIN',
    )
  })

  it('strips a trailing slash on both paths', () => {
    expect(chooseOrigin(false, '', 'https://kart.example.com/')).toBe('https://kart.example.com')
    expect(chooseOrigin(true, 'https://tapkart.example/', 'https://localhost')).toBe(
      'https://tapkart.example',
    )
  })
})
