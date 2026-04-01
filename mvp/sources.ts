/**
 * AudioSource implementations for the AirAudio MVP.
 *
 * FileAudioSource   – decodes any audio file via ffmpeg → raw PCM s16le 44100 stereo
 * LoopbackSource    – captures Windows system audio (WASAPI loopback) via ffmpeg
 */

import { ChildProcess, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { type AudioSource, AUDIO_BYTES_PER_CHANNEL, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE } from '@basmilius/apple-common'
// @ts-ignore – ffmpeg-static is a CommonJS package that exports the binary path
import ffmpegPath from 'ffmpeg-static'

const BYTES_PER_FRAME = AUDIO_CHANNELS * AUDIO_BYTES_PER_CHANNEL // 4

/** Shared base: spawns ffmpeg and provides frame-by-frame reading. */
abstract class FfmpegSource implements AudioSource {
  protected proc: ChildProcess | null = null
  protected leftover: Buffer = Buffer.alloc(0)
  protected _duration = 0
  private done = false

  get duration(): number {
    return this._duration
  }

  abstract buildArgs(): string[]

  async start(): Promise<void> {
    this.done = false
    this.leftover = Buffer.alloc(0)

    const args = this.buildArgs()
    this.proc = spawn(ffmpegPath as string, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    // Collect stderr for error reporting
    const stderrLines: string[] = []
    this.proc.stderr?.on('data', (d: Buffer) => stderrLines.push(d.toString()))
    this.proc.on('error', (err) => { throw new Error(`ffmpeg spawn failed: ${err.message}`) })

    // Log stderr and exit always for diagnostics
    this.proc.on('exit', (code, signal) => {
      console.error(`[ffmpeg] process exited — code=${code} signal=${signal}`)
    })

    // Keep stdout in PAUSED mode — use 'readable' not 'data' to avoid switching to flowing mode
    const gotData = await new Promise<boolean>((resolve) => {
      const onReadable = () => { this.proc?.stdout?.removeListener('readable', onReadable); console.error('[ffmpeg] first readable — ffmpeg is producing data'); resolve(true) }
      this.proc?.stdout?.once('readable', onReadable)
      this.proc?.once('exit', () => resolve(false))
    })

    // Always flush stderr so we can see ffmpeg warnings even on success
    console.error('[ffmpeg] stderr:\n' + stderrLines.join('').trim())

    if (!gotData) {
      const errMsg = stderrLines.join('').trim()
      throw new Error(
        `Audio capture device failed to open.\n` +
        `ffmpeg output:\n${errMsg}\n\n` +
        `Fix options:\n` +
        `  1. Enable Stereo Mix: right-click speaker icon → Sounds → Recording tab\n` +
        `     → right-click empty area → Show Disabled Devices → enable Stereo Mix\n` +
        `  2. Install VB-Audio Virtual Cable (free): https://vb-audio.com/Cable/\n` +
        `     Then use: npm run mvp -- --device-name "CABLE Output (VB-Audio Virtual Cable)"\n` +
        `  3. Test the protocol with a file: npm run mvp -- --file song.mp3`
      )
    }
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
    this.done = false
  }

  async reset(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async readFrames(count: number): Promise<Buffer | null> {
    if (this.done || !this.proc) return null

    const needed = count * BYTES_PER_FRAME
    return this.readExact(needed)
  }

  private readExact(needed: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const tryRead = () => {
        // Drain whatever is currently in the internal buffer (paused mode)
        while (this.leftover.length < needed) {
          const chunk = this.proc?.stdout?.read() as Buffer | null
          if (!chunk) break
          this.leftover = Buffer.concat([this.leftover, chunk])
        }

        if (this.leftover.length >= needed) {
          const out = Buffer.from(this.leftover.subarray(0, needed))
          this.leftover = this.leftover.subarray(needed)
          resolve(out)
          return
        }

        if (!this.proc?.stdout) {
          console.error('[readExact] proc.stdout is null — resolving null')
          resolve(null)
          return
        }

        const onReadable = () => { cleanup(); tryRead() }
        const onEnd = () => {
          cleanup()
          this.done = true
          console.error(`[readExact] stream ended — leftover=${this.leftover.length} needed=${needed}`)
          if (this.leftover.length > 0) {
            const padded = Buffer.alloc(needed, 0)
            this.leftover.copy(padded)
            this.leftover = Buffer.alloc(0)
            resolve(padded)
          } else {
            resolve(null)
          }
        }

        const cleanup = () => {
          this.proc?.stdout?.removeListener('readable', onReadable)
          this.proc?.stdout?.removeListener('end', onEnd)
        }

        this.proc.stdout.once('readable', onReadable)
        this.proc.stdout.once('end', onEnd)
      }

      tryRead()
    })
  }
}

/**
 * Streams audio from a file (MP3, FLAC, WAV, AAC, etc.).
 * Useful for testing the RAOP protocol pipeline.
 */
export class FileAudioSource extends FfmpegSource {
  constructor(private readonly filePath: string) {
    super()
    // Estimate duration from file size (rough — used only for display)
    try {
      const bytes = statSync(filePath).size
      this._duration = bytes / (AUDIO_SAMPLE_RATE * BYTES_PER_FRAME)
    } catch {
      this._duration = 0
    }
  }

  buildArgs(): string[] {
    return [
      '-i', this.filePath,
      '-f', 's16le',
      '-ar', String(AUDIO_SAMPLE_RATE),
      '-ac', String(AUDIO_CHANNELS),
      '-acodec', 'pcm_s16le',
      '-loglevel', 'error',
      'pipe:1',
    ]
  }
}

/**
 * Captures Windows system audio via DirectShow.
 *
 * NOTE: ffmpeg-static only includes DirectShow (dshow), not WASAPI.
 * For system audio loopback you need either:
 *   - "Stereo Mix" enabled in Windows sound settings (right-click speaker icon →
 *     Sounds → Recording tab → right-click empty area → Show Disabled Devices →
 *     enable Stereo Mix)
 *   - OR VB-Audio Virtual Cable (free): https://vb-audio.com/Cable/
 *
 * Use `npm run mvp -- --list-devices` to see available audio devices.
 * Use `npm run mvp -- --device-name "Stereo Mix"` to pick a specific device.
 *
 * For the Electron app, system audio is captured via Chromium's built-in
 * WASAPI loopback (no extra software needed).
 */
export class LoopbackSource extends FfmpegSource {
  constructor(private readonly deviceName = 'Stereo Mix') {
    super()
    // Infinity causes RTSP SET_PARAMETER progress to send "Infinity" as a timestamp,
    // which devices reject with 456. Use 0 so end=start (valid no-op for live streams).
    this._duration = 0
  }

  buildArgs(): string[] {
    return [
      '-f', 'dshow',
      '-i', `audio=${this.deviceName}`,
      '-f', 's16le',
      '-ar', String(AUDIO_SAMPLE_RATE),
      '-ac', String(AUDIO_CHANNELS),
      '-acodec', 'pcm_s16le',
      '-loglevel', 'error',
      'pipe:1',
    ]
  }
}

/** Lists available DirectShow audio capture devices. */
export async function listAudioDevices(): Promise<string[]> {
  // @ts-ignore
  const ffmpegPath = (await import('ffmpeg-static')).default as string
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(ffmpegPath, [
    '-f', 'dshow',
    '-list_devices', 'true',
    '-i', 'dummy',
    '-hide_banner',
  ], { encoding: 'utf8' })
  const output = result.stdout + result.stderr
  const names: string[] = []
  for (const line of output.split('\n')) {
    const m = line.match(/"([^"]+)"\s+\(audio\)/)
    if (m) names.push(m[1])
  }
  return names
}
