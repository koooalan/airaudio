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
