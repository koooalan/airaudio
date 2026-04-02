/** Shared types used by both main process and renderer. */

export type DeviceInfo = {
  id: string
  name: string        // custom name if set, otherwise mDNS name
  address: string
  port: number
  model: string
  online: boolean     // true = currently visible on network, false = remembered but offline
  pinned?: boolean    // true = floated to top of list
}

export type ConnectionState = 'idle' | 'waking' | 'connecting' | 'streaming' | 'error'

/** Auth + subscription status — pushed from renderer to main via IPC. */
export type AuthStatus = {
  signedIn: boolean
  uid?: string
  email?: string
  isPremium: boolean
}

/** Auto-update status — pushed from main to renderer via IPC. */
export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'downloading'; percent: number }
  | { type: 'ready'; version: string }
  | { type: 'error'; message: string }
