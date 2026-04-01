/**
 * Quick test: stream a file to OD-11 using @lox-audioserver/node-airplay-sender
 * which handles ALAC encoding + AES encryption properly.
 *
 * Usage: tsx mvp/test-lox.ts
 */

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
// Force CJS path — the package's ESM build has a bug (CJS syntax in ESM file)
const { start } = require('@lox-audioserver/node-airplay-sender')
import { spawn } from 'node:child_process'
// @ts-ignore
import ffmpegPath from 'ffmpeg-static'

const HOST = '192.168.8.43'
const PORT = 7000
const FILE = process.argv[2] ?? 'C:\\Users\\hernm\\My Drive\\WUU ZAA\\AirAudio\\coldplay.mp3'

console.log(`Connecting to ${HOST}:${PORT}...`)

const sender = start(
  { host: HOST, port: PORT, airplay2: true },
  (event: unknown) => console.log('[event]', JSON.stringify(event)),
)

sender.setVolume(80)
sender.setTrackInfo('Test', 'AirAudio', 'Test')

// Give sender a moment to connect, then start streaming
await new Promise(r => setTimeout(r, 1000))

console.log(`Streaming: ${FILE}`)

// Use ffmpeg to decode file to raw s16le PCM at real-time speed, pipe into sendPcm
// -re reads input at native frame rate (1x speed) so we don't overflow the sender's buffer
const proc = spawn(ffmpegPath as string, [
  '-re',
  '-i', FILE,
  '-f', 's16le',
  '-ar', '44100',
  '-ac', '2',
  '-acodec', 'pcm_s16le',
  'pipe:1',
], { stdio: ['ignore', 'pipe', 'inherit'] })

proc.stdout?.on('data', (chunk: Buffer) => {
  sender.sendPcm(chunk)
})

proc.on('exit', () => {
  console.log('File ended — stopping.')
  sender.stop()
  process.exit(0)
})

process.on('SIGINT', () => {
  proc.kill()
  sender.stop()
  process.exit(0)
})
