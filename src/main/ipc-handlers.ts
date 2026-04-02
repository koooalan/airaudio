import { app, BrowserWindow, desktopCapturer, shell, type IpcMain, session } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type RaopManager } from './raop-manager.js'
import { configStore } from './config-store.js'
import { authManager } from './auth-manager.js'
import { checkForUpdates, installUpdateOnQuit } from './update-manager.js'
import type { AuthStatus } from '../shared/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// ── Premium gate ──────────────────────────────────────────────────────────────
// Throws PREMIUM_REQUIRED when the user is not subscribed.
// The renderer catches this and opens the account/upgrade modal.
function requirePremium(): void {
  if (!authManager.isPremium()) {
    throw new Error('PREMIUM_REQUIRED')
  }
}

// ── Stripe URLs ───────────────────────────────────────────────────────────────
// TODO: replace these placeholders with your actual Stripe Checkout / portal URLs
const STRIPE_CHECKOUT_URL = 'https://your-stripe-checkout-url'
const STRIPE_PORTAL_URL   = 'https://billing.stripe.com/p/login/your-portal-id'

export function registerIpcHandlers(
  ipcMain: IpcMain,
  manager: RaopManager,
  popup: BrowserWindow,
): void {
  /** Get current device list, connection state, and settings. */
  ipcMain.handle('get-state', () => ({
    devices: manager.listDevices(),
    state: manager.state,
    connectedDeviceId: manager.connectedDeviceId,
    latencySeconds: manager.latencySeconds,
    syncOffsetMs: manager.syncOffsetMs,
    volume: manager.volume,
  }))

  /** Update streaming latency (0.5–2.0s). Takes effect on next connection. [PREMIUM] */
  ipcMain.handle('set-latency', (_event, seconds: number) => {
    requirePremium()
    manager.setLatency(Math.min(2.0, Math.max(0.5, seconds)))
  })

  /** Update AV sync offset in ms (-2500 to +2500). Applied immediately by the browser extension. */
  ipcMain.handle('set-sync-offset', (_event, ms: number) => {
    manager.setSyncOffset(Math.min(2500, Math.max(-2500, ms)))
  })

  /**
   * Save a custom display name for a device. [PREMIUM]
   * Pass an empty string to clear the custom name and revert to the mDNS name.
   */
  ipcMain.handle('rename-device', (_event, deviceId: string, name: string) => {
    requirePremium()
    configStore.setCustomName(deviceId, name.trim())
    popup.webContents.send('devices-updated', manager.listDevices())
  })

  /** Pin or unpin a device to the top of the list. [PREMIUM] */
  ipcMain.handle('pin-device', (_event, deviceId: string, pinned: boolean) => {
    requirePremium()
    configStore.setPinned(deviceId, pinned)
    popup.webContents.send('devices-updated', manager.listDevices())
  })

  /** Connect to a device and start streaming system audio. */
  ipcMain.handle('connect', async (_event, deviceId: string, volume: number, sourceId: string | null = null) => {
    // Wake-on-LAN requires premium (offline device → WoL path)
    const device = manager.listDevices().find(d => d.id === deviceId)
    if (device && !device.online) {
      requirePremium()
    }

    try {
      await manager.connect(deviceId, volume, sourceId)
      popup.webContents.send('state-changed', {
        state: manager.state,
        connectedDeviceId: manager.connectedDeviceId,
      })
      // When native WASAPI loopback is active, the renderer's AudioWorklet is not needed
      if (!sourceId || sourceId === 'loopback') {
        popup.webContents.send('stop-capture')
      }
    } catch (err) {
      popup.webContents.send('state-changed', { state: 'error', error: (err as Error).message })
      throw err
    }
  })

  /** Disconnect and stop streaming. */
  ipcMain.handle('disconnect', async () => {
    await manager.disconnect()
    popup.webContents.send('state-changed', { state: 'idle', connectedDeviceId: null })
    popup.webContents.send('stop-capture')
  })

  /** Change volume on the connected device. */
  ipcMain.handle('set-volume', (_event, volumePct: number) => {
    manager.setVolume(volumePct)
  })

  /**
   * Returns the desktop source ID needed by the renderer to call getUserMedia
   * with chromeMediaSource: 'desktop' for system audio loopback capture.
   */
  ipcMain.handle('get-desktop-source-id', async () => {
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({
          video: sources[0] ?? null,
          audio: 'loopback',
        })
      })
    })

    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    return sources[0]?.id ?? null
  })

  /**
   * Receives raw s16le PCM frames from the renderer's AudioWorklet and feeds
   * them into the audio source buffer for RAOP streaming.
   */
  ipcMain.on('pcm-chunk', (_event, chunk: Buffer) => {
    manager.feedPcm(chunk)
  })

  /** Open the AV Sync browser extension folder in File Explorer. */
  ipcMain.handle('open-extension-folder', () => {
    const folder = app.isPackaged
      ? join(process.resourcesPath, 'extension')
      : join(__dirname, '../../extension')
    return shell.openPath(folder)
  })

  // ── Auth status (pushed from renderer → main) ─────────────────────────────
  // The renderer calls ipcRenderer.send('report-auth-status', status) whenever
  // auth state or subscription status changes. We update authManager and persist
  // the cache so premium gates work correctly on the next startup.
  ipcMain.on('report-auth-status', (_event, status: AuthStatus) => {
    authManager.setStatus(status)
    if (status.signedIn && status.uid) {
      configStore.setAuthCache({
        uid: status.uid,
        email: status.email ?? '',
        isPremium: status.isPremium,
        lastUpdated: Date.now(),
      })
    } else {
      configStore.clearAuthCache()
    }
  })

  // ── Account IPC ───────────────────────────────────────────────────────────
  /** Get current auth + subscription status. */
  ipcMain.handle('get-auth-status', () => authManager.getStatus())

  /** Open Stripe Checkout in the user's default browser to subscribe. */
  ipcMain.handle('open-purchase-url', () => {
    shell.openExternal(STRIPE_CHECKOUT_URL)
  })

  /** Open Stripe Customer Portal to manage or cancel subscription. */
  ipcMain.handle('open-manage-subscription-url', () => {
    shell.openExternal(STRIPE_PORTAL_URL)
  })

  // ── Auto-update IPC ───────────────────────────────────────────────────────
  /** Manually trigger an update check (called from settings panel). */
  ipcMain.handle('check-for-updates', () => {
    checkForUpdates()
  })

  /** User has accepted the downloaded update — quit and install. */
  ipcMain.handle('install-update', () => {
    installUpdateOnQuit()
  })
}
