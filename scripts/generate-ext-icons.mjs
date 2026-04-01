/**
 * Resizes assets/icon.png into the three PNG sizes required by the
 * AirAudio AV Sync browser extension.
 *
 * Output: extension/icon-16.png, icon-48.png, icon-128.png
 *
 * Run: node scripts/generate-ext-icons.mjs
 */

import { Jimp } from 'jimp'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src    = join(__dirname, '../assets/icon.png')
const outDir = join(__dirname, '../extension')

mkdirSync(outDir, { recursive: true })

const image = await Jimp.read(src)

for (const size of [16, 48, 128]) {
  const out = join(outDir, `icon-${size}.png`)
  await image.clone().resize({ w: size, h: size }).write(out)
  console.log(`✓ extension/icon-${size}.png`)
}
