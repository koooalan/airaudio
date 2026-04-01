/**
 * Manages AirPlay streaming and device discovery.
 * Uses @lox-audioserver/node-airplay-sender for ALAC + AES/ChaCha20 streaming
 * and @basmilius/apple-common for mDNS device discovery.
 */

import { parseMacFromDeviceId, sendWakeOnLan, tcpProbe } from './wol.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { start } = require('@lox-audioserver/node-airplay-sender')
const { applyConfig } = require('@lox-audioserver/node-airplay-sender/dist/utils/config')

import { Discovery, type DiscoveryResult } from '@basmilius/apple-common'
import type { DeviceInfo, ConnectionState } from '../shared/types.js'
import { configStore } from './config-store.js'

export type { DeviceInfo, ConnectionState }

const FRAMES_PER_PACKET = 352
const SAMPLE_RATE = 44100

const CONNECT_TIMEOUT_MS = 15_000  // give up connecting after 15 s
const MAX_RECONNECT_ATTEMPTS = 3   // automatic retries before giving up
const RECONNECT_BASE_MS = 1_500    // first retry after 1.5 s, then 3 s, then 6 s

export class RaopManager {
  private discovery: Discovery | null = null
  private discoveryInterval: NodeJS.Timeout | null = null
  private devices: Map<string, DiscoveryResult> = new Map()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sender: any = null
  private senderReady = false

  // Reconnect state
  private userDisconnected = false
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private connectTimer: NodeJS.Timeout | null = null
  private lastDeviceId: string | null = null
  private lastVolume = 80

  // Feed rate-limiter: prevents IPC bursts from overflowing the library's circular buffer.
  private _feedStartTime = 0
  private _feedBytesTotal = 0

  // AirPlay 1 fallback: seeded from config on startup so identified devices are remembered across restarts.
  private _airplay1DeviceIds = new Set<string>(configStore.getAirplay1DeviceIds())
  private _pairFailed = false   // set when 'pair_failed' fires; triggers airplay1 retry on 'stopped'

  get latencySeconds(): number { return configStore.latencySeconds }
  get syncOffsetMs(): number { return configStore.syncOffsetMs }
  get volume(): number { return this.lastVolume }

  state: ConnectionState = 'idle'
  connectedDeviceId: string | null = null

  /** Called whenever state or connectedDeviceId changes. */
  onStateChange?: (state: ConnectionState, connectedDeviceId: string | null) => void

  /** Start continuous mDNS polling for _raop._tcp devices. */
  startDiscovery(onChange: (devices: DeviceInfo[]) => void): void {
    this.discovery = Discovery.raop()

    const scan = async () => {
      try {
        const results = await this.discovery!.find(false)

        // Rebuild live map — skip incomplete mDNS records with no usable name
        const incoming = new Map<string, DiscoveryResult>()
        for (const r of results) {
          const name = extractFriendlyName(r)
          if (!name) continue
          incoming.set(r.id, r)
        }
        this.devices = incoming
        onChange(this.listDevices())
      } catch {
        // Network errors during scan are non-fatal
      }
    }

    scan()
    this.discoveryInterval = setInterval(scan, 5000)
  }

