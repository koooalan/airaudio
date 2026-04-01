import { app, BrowserWindow, desktopCapturer, shell, type IpcMain, session } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type RaopManager } from './raop-manager.js'
import { configStore } from './config-store.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

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

  /** Update streaming latency (0.5–2.0s). Takes effect on next connection. */
  ipcMain.handle('set-latency', (_event, seconds: number) => {
    manager.setLatency(Math.min(2.0, Math.max(0.5, seconds)))
  })

  /** Update AV sync offset in ms (-2500 to +2500). Applied immediately by the browser extension. */
  ipcMain.handle('set-sync-offset', (_event, ms: number) => {
    manager.setSyncOffset(Math.min(2500, Math.max(-2500, ms)))
  })

  /**
   * Save a custom display name for a device.
   * Pass an empty string to clear the custom name and revert to the mDNS name.
   */
  ipcMain.handle('rename-device', (_event, deviceId: string, name: string) => {
    configStore.setCustomName(deviceId, name.trim())
    popup.webContents.send('devices-updated', manager.listDevices())
  })

  /** Pin or unpin a device to the top of the list. */
  ipcMain.handle('pin-device', (_event, deviceId: string, pinned: boolean) => {
    configStore.setPinned(deviceId, pinned)
    popup.webContents.send('devices-updated', manager.listDevices())
  })

  /** Connect to a device and start streaming system audio. */
  ipcMain.handle('connect', async (_event, deviceId: string, volume: number) => {
    try {
      await manager.connect(deviceId, volume)
      popup.webContents.send('state-changed', {
        state: manager.state,
        connectedDeviceId: manager.connectedDeviceId,
      })
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
   *
   * In Electron 28+, desktopCapturer.getSources() must be called from the main process.
   * We also register a setDisplayMediaRequestHandler so the renderer's getDisplayMedia()
   * call is handled without a user-facing dialog and captures loopback audio.
   */
  ipcMain.handle('get-desktop-source-id', async () => {
    // Register handler to intercept getDisplayMedia() from the renderer and return loopback audio
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({
          video: sources[0] ?? null,
          audio: 'loopback',  // Windows WASAPI loopback via Chromium
        })
      })
    })

    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    return sources[0]?.id ?? null
  })

  /**
   * Receives raw s16le PCM frames from the renderer's AudioWorklet and feeds
   * them into the audio source buffer for RAOP streaming.
   *
   * Expected: Int16Array buffer (interleaved stereo, 44100Hz).
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
}
