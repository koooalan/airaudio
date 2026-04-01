import { contextBridge, ipcRenderer } from 'electron'
import type { DeviceInfo, ConnectionState } from '../shared/types.js'

export type AppState = {
  devices: DeviceInfo[]
  state: ConnectionState
  connectedDeviceId: string | null
  latencySeconds: number
  syncOffsetMs: number
}

const api = {
  getState: (): Promise<AppState> =>
    ipcRenderer.invoke('get-state'),

  connect: (deviceId: string, volume: number): Promise<void> =>
    ipcRenderer.invoke('connect', deviceId, volume),

  disconnect: (): Promise<void> =>
    ipcRenderer.invoke('disconnect'),

  setVolume: (volumePct: number): Promise<void> =>
    ipcRenderer.invoke('set-volume', volumePct),

  /** Set streaming latency in seconds (0.5–2.0). Takes effect on next connection. */
  setLatency: (seconds: number): Promise<void> =>
    ipcRenderer.invoke('set-latency', seconds),

  /** Set AV sync offset in ms (-500 to +500). Trims video delay relative to audio latency. */
  setSyncOffset: (ms: number): Promise<void> =>
    ipcRenderer.invoke('set-sync-offset', ms),

  /** Save a custom name for a device. Pass empty string to revert to mDNS name. */
  renameDevice: (deviceId: string, name: string): Promise<void> =>
    ipcRenderer.invoke('rename-device', deviceId, name),

  /** Pin or unpin a device to float it to the top of the list. */
  pinDevice: (deviceId: string, pinned: boolean): Promise<void> =>
    ipcRenderer.invoke('pin-device', deviceId, pinned),

  /** Get a desktop source ID so the renderer can call getDisplayMedia for loopback audio. */
  getDesktopSourceId: (): Promise<string | null> =>
    ipcRenderer.invoke('get-desktop-source-id'),

  /** Open the AV Sync browser extension folder in File Explorer. */
  openExtensionFolder: (): Promise<string> =>
    ipcRenderer.invoke('open-extension-folder'),

  /** Send a raw Int16 PCM buffer to the main process for RAOP streaming. */
  sendPcmChunk: (chunk: ArrayBuffer): void =>
    ipcRenderer.send('pcm-chunk', Buffer.from(chunk)),

  onDevicesUpdated: (cb: (devices: DeviceInfo[]) => void) => {
    const handler = (_: unknown, devices: DeviceInfo[]) => cb(devices)
    ipcRenderer.on('devices-updated', handler)
    return () => ipcRenderer.removeListener('devices-updated', handler)
  },

  onStateChanged: (cb: (s: Partial<AppState> & { error?: string }) => void) => {
    const handler = (_: unknown, s: Partial<AppState> & { error?: string }) => cb(s)
    ipcRenderer.on('state-changed', handler)
    return () => ipcRenderer.removeListener('state-changed', handler)
  },

  onStopCapture: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('stop-capture', handler)
    return () => ipcRenderer.removeListener('stop-capture', handler)
  },

  onSyncOffsetChanged: (cb: (ms: number) => void) => {
    const handler = (_: unknown, ms: number) => cb(ms)
    ipcRenderer.on('sync-offset-changed', handler)
    return () => ipcRenderer.removeListener('sync-offset-changed', handler)
  },
}

contextBridge.exposeInMainWorld('airAudio', api)

export type AirAudioAPI = typeof api