  stopDiscovery(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval)
      this.discoveryInterval = null
    }
  }

  listDevices(): DeviceInfo[] {
    // Start with all known (cached) devices marked offline — skip nameless entries
    const result = new Map<string, DeviceInfo>()
    for (const d of configStore.getKnownDevices()) {
      if (!d.name) continue
      result.set(d.id, { ...d, online: false, pinned: configStore.isPinned(d.id) })
    }

    // Overlay live mDNS discoveries, marked online
    for (const r of this.devices.values()) {
      const id = r.id
      const mdnsName = extractFriendlyName(r)
      const device: DeviceInfo = {
        id,
        name: configStore.getCustomName(id) ?? mdnsName,
        address: r.address,
        port: r.service.port,
        model: r.txt['am'] ?? 'AirPlay Device',
        online: true,
        pinned: configStore.isPinned(id),
      }
      result.set(id, device)
      // Persist latest network info (without custom name or pinned — store raw mDNS name)
      configStore.upsertDevice({ ...device, name: mdnsName })
    }

    // Sort: pinned → online → alphabetical (stable within each group)
    return Array.from(result.values()).sort((a, b) => {
      if ((a.pinned ?? false) !== (b.pinned ?? false)) return a.pinned ? -1 : 1
      if (a.online !== b.online) return a.online ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  async connect(deviceId: string, volume: number): Promise<void> {
    if (this.state === 'connecting' || this.state === 'streaming' || this.state === 'waking') {
      await this.disconnect()
    }

    // If the device isn't currently visible on the network, attempt to wake it first
    if (!this.devices.has(deviceId)) {
      await this._wakeDevice(deviceId, volume)
      return
    }

    const result = this.devices.get(deviceId)
    if (!result) throw new Error(`Device ${deviceId} not found`)

    // Reset reconnect state for a fresh user-initiated connect
    this.userDisconnected = false
    this.reconnectAttempts = 0
    this.lastDeviceId = deviceId
    this.lastVolume = volume
    this._clearTimers()

    this.setState('connecting', deviceId)
    this.senderReady = false

    // Give up if the device doesn't respond within CONNECT_TIMEOUT_MS
    this.connectTimer = setTimeout(() => {
      if (this.state === 'connecting') {
        console.warn('[raop] connect timeout — aborting')
        this._teardown()
        this.onStateChange?.('error', null)
      }
    }, CONNECT_TIMEOUT_MS)

    // Apply the user's saved latency before each connection — ensures latency_seconds,
    // packets_in_buffer, and stream_latency are always consistent with the user's preference
    // regardless of whether setLatency() was called this session.
    const latency = configStore.latencySeconds
    const packetsNeeded = Math.ceil((latency * SAMPLE_RATE) / FRAMES_PER_PACKET) + 20
    applyConfig({ latency_seconds: latency, packets_in_buffer: packetsNeeded, stream_latency: 50 })

    // Detect AirPlay 1 from mDNS TXT records before attempting a connection.
    // et (encryption types): AirPlay 2 devices advertise type '4'; absence means AirPlay 1.
    // am (model): some older models are AirPlay 1 only.
    const txt = result.txt ?? {}
    const et = txt['et'] ?? ''
    const am = txt['am'] ?? ''
    if ((et !== '' && !et.includes('4')) || /^(AppleTV[1-3],|AirReceiver[1-3],|Shairport)/.test(am)) {
      this._airplay1DeviceIds.add(deviceId)
      configStore.setAirplay1(deviceId)
    }
    const useAirplay2 = !this._airplay1DeviceIds.has(deviceId)
    this._pairFailed = false

    // Declare before start() so the closure doesn't hit a temporal dead zone —
    // the library fires its first event synchronously inside start() before it returns.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sender: any
    sender = start(
      { host: result.address, port: result.service.port, airplay2: useAirplay2 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (event: any) => {
        // Ignore stale callbacks from a previous sender instance
        if (this.sender !== sender) return

        const msg = event?.message
        if (msg === 'ready') {
          this._clearTimers()
          this.senderReady = true
          this.reconnectAttempts = 0  // successful — reset retry counter
          this.setState('streaming', deviceId)
        } else if (msg === 'pair_failed') {
          // AirPlay 2 pairing rejected — remember this device as AirPlay 1 only
          this._airplay1DeviceIds.add(deviceId)
          configStore.setAirplay1(deviceId)
          this._pairFailed = true
          console.log(`[raop] pair_failed for ${deviceId} — will retry as AirPlay 1`)
        } else if (msg === 'stopped') {
          this.sender = null
          this.senderReady = false
          this._clearTimers()
          if (this._pairFailed) {
            this._pairFailed = false
            this._retryWithAirplay1()
          } else if (!this.userDisconnected && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            this._scheduleReconnect()
          } else {
            this.setState('idle', null)
          }
        }
      },
    )

    this.sender = sender
    sender.setVolume(volume)
    sender.setTrackInfo('System Audio', 'AirAudio', 'Windows')
  }

  async disconnect(): Promise<void> {
    this.userDisconnected = true
    this._clearTimers()
    this._teardown()
  }

  private _teardown(): void {
    const s = this.sender
    // Null out first so the stale-callback guard prevents double state changes
    this.sender = null
    this.senderReady = false
    this.setState('idle', null)
    s?.stop()
  }

  private _clearTimers(): void {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
  }

  private _scheduleReconnect(): void {
    const delay = RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++
    console.log(`[raop] stream dropped — reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
    this.setState('connecting', this.lastDeviceId)
    this.reconnectTimer = setTimeout(() => {
      if (!this.userDisconnected && this.lastDeviceId) {
        this.connect(this.lastDeviceId, this.lastVolume).catch((err: Error) => {
          console.error('[raop] reconnect failed:', err.message)
          this.setState('idle', null)
        })
      }
    }, delay)
  }

  /** Retry the last connection with airplay2: false after PAIR_SETUP failure. */
  private _retryWithAirplay1(): void {
    if (!this.lastDeviceId) { this.setState('error', null); return }
    this.setState('connecting', this.lastDeviceId)
    this.reconnectTimer = setTimeout(() => {
      this.connect(this.lastDeviceId!, this.lastVolume).catch((err: Error) => {
        console.error('[raop] airplay1 retry failed:', err.message)
        this.setState('error', null)
      })
    }, 300)
  }

  /**
   * Send a Wake-on-LAN packet then poll TCP port 7000 until the device
   * responds or the timeout expires, then hand off to connect().
   */
  private async _wakeDevice(deviceId: string, volume: number): Promise<void> {
    const WAKE_TIMEOUT_MS = 15_000
    const PROBE_INTERVAL_MS = 1_500

    const cached = configStore.getKnownDevices().find((d) => d.id === deviceId)
    if (!cached) {
      this.setState('error', null)
      return
    }

    this.setState('waking', deviceId)
    this.lastDeviceId = deviceId
    this.lastVolume = volume
    this.userDisconnected = false

    // Send magic packet (best-effort — device may not support WoL)
    const mac = parseMacFromDeviceId(deviceId)
    if (mac) {
      sendWakeOnLan(mac).catch((err: Error) =>
        console.warn('[wol] magic packet failed:', err.message)
      )
      console.log(`[wol] sent magic packet to ${mac} (${cached.name})`)
    } else {
      console.warn('[wol] could not parse MAC from device ID:', deviceId)
    }

    // Poll TCP port 7000 until device responds or timeout
    const deadline = Date.now() + WAKE_TIMEOUT_MS
    const poll = async (): Promise<void> => {
      if (this.state !== 'waking') return  // user cancelled

      // Check if mDNS already picked it up
      if (this.devices.has(deviceId)) {
        console.log('[wol] device appeared in mDNS — connecting')
        await this.connect(deviceId, volume)
        return
      }

      if (Date.now() < deadline) {
        const alive = await tcpProbe(cached.address, cached.port, PROBE_INTERVAL_MS)
        if (alive) {
          console.log('[wol] TCP probe succeeded — connecting with cached address')
          // Device is up but mDNS not yet updated — connect directly with cached info
          await this._connectDirect(cached.address, cached.port, deviceId, volume)
          return
        }
        this.reconnectTimer = setTimeout(poll, 200)
      } else {
        console.warn('[wol] wake timeout — device did not respond')
        this.setState('error', null)
      }
    }

    poll()
  }

  /** Connect directly to a known address/port without requiring live mDNS discovery. */
  private async _connectDirect(address: string, port: number, deviceId: string, volume: number): Promise<void> {
    this.setState('connecting', deviceId)
    this.senderReady = false
    this._clearTimers()

    this.connectTimer = setTimeout(() => {
      if (this.state === 'connecting') {
        this._teardown()
        this.setState('error', null)
      }
    }, CONNECT_TIMEOUT_MS)

    const latency = configStore.latencySeconds
    const packetsNeeded = Math.ceil((latency * SAMPLE_RATE) / FRAMES_PER_PACKET) + 20
    applyConfig({ latency_seconds: latency, packets_in_buffer: packetsNeeded, stream_latency: 50 })

    const useAirplay2 = !this._airplay1DeviceIds.has(deviceId)
    this._pairFailed = false

    let sender: any  // eslint-disable-line @typescript-eslint/no-explicit-any
    sender = start(
      { host: address, port, airplay2: useAirplay2 },
      (event: any) => {  // eslint-disable-line @typescript-eslint/no-explicit-any
        if (this.sender !== sender) return
        const msg = event?.message
        if (msg === 'ready') {
          this._clearTimers()
          this.senderReady = true
          this.reconnectAttempts = 0
          this.setState('streaming', deviceId)
        } else if (msg === 'pair_failed') {
          this._airplay1DeviceIds.add(deviceId)
          this._pairFailed = true
          console.log(`[raop] pair_failed for ${deviceId} — will retry as AirPlay 1`)
        } else if (msg === 'stopped') {
          this.sender = null
          this.senderReady = false
          this._clearTimers()
          if (this._pairFailed) {
            this._pairFailed = false
            this._retryWithAirplay1()
          } else if (!this.userDisconnected && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            this._scheduleReconnect()
          } else {
            this.setState('idle', null)
          }
        }
      },
    )

    this.sender = sender
    sender.setVolume(volume)
    sender.setTrackInfo('System Audio', 'AirAudio', 'Windows')
  }

  /** Called from IPC when the renderer sends a PCM chunk. */
  feedPcm(chunk: Buffer | Uint8Array): void {
    if (!this.sender || !this.senderReady) return
    // Electron IPC may deserialize Buffer as Uint8Array — normalise
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

    // Rate-limit: drop chunks that are more than 500 ms ahead of real-time.
    // Prevents IPC bursts (caused by GC pauses, CPU spikes, or event-loop stalls)
    // from overflowing the library's circular buffer — which causes the read pointer
    // to lap unconsumed packets → sped-up / distorted audio.
    const MAX_AHEAD_MS = 500
    const BYTES_PER_MS = (SAMPLE_RATE * 4) / 1000   // 4 = 2 channels × 2 bytes/sample
    const expectedBytes = (performance.now() - this._feedStartTime) * BYTES_PER_MS
    if (this._feedBytesTotal > expectedBytes + MAX_AHEAD_MS * BYTES_PER_MS) {
      return
    }

    this.sender.sendPcm(buf)
    this._feedBytesTotal += buf.length
  }

  setVolume(volumePct: number): void {
    this.lastVolume = volumePct   // persist so reconnects always use the current slider value
    // Library accepts 0–100; converts to dB internally
    this.sender?.setVolume(volumePct)
  }

  /**
   * Set the AirPlay streaming latency in seconds (0.5 – 2.0).
   * Takes effect on the next connection; safe to call while idle or streaming.
   * packets_in_buffer is sized to match so the circular buffer never starves.
   */
  setSyncOffset(ms: number): void {
    configStore.setSyncOffsetMs(ms)
  }

  setLatency(seconds: number): void {
    configStore.setLatencySeconds(seconds)
    const packetsNeeded = Math.ceil((seconds * SAMPLE_RATE) / FRAMES_PER_PACKET) + 20
    applyConfig({ latency_seconds: seconds, packets_in_buffer: packetsNeeded })
  }

  private setState(state: ConnectionState, deviceId: string | null): void {
    if (state === 'streaming') {
      // Reset feed rate-limiter baseline so it tracks from the moment audio starts flowing.
      this._feedStartTime = performance.now()
      this._feedBytesTotal = 0
    }
    this.state = state
    this.connectedDeviceId = deviceId
    this.onStateChange?.(state, deviceId)
  }
}

function extractFriendlyName(r: DiscoveryResult): string {
  // 1. FQDN: "MAC@DeviceName._raop._tcp.local"
  const atIdx = r.fqdn.indexOf('@')
  const raopIdx = r.fqdn.indexOf('._raop')
  if (atIdx !== -1 && raopIdx !== -1) {
    const name = r.fqdn.slice(atIdx + 1, raopIdx)
    if (name) return name.replace(/-/g, ' ')
  }

  // 2. Device ID: "MAC@DeviceName.local"
  const idAt = r.id.indexOf('@')
  const idLocal = r.id.lastIndexOf('.local')
  if (idAt !== -1 && idLocal !== -1) {
    const name = r.id.slice(idAt + 1, idLocal)
    if (name) return name.replace(/-/g, ' ')
  }

  // 3. Fall back to model name
  return r.modelName || ''
}
