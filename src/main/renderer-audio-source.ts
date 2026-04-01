/**
 * AudioSource implementation fed by PCM chunks from the renderer process via IPC.
 *
 * The renderer captures system audio via desktopCapturer + AudioWorklet and sends
 * Int16 PCM frames here. The RAOP streaming loop pulls from this queue via readFrames().
 */

import { type AudioSource, AUDIO_BYTES_PER_CHANNEL, AUDIO_CHANNELS } from '@basmilius/apple-common'

const BYTES_PER_FRAME = AUDIO_CHANNELS * AUDIO_BYTES_PER_CHANNEL // 4

// Maximum buffered PCM before dropping oldest data (~500 ms at 44100 Hz stereo s16le).
// Prevents stale audio backlog from playing as sped-up / distorted audio.
const MAX_BUFFERED_BYTES = 44100 * BYTES_PER_FRAME * 0.5

export class RendererAudioSource implements AudioSource {
  private queue: Buffer[] = []
  private buffered = 0                       // total bytes available in queue
  private waiters: Array<() => void> = []    // pending readFrames() callers
  private _stopped = false

  get duration(): number { return 0 } // Live stream — Infinity breaks RTSP progress timestamp encoding

  async start(): Promise<void> {
    this._stopped = false
    this.queue = []
    this.buffered = 0
  }

  async stop(): Promise<void> {
    this._stopped = true
    // Wake any stuck readFrames() calls so they can return null
    for (const w of this.waiters) w()
    this.waiters = []
  }

  async reset(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /** Called from IPC handler when the renderer sends a PCM chunk. */
  feed(chunk: Buffer | Uint8Array): void {
    if (this._stopped) return
    // Electron IPC may deserialize as Uint8Array rather than Buffer — normalise
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.queue.push(buf)
    this.buffered += buf.length
    // Drop oldest chunks if queue has grown beyond ~500 ms — this keeps playback
    // in sync with real-time and avoids the sped-up / distorted audio artifact
    // that occurs when a backlog of stale packets is flushed in one burst.
    while (this.buffered > MAX_BUFFERED_BYTES) {
      const dropped = this.queue.shift()!
      this.buffered -= dropped.length
    }
    // Wake waiters that may now have enough data
    while (this.waiters.length > 0 && this.buffered >= BYTES_PER_FRAME) {
      this.waiters.shift()!()
    }
  }

  async readFrames(count: number): Promise<Buffer | null> {
    const needed = count * BYTES_PER_FRAME

    while (!this._stopped && this.buffered < needed) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }

    if (this._stopped) return null

    // Drain exactly `needed` bytes from the queue
    const out = Buffer.alloc(needed)
    let written = 0
    while (written < needed) {
      const head = this.queue[0]!
      const take = Math.min(head.length, needed - written)
      head.copy(out, written, 0, take)
      written += take
      if (take === head.length) {
        this.queue.shift()
        this.buffered -= take
      } else {
        // Partial consume — trim the head
        this.queue[0] = head.subarray(take)
        this.buffered -= take
      }
    }
    return out
  }
}
