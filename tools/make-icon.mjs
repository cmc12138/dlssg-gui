/**
 * 生成应用图标（build/icon.ico + build/icon.png），不依赖任何第三方库。
 * 设计：深色圆角底 + 绿色取景框 + 播放三角，寓意「帧生成」。
 * 用法：node tools/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 256
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build')

const pixels = new Uint8Array(SIZE * SIZE * 4)

function setPixel(x, y, [r, g, b], alpha = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const index = (y * SIZE + x) * 4
  pixels[index] = r
  pixels[index + 1] = g
  pixels[index + 2] = b
  pixels[index + 3] = alpha
}

function blend(x, y, color, alpha) {
  if (alpha <= 0) return
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const index = (y * SIZE + x) * 4
  const a = Math.min(1, alpha)
  pixels[index] = Math.round(pixels[index] * (1 - a) + color[0] * a)
  pixels[index + 1] = Math.round(pixels[index + 1] * (1 - a) + color[1] * a)
  pixels[index + 2] = Math.round(pixels[index + 2] * (1 - a) + color[2] * a)
  pixels[index + 3] = Math.max(pixels[index + 3], Math.round(255 * a))
}

/** 带抗锯齿的圆角矩形填充（signed distance 近似）。 */
function roundedRect(x0, y0, x1, y1, radius, color, feather = 1.2) {
  for (let y = Math.floor(y0 - 2); y <= Math.ceil(y1 + 2); y += 1) {
    for (let x = Math.floor(x0 - 2); x <= Math.ceil(x1 + 2); x += 1) {
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius))
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius))
      const distance = Math.hypot(dx, dy) - radius
      const alpha = Math.min(1, Math.max(0, 0.5 - distance / feather))
      if (alpha > 0) blend(x, y, color, alpha)
    }
  }
}

function roundedRectRing(x0, y0, x1, y1, radius, thickness, color) {
  roundedRect(x0, y0, x1, y1, radius, color)
  // 用背景色挖出内框，形成描边
  for (let y = Math.floor(y0 + thickness); y <= Math.ceil(y1 - thickness); y += 1) {
    for (let x = Math.floor(x0 + thickness); x <= Math.ceil(x1 - thickness); x += 1) {
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius))
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius))
      const distance = Math.hypot(dx, dy) - radius
      const inner = Math.min(1, Math.max(0, 0.5 - (distance + thickness) / 1.2))
      if (inner > 0) blend(x, y, [13, 16, 20], inner)
    }
  }
}

function triangle(ax, ay, bx, by, cx, cy, color) {
  const minX = Math.min(ax, bx, cx) - 2
  const maxX = Math.max(ax, bx, cx) + 2
  const minY = Math.min(ay, by, cy) - 2
  const maxY = Math.max(ay, by, cy) + 2
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry)
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y += 1) {
    for (let x = Math.floor(minX); x <= Math.ceil(maxX); x += 1) {
      const d1 = sign(x, y, ax, ay, bx, by)
      const d2 = sign(x, y, bx, by, cx, cy)
      const d3 = sign(x, y, cx, cy, ax, ay)
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0
      if (!(hasNeg && hasPos)) blend(x, y, color, 1)
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuffer = Buffer.from(type, 'latin1')
  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crcBuffer])
}

function encodePng() {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0
    Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function encodeIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry[0] = 0
  entry[1] = 0
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, png])
}

// ── 画图 ────────────────────────────────────────────────
for (let y = 0; y < SIZE; y += 1) {
  const t = y / (SIZE - 1)
  const color = [Math.round(15 + 12 * t), Math.round(20 + 16 * t), Math.round(26 + 20 * t)]
  for (let x = 0; x < SIZE; x += 1) setPixel(x, y, color, 255)
}
roundedRectRing(46, 46, 210, 210, 40, 11, [118, 185, 0], 1.3)
triangle(112, 92, 112, 164, 172, 128, [163, 230, 53])
roundedRect(88, 176, 168, 186, 5, [118, 185, 0])

const png = encodePng()
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'icon.png'), png)
writeFileSync(join(outDir, 'icon.ico'), encodeIco(png))
console.log(`icon.png ${png.length} bytes, icon.ico written to ${outDir}`)
