/**
 * Manages system audio capture in the Electron renderer process.
 *
 * Uses Electron's desktopCapturer + Chromium's WASAPI loopback (via
 * setDisplayMediaRequestHandler in the main process) to capture system audio,
 * then processes it via an AudioWorklet and sends Int16 PCM to the main process
 * via IPC for RAOP streaming.
 *
 * Also supports capturing from a specific audio input device (microphone,
 * virtual audio cable, etc.) via getUserMedia.
 */

// @ts-ignore – Vite `?url` query import, not recognized by tsc but works at runtime
import workletUrl from './worklet-processor.js?url'

export interface AudioSourceInfo {
  id: string
  label: string
  isLoopback: boolean
}

let audioCtx: AudioContext | null = null
let workletNode: AudioWorkletNode | null = null
let mediaStream: MediaStream | null = null
let muteGain: GainNode | null = null
let isMuted = false
let currentSourceId: string | null = null  // null / 'loopback' = WASAPI loopback

/** Enumerate available audio sources: system loopback + all audioinput devices. */
export async function getAudioSources(): Promise<AudioSourceInfo[]> {
  // Attempt a quick getUserMedia to unlock device labels (browser requires
  // prior permission before labels are revealed). Ignore errors silently.
  if (!mediaStream) {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
    if (tmp) for (const t of tmp.getTracks()) t.stop()
  }

  const all = await navigator.mediaDevices.enumerateDevices()
  const inputs = all
    .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d) => ({
      id: d.deviceId,
      label: d.label || `Input ${d.deviceId.slice(0, 8)}`,
      isLoopback: false,
    }))

  return [{ id: 'loopback', label: 'System Audio', isLoopback: true }, ...inputs]
}

/** Start capturing audio and sending PCM chunks to the main process. */
export async function startCapture(sourceId: string | null = null): Promise<void> {
  if (audioCtx) return  // already running

  currentSourceId = sourceId

  let stream: MediaStream
  if (!sourceId || sourceId === 'loopback') {
    // WASAPI system loopback via Chromium's getDisplayMedia + 'loopback' audio
    await window.airAudio.getDesktopSourceId()
    stream = await (navigator.mediaDevices as MediaDevices & {
      getDisplayMedia: (c: object) => Promise<MediaStream>
    }).getDisplayMedia({ video: { frameRate: 1 }, audio: true })
  } else {
    // Specific input device — disable all processing so audio stays bit-perfect
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: sourceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100,
      },
      video: false,
    })
  }

  mediaStream = stream
  audioCtx = new AudioContext({ sampleRate: 44100 })
  await audioCtx.audioWorklet.addModule(workletUrl)

  const source = audioCtx.createMediaStreamSource(mediaStream)
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture')

  workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    window.airAudio.sendPcmChunk(e.data)
  }

  // Mute gate — set gain to 0 to silence the stream without stopping the graph
  muteGain = audioCtx.createGain()
  muteGain.gain.value = isMuted ? 0 : 1

  // Silent monitor — keeps the graph alive without playing audio to local speakers
  const silentGain = audioCtx.createGain()
  silentGain.gain.value = 0

  source.connect(muteGain)
  muteGain.connect(workletNode)
  workletNode.connect(silentGain)
  silentGain.connect(audioCtx.destination)

  // Auto-restart if the audio track ends (default output device changed, device unplugged, etc.)
  for (const track of mediaStream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (!audioCtx) return  // was intentionally stopped — ignore
      console.warn('[capture] audio track ended — restarting in 1 s')
      stopCapture()
      setTimeout(() => startCapture(currentSourceId).catch(console.error), 1000)
    }, { once: true })
  }
}

/** Stop capturing and release all audio resources. */
export function stopCapture(): void {
  muteGain = null
  workletNode?.disconnect()
  workletNode = null

  if (audioCtx) {
    audioCtx.close()
    audioCtx = null
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop()
    mediaStream = null
  }
}

/** Restart capture with a new source (or the same source if null). */
export async function restartCapture(sourceId?: string | null): Promise<void> {
  stopCapture()
  await startCapture(sourceId ?? currentSourceId)
}

/** Mute/unmute the outgoing audio stream without disconnecting. */
export function setMuted(muted: boolean): void {
  isMuted = muted
  if (muteGain) muteGain.gain.value = muted ? 0 : 1
}

export function getMuted(): boolean { return isMuted }
export function isCapturing(): boolean { return audioCtx !== null }
