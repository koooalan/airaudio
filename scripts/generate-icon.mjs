/**
 * Converts assets/icon.png → assets/icon.ico (multi-size: 16,32,48,64,128,256px)
 * and also resizes to assets/tray-icon.png (32x32 for the Windows tray).
 *
 * Run: node scripts/generate-icon.mjs
 * Requires: jimp, png-to-ico  (npm install --save-dev jimp png-to-ico)
 */

import { Jimp } from 'jimp'
import pngToIco from 'png-to-ico'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const assetsDir = join(__dirname, '../assets')
const src = join(assetsDir, 'icon.png')

const image = await Jimp.read(src)

// --- ICO (installer + taskbar) ---
const icoSizes = [16, 32, 48, 64, 128, 256]
const pngBuffers = await Promise.all(
  icoSizes.map((size) =>
    image.clone().resize({ w: size, h: size }).getBuffer('image/png')
  )
)
const icoBuffer = await pngToIco(pngBuffers)
writeFileSync(join(assetsDir, 'icon.ico'), icoBuffer)
console.log('✓ assets/icon.ico')

// --- Tray icons (32x32 PNG — Windows system tray, one per connection state) ---
const base = image.clone().resize({ w: 32, h: 32 })
await base.write(join(assetsDir, 'tray-icon.png'))
console.log('✓ assets/tray-icon.png')

// Draw a small status-dot variant for each state
const DOT_STATES = [
  { file: 'tray-icon-streaming.png',  r: 0,   g: 255, b: 36  },  // #00ff24 green
  { file: 'tray-icon-connecting.png', r: 255, g: 214, b: 10  },  // #ffd60a yellow
  { file: 'tray-icon-error.png',      r: 255, g: 69,  b: 58  },  // #ff453a red
]

const DOT_CX = 24, DOT_CY = 24, DOT_R = 4.5, OUTLINE_R = 6

for (const { file, r: dr, g: dg, b: db } of DOT_STATES) {
  const icon = base.clone()
  const { data, width } = icon.bitmap

  for (let py = 0; py < 32; py++) {
    for (let px = 0; px < 32; px++) {
      const dist = Math.sqrt((px - DOT_CX) ** 2 + (py - DOT_CY) ** 2)
      const idx = (py * width + px) * 4

      if (dist <= OUTLINE_R) {
        // Dark outline ring so the dot is visible on any icon background
        data[idx] = 20; data[idx + 1] = 20; data[idx + 2] = 22; data[idx + 3] = 230
      }
      if (dist <= DOT_R) {
        // Coloured fill
        data[idx] = dr; data[idx + 1] = dg; data[idx + 2] = db; data[idx + 3] = 255
      }
    }
  }

  await icon.write(join(assetsDir, file))
  console.log(`✓ assets/${file}`)
}
