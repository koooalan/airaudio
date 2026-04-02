/**
 * AudioWorkletProcessor that converts Float32 WebAudio frames to Int16 PCM
 * and posts them to the main thread for IPC transfer to the RAOP streaming loop.
 *
 * Accumulates 352 frames (one RAOP packet) before posting to reduce IPC calls.
 * AUDIO_FRAMES_PER_PACKET = 352 (from @basmilius/apple-common)
 */

const FRAMES_PER_PACKET = 352
const CHANNELS = 2

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf = new Int16Array(FRAMES_PER_PACKET * CHANNELS)
    this._pos = 0  // frames written into _buf
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const left  = input[0] ?? new Float32Array(128)
    const right = input[1] ?? input[0] ?? new Float32Array(128)  // mono fallback

    for (let i = 0; i < left.length; i++) {
      const dl = Math.random() + Math.random() - 1  // TPDF triangular dither
      const dr = Math.random() + Math.random() - 1
      this._buf[this._pos * CHANNELS]     = Math.round(Math.max(-32768, Math.min(32767, left[i]  * 32768 + dl)))
      this._buf[this._pos * CHANNELS + 1] = Math.round(Math.max(-32768, Math.min(32767, right[i] * 32768 + dr)))
      this._pos++

      if (this._pos >= FRAMES_PER_PACKET) {
        // Transfer the buffer (zero-copy) to the main thread
        this.port.postMessage(this._buf.buffer, [this._buf.buffer])
        this._buf = new Int16Array(FRAMES_PER_PACKET * CHANNELS)
        this._pos = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
