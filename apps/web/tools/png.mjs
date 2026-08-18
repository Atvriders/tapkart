// Pure PNG/icon functions plus the direct-run writer used by predev/build.

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < table.length; n++) {
    let value = n
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[n] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function u32(value) {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function chunk(type, data) {
  const typeBytes = Uint8Array.from([...type].map((character) => character.charCodeAt(0)))
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes)
  body.set(data, typeBytes.length)
  const out = new Uint8Array(4 + body.length + 4)
  out.set(u32(data.length))
  out.set(body, 4)
  out.set(u32(crc32(body)), 4 + body.length)
  return out
}

function concat(parts) {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Encodes 8-bit RGBA with filter-0 scanlines and no interlace. */
export function encodePng(width, height, rgba) {
  const expected = width * height * 4
  if (rgba.length !== expected) {
    throw new Error(`encodePng: expected ${expected} bytes, got ${rgba.length}`)
  }

  const stride = 1 + width * 4
  const raw = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const to = y * stride
    raw[to] = 0
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), to + 1)
  }

  const ihdr = new Uint8Array(13)
  ihdr.set(u32(width), 0)
  ihdr.set(u32(height), 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw), { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ])
}

/** Draws the deterministic Tapkart signal mark. `inset` reserves Android's
 * maskable crop margin without making Android resources an owner of this tool.
 */
export function drawIconRgba(size, palette) {
  const { background, foreground, inset } = palette
  const rgba = new Uint8Array(size * size * 4)

  const put = (x, y, colour) => {
    const at = (y * size + x) * 4
    rgba[at] = colour[0]
    rgba[at + 1] = colour[1]
    rgba[at + 2] = colour[2]
    rgba[at + 3] = 255
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) put(x, y, background)
  }

  const safe = size * (1 - 2 * inset)
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  const discRadius = safe * 0.16
  const arcs = [
    { radius: safe * 0.28, width: safe * 0.055 },
    { radius: safe * 0.42, width: safe * 0.055 },
  ]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance <= discRadius) {
        put(x, y, foreground)
        continue
      }
      if (dx <= 0) continue
      for (const arc of arcs) {
        if (Math.abs(distance - arc.radius) <= arc.width / 2 && Math.abs(dy) <= dx * 1.2) {
          put(x, y, foreground)
          break
        }
      }
    }
  }

  return rgba
}

const ICONS = [
  { file: 'icon-192.png', size: 192, inset: 0 },
  { file: 'icon-512.png', size: 512, inset: 0 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.1 },
]
const PALETTE = { background: [0x0b, 0x0d, 0x10], foreground: [0x6c, 0xe6, 0xff] }

function writeIcons(outDir) {
  mkdirSync(outDir, { recursive: true })
  for (const icon of ICONS) {
    const rgba = drawIconRgba(icon.size, { ...PALETTE, inset: icon.inset })
    writeFileSync(`${outDir}/${icon.file}`, encodePng(icon.size, icon.size, rgba))
    console.log(`wrote ${outDir}/${icon.file} (${icon.size}x${icon.size})`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeIcons(fileURLToPath(new URL('../public/icons', import.meta.url)))
}
