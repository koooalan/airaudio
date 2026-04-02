/**
 * WASAPI loopback audio source for the Electron main process.
 * Uses ffmpeg-static to capture system audio output as raw PCM.
 */

import { ChildProcess, spawn } from 'node:child_process'
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { type AudioSource, AUDIO_BYTES_PER_CHANNEL, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE } from '@basmilius/apple-common'
// @ts-ignore
import ffmpegStaticPath from 'ffmpeg-static'

const BYTES_PER_FRAME = AUDIO_CHANNELS * AUDIO_BYTES_PER_CHANNEL

/** Resolve ffmpeg binary path — prefer the bundled resource in production. */
function resolveFfmpeg(): string {
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'ffmpeg.exe')
    if (existsSync(bundled)) return bundled
  }
  return ffmpegStaticPath as string
}

export class LoopbackSource implements AudioSource {
  private proc: ChildProcess | null = null
  private leftover: Buffer = Buffer.alloc(0)
  private done = false

  get duration(): number {
    return Infinity
  }

  async start(): Promise<void> {
    this.done = false
    this.leftover = Buffer.alloc(0)

    const ffmpeg = resolveFfmpeg()
    this.proc = spawn(ffmpeg, [
      '-f', 'wasapi',
      '-loopback', '1',
      '-audio_buffer_size', '10',
      '-i', 'default',
      '-f', 's16le',
      '-ar', String(AUDIO_SAMPLE_RATE),
      '-ac', String(AUDIO_CHANNELS),
      '-acodec', 'pcm_s16le',
      '-loglevel', 'error',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    this.proc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim()
      if (msg) console.error('[ffmpeg]', msg)
    })
    this.proc.on('error', (err) => console.error('[ffmpeg] spawn error:', err.message))

    // Wait for first data before signalling ready
    await new Promise<void>((resolve) => {
      const onData = () => { this.proc?.stdout?.removeListener('data', onData); resolve() }
      this.proc?.stdout?.once('data', onData)
      this.proc?.once('exit', resolve)
    })
  }

  async stop(): Promise<void> {
    this.proc?.kill('SIGTERM')
    this.proc = null
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
        if (this.leftover.length >= needed) {
          const chunk = this.leftover.subarray(0, needed)
          this.leftover = this.leftover.subarray(needed)
          resolve(chunk)
          return
        }
        if (!this.proc?.stdout) { resolve(null); return }

        const onData = (chunk: Buffer) => {
          this.leftover = Buffer.concat([this.leftover, chunk])
          cleanup(); tryRead()
        }
        const onEnd = () => {
          cleanup()
          this.done = true
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
          this.proc?.stdout?.removeListener('data', onData)
          this.proc?.stdout?.removeListener('end', onEnd)
        }
        this.proc.stdout.once('data', onData)
        this.proc.stdout.once('end', onEnd)
      }
      tryRead()
    })
  }
}
