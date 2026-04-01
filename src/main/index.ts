import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RaopManager } from './raop-manager.js'
import { registerIpcHandlers } from './ipc-handlers.js'
import { createSyncServer, type SyncServer } from './sync-server.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

app.setName('AirAudio')
// Don't show in taskbar — it's a tray app
app.dock?.hide?.()

// Launch automatically when Windows starts
app.setLoginItemSettings({ openAtLogin: true, name: 'AirAudio' })

let tray: Tray | null = null
let popup: BrowserWindow | null = null
const raopManager = new RaopManager()
let syncServer: SyncServer | null = null

function createPopup(): BrowserWindow {
  const win = new BrowserWindow({
    width: 340,
    height: 500,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('blur', () => win.hide())

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function togglePopup(): void {
  if (!popup) return

  if (popup.isVisible()) {
    popup.hide()
    return
  }

  if (!tray) return
  const { x, y } = tray.getBounds()
  const { width, height } = popup.getBounds()

  // Position popup above tray icon (Windows taskbar is usually at bottom)
  popup.setPosition(
    Math.round(x - width / 2 + 8),
    Math.round(y - height - 8),
  )
  popup.show()
  popup.focus()
}

app.whenReady().then(() => {
  // Tray icons — resolved differently in dev vs packaged
  const assetDir = app.isPackaged
    ? join(process.resourcesPath, 'assets')
    : join(__dirname, '../../assets')

  function loadIcon(name: string): Electron.NativeImage {
    return nativeImage.createFromPath(join(assetDir, name))
  }

  const icons = {
    idle:       loadIcon('tray-icon.png'),
    connecting: loadIcon('tray-icon-connecting.png'),
    streaming:  loadIcon('tray-icon-streaming.png'),
    error:      loadIcon('tray-icon-error.png'),
  }

  tray = new Tray(icons.idle)
  tray.setToolTip('AirAudio — AirPlay Sender')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'AirAudio', enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
  tray.setContextMenu(contextMenu)
  tray.on('click', togglePopup)

  popup = createPopup()

  registerIpcHandlers(ipcMain, raopManager, popup)
  syncServer = createSyncServer(raopManager, (ms) => {
    raopManager.setSyncOffset(ms)
    popup?.webContents.send('sync-offset-changed', ms)
  })

  // Forward manager state changes (stream dropped, device lost, etc.) to the popup
  // and update the tray icon to reflect the current state
  raopManager.onStateChange = (state, connectedDeviceId) => {
    popup?.webContents.send('state-changed', { state, connectedDeviceId })
    const trayIcon = state === 'streaming' ? icons.streaming
      : (state === 'connecting' || state === 'waking') ? icons.connecting
      : state === 'error' ? icons.error
      : icons.idle
    tray?.setImage(trayIcon)
    tray?.setToolTip(
      state === 'streaming'  ? `AirAudio — Streaming` :
      state === 'connecting' ? `AirAudio — Connecting…` :
      state === 'waking'     ? `AirAudio — Waking device…` :
      state === 'error'      ? `AirAudio — Error` :
                               `AirAudio — AirPlay Sender`
    )
  }

  // Start device discovery immediately
  raopManager.startDiscovery((devices) => {
    popup?.webContents.send('devices-updated', devices)
  })
})

// Prevent auto-quit when the popup window is closed — this is a tray app
app.on('window-all-closed', () => { /* intentionally empty */ })

app.on('before-quit', () => {
  syncServer?.stop().catch(() => {})
  raopManager.stopDiscovery()
  raopManager.disconnect().catch(() => {})
})
