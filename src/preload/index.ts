import { contextBridge, ipcRenderer } from 'electron'
import type { DeviceInfo, ConnectionState, AuthStatus, UpdateStatus } from '../shared/types.js'

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

  connect: (deviceId: string, volume: number, sourceId: string | null = null): Promise<void> =>
    ipcRenderer.invoke('connect', deviceId, volume, sourceId),

  disconnect: (): Promise<void> =>
    ipcRenderer.invoke('disconnect'),

  setVolume: (volumePct: number): Promise<void> =>
    ipcRenderer.invoke('set-volume', volumePct),

  /** Set streaming latency in seconds (0.5–2.0). Takes effect on next connection. [PREMIUM] */
  setLatency: (seconds: number): Promise<void> =>
    ipcRenderer.invoke('set-latency', seconds),

  /** Set AV sync offset in ms (-500 to +500). Trims video delay relative to audio latency. */
  setSyncOffset: (ms: number): Promise<void> =>
    ipcRenderer.invoke('set-sync-offset', ms),

  /** Save a custom name for a device. Pass empty string to revert to mDNS name. [PREMIUM] */
  renameDevice: (deviceId: string, name: string): Promise<void> =>
    ipcRenderer.invoke('rename-device', deviceId, name),

  /** Pin or unpin a device to float it to the top of the list. [PREMIUM] */
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

  // ── Auth ─────────────────────────────────────────────────────────────────

  /**
   * Push the current auth + subscription status from the renderer to the main
   * process. Called by the renderer whenever auth state or Firestore subscription
   * status changes.
   */
  reportAuthStatus: (status: AuthStatus): void =>
    ipcRenderer.send('report-auth-status', status),

  /** Get the current auth status cached in the main process. */
  getAuthStatus: (): Promise<AuthStatus> =>
    ipcRenderer.invoke('get-auth-status'),

  /** Open Stripe Checkout in the default browser to start a subscription. */
  openPurchaseUrl: (): Promise<void> =>
    ipcRenderer.invoke('open-purchase-url'),

  /** Open Stripe Customer Portal to manage or cancel a subscription. */
  openManageSubscriptionUrl: (): Promise<void> =>
    ipcRenderer.invoke('open-manage-subscription-url'),

  onAuthStatusChanged: (cb: (status: AuthStatus) => void) => {
    const handler = (_: unknown, s: AuthStatus) => cb(s)
    ipcRenderer.on('auth-status-changed', handler)
    return () => ipcRenderer.removeListener('auth-status-changed', handler)
  },

  // ── Auto-update ───────────────────────────────────────────────────────────

  /** Manually trigger an update check. */
  checkForUpdates: (): Promise<void> =>
    ipcRenderer.invoke('check-for-updates'),

  /** Accept the downloaded update and restart to install. */
  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke('install-update'),

  onUpdateStatus: (cb: (status: UpdateStatus) => void) => {
    const handler = (_: unknown, s: UpdateStatus) => cb(s)
    ipcRenderer.on('update-status', handler)
    return () => ipcRenderer.removeListener('update-status', handler)
  },

  // ── Existing event listeners ──────────────────────────────────────────────

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
