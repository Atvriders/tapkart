import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import * as pngModule from '../tools/png.mjs'
import { drawIconRgba, encodePng } from '../tools/png.mjs'

const PALETTE = { background: [0x0b, 0x0d, 0x10], foreground: [0x6c, 0xe6, 0xff], inset: 0 }
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>>
    0
  )
}

interface Chunk {
  type: string
  data: Uint8Array
  crc: number
  crcOverTypeAndData: number
}

function chunks(png: Uint8Array): Chunk[] {
  const out: Chunk[] = []
  let at = 8
  while (at < png.length) {
    const length = readU32(png, at)
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7])
    const data = png.subarray(at + 8, at + 8 + length)
    const crc = readU32(png, at + 8 + length)
    out.push({
      type,
      data,
      crc,
      crcOverTypeAndData: crc32(png.subarray(at + 4, at + 8 + length)),
    })
    at += 12 + length
  }
  return out
}

describe('png tool surface', () => {
  it('exports exactly the two pure functions fixed by §16', () => {
    expect(Object.keys(pngModule).sort()).toEqual(['drawIconRgba', 'encodePng'])
  })
})

describe('encodePng', () => {
  it('starts with the PNG signature', () => {
    const png = encodePng(2, 2, new Uint8Array(2 * 2 * 4))
    expect([...png.subarray(0, 8)]).toEqual(SIGNATURE)
  })

  it('emits IHDR, IDAT, and IEND in order and nothing else', () => {
    const png = encodePng(4, 4, new Uint8Array(4 * 4 * 4))
    expect(chunks(png).map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
  })

  it('writes an 8-bit RGBA, filterable, non-interlaced IHDR', () => {
    const ihdr = chunks(encodePng(192, 96, new Uint8Array(192 * 96 * 4)))[0]
    expect(readU32(ihdr.data, 0)).toBe(192)
    expect(readU32(ihdr.data, 4)).toBe(96)
    expect([...ihdr.data.subarray(8)]).toEqual([8, 6, 0, 0, 0])
  })

  it('gets every chunk CRC right against an independent implementation', () => {
    for (const chunk of chunks(encodePng(8, 8, drawIconRgba(8, PALETTE)))) {
      expect(chunk.crc).toBe(chunk.crcOverTypeAndData)
    }
  })

  it('round-trips pixels as filter-0 scanlines', () => {
    const rgba = new Uint8Array(2 * 2 * 4)
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 7) & 0xff
    const idat = chunks(encodePng(2, 2, rgba)).find((chunk) => chunk.type === 'IDAT')!
    const raw = inflateSync(Buffer.from(idat.data))
    expect(raw.length).toBe(2 * (1 + 2 * 4))
    expect(raw[0]).toBe(0)
    expect([...raw.subarray(1, 9)]).toEqual([...rgba.subarray(0, 8)])
    expect(raw[9]).toBe(0)
    expect([...raw.subarray(10, 18)]).toEqual([...rgba.subarray(8, 16)])
  })

  it('throws when the pixel buffer is not width*height*4', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(
      'encodePng: expected 16 bytes, got 15',
    )
  })
})

describe('drawIconRgba', () => {
  it('returns exactly size*size*4 bytes', () => {
    for (const size of [192, 512]) expect(drawIconRgba(size, PALETTE)).toHaveLength(size * size * 4)
  })

  it('is byte-deterministic', () => {
    expect([...drawIconRgba(64, PALETTE)]).toEqual([...drawIconRgba(64, PALETTE)])
  })

  it('is fully opaque everywhere', () => {
    const rgba = drawIconRgba(32, PALETTE)
    for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(255)
  })

  it('paints the corner with the background colour', () => {
    const rgba = drawIconRgba(64, PALETTE)
    expect([rgba[0], rgba[1], rgba[2]]).toEqual(PALETTE.background)
  })

  it('paints a meaningful area with the foreground colour', () => {
    const rgba = drawIconRgba(128, PALETTE)
    let foreground = 0
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] === PALETTE.foreground[0] && rgba[i + 1] === PALETTE.foreground[1]) foreground++
    }
    expect(foreground).toBeGreaterThan(128)
  })

  it('keeps the maskable inset clear', () => {
    const size = 128
    const inset = 0.1
    const rgba = drawIconRgba(size, { ...PALETTE, inset })
    const margin = Math.floor(size * inset)
    const isBackground = (x: number, y: number) => {
      const at = (y * size + x) * 4
      return rgba[at] === PALETTE.background[0] && rgba[at + 1] === PALETTE.background[1]
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < margin; y++) {
        expect(isBackground(x, y)).toBe(true)
        expect(isBackground(x, size - 1 - y)).toBe(true)
        expect(isBackground(y, x)).toBe(true)
        expect(isBackground(size - 1 - y, x)).toBe(true)
      }
    }
  })
})
