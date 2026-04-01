/**
 * Auto-update via electron-updater + GitHub Releases.
 *
 * - Checks for updates 10s after app ready, then once per day.
 * - autoDownload = false: user opts in by clicking "Download".
 * - Once downloaded, autoInstallOnAppQuit = true: installs on next quit.
 * - All status changes are forwarded to the popup via the onStatus callback.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// electron-updater is CJS and has issues with direct ESM import in Electron
const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')

import type { UpdateStatus } from '../shared/types.js'

export type { UpdateStatus }

let _onStatus: ((s: UpdateStatus) => void) | undefined

export function initAutoUpdater(onStatus: (s: UpdateStatus) => void): void {
  _onStatus = onStatus

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    onStatus({ type: 'checking' })
  })

  autoUpdater.on('update-available', (info: { version: string }) => {
    onStatus({ type: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    onStatus({ type: 'not-available' })
  })

  autoUpdater.on('download-progress', (progress: { percent: number }) => {
    onStatus({ type: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    autoUpdater.autoInstallOnAppQuit = true
    onStatus({ type: 'ready', version: info.version })
  })

  autoUpdater.on('error', (err: Error) => {
    // Log silently — update errors should not alarm users
    console.error('[updater] Error:', err.message)
    onStatus({ type: 'error', message: err.message })
  })

  // First check: 10s after startup (non-blocking, avoids slowing down app launch)
  setTimeout(() => checkForUpdates(), 10_000)

  // Daily re-check
  setInterval(() => checkForUpdates(), 24 * 60 * 60 * 1_000)
}

export function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch((err: Error) => {
    console.error('[updater] checkForUpdates failed:', err.message)
  })
}

export function installUpdateOnQuit(): void {
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.quitAndInstall(false, true)
}
