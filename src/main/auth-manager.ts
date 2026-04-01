/**
 * Auth manager for the main process.
 *
 * Firebase Auth and Firestore live entirely in the renderer process.
 * This module maintains a cached copy of the auth+subscription state so
 * the main process can enforce premium feature gates via requirePremium().
 *
 * The renderer pushes updates via the 'report-auth-status' IPC event
 * (ipcRenderer.send → ipcMain.on) whenever the auth or subscription state changes.
 *
 * On startup, the last-known isPremium value is restored from config-store so
 * premium features work correctly for the brief window before the renderer
 * initializes and sends its first status update.
 */

import type { AuthStatus } from '../shared/types.js'

export type { AuthStatus }

let _status: AuthStatus = { signedIn: false, isPremium: false }

export const authManager = {
  /**
   * Restore cached auth state from config.json at startup.
   * Called before registerIpcHandlers so requirePremium() works on first use.
   */
  initFromCache(cached: { uid?: string; email?: string; isPremium: boolean } | undefined): void {
    if (cached) {
      _status = {
        signedIn: !!cached.uid,
        uid: cached.uid,
        email: cached.email,
        isPremium: cached.isPremium,
      }
    }
  },

  /** Returns the current in-memory auth+subscription status. */
  getStatus(): AuthStatus {
    return { ..._status }
  },

  /** Returns true if the user has an active subscription. */
  isPremium(): boolean {
    return _status.isPremium
  },

  /**
   * Update the in-memory status.
   * Called from the 'report-auth-status' IPC handler whenever the renderer
   * receives an auth or Firestore subscription change.
   */
  setStatus(status: AuthStatus): void {
    _status = { ...status }
    authManager.onStatusChange?.(status)
  },

  /** Optional callback — used by index.ts to push updates to the popup window. */
  onStatusChange: undefined as ((status: AuthStatus) => void) | undefined,
}
