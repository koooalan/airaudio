/**
 * Persists app settings and known devices to userData/config.json.
 * Loaded once at startup; written synchronously on each change (file is tiny).
 */

import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { DeviceInfo } from '../shared/types.js'

type StoredDevice = Omit<DeviceInfo, 'online'>  // don't persist online state

type StoredConfig = {
  knownDevices: Record<string, StoredDevice>
  customNames: Record<string, string>
  pinnedDevices: string[]
  latencySeconds: number
  syncOffsetMs: number
  airplay1DeviceIds: string[]
  /** Cached auth+subscription state — used by main process before renderer initialises. */
  authCache?: {
    uid: string
    email: string
    isPremium: boolean
    lastUpdated: number   // Unix ms
  }
}

const CONFIG_PATH = join(app.getPath('userData'), 'config.json')

function load(): StoredConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as StoredConfig
    }
  } catch {
    // Corrupt or missing — start fresh
  }
  return { knownDevices: {}, customNames: {}, pinnedDevices: [], latencySeconds: 0.5, syncOffsetMs: 0, airplay1DeviceIds: [], authCache: undefined }
}

function save(): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(_cfg, null, 2), 'utf-8')
  } catch (err) {
    console.error('[config] Failed to save:', err)
  }
}

let _cfg = load()

export const configStore = {
  // ── Latency ──────────────────────────────────────────────────────────────
  get latencySeconds(): number { return _cfg.latencySeconds ?? 0.5 },
  setLatencySeconds(v: number): void { _cfg.latencySeconds = v; save() },

  // ── AV sync offset (ms) — trims video delay relative to audio latency ────
  get syncOffsetMs(): number { return _cfg.syncOffsetMs ?? 0 },
  setSyncOffsetMs(v: number): void { _cfg.syncOffsetMs = v; save() },

  // ── Known devices (remembered across restarts) ────────────────────────────
  getKnownDevices(): StoredDevice[] {
    return Object.values(_cfg.knownDevices ?? {})
  },
  upsertDevice(device: StoredDevice): void {
    if (!_cfg.knownDevices) _cfg.knownDevices = {}
    _cfg.knownDevices[device.id] = device
    save()
  },

  // ── Pinned devices ────────────────────────────────────────────────────────
  isPinned(id: string): boolean {
    return (_cfg.pinnedDevices ?? []).includes(id)
  },
  setPinned(id: string, pinned: boolean): void {
    if (!_cfg.pinnedDevices) _cfg.pinnedDevices = []
    if (pinned) {
      if (!_cfg.pinnedDevices.includes(id)) _cfg.pinnedDevices.push(id)
    } else {
      _cfg.pinnedDevices = _cfg.pinnedDevices.filter((x) => x !== id)
    }
    save()
  },

  // ── Custom names ──────────────────────────────────────────────────────────
  getCustomName(id: string): string | undefined {
    return (_cfg.customNames ?? {})[id]
  },
  setCustomName(id: string, name: string): void {
    if (!_cfg.customNames) _cfg.customNames = {}
    if (name) {
      _cfg.customNames[id] = name
    } else {
      delete _cfg.customNames[id]
    }
    save()
  },
  getAllCustomNames(): Record<string, string> {
    return { ...(_cfg.customNames ?? {}) }
  },

  // ── Auth cache (main process reads this before renderer sends first status update) ──
  getAuthCache(): StoredConfig['authCache'] {
    return _cfg.authCache
  },
  setAuthCache(data: NonNullable<StoredConfig['authCache']>): void {
    _cfg.authCache = data
    save()
  },
  clearAuthCache(): void {
    _cfg.authCache = undefined
    save()
  },

  // ── AirPlay 1 device memory (persisted so we skip AirPlay 2 PAIR_SETUP on restart) ──
  getAirplay1DeviceIds(): string[] {
    return [...(_cfg.airplay1DeviceIds ?? [])]
  },
  isAirplay1(id: string): boolean {
    return (_cfg.airplay1DeviceIds ?? []).includes(id)
  },
  setAirplay1(id: string): void {
    if (!_cfg.airplay1DeviceIds) _cfg.airplay1DeviceIds = []
    if (!_cfg.airplay1DeviceIds.includes(id)) {
      _cfg.airplay1DeviceIds.push(id)
      save()
    }
  },
}
