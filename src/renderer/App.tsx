import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceInfo, ConnectionState } from '../shared/types.js'
import {
  startCapture, stopCapture, restartCapture,
  setMuted, getMuted, getAudioSources,
  type AudioSourceInfo,
} from './capture/audio-capturer.js'

declare global {
  interface Window {
    airAudio: {
      getState: () => Promise<{ devices: DeviceInfo[]; state: ConnectionState; connectedDeviceId: string | null; latencySeconds: number; volume: number }>
      connect: (deviceId: string, volume: number) => Promise<void>
      disconnect: () => Promise<void>
      setVolume: (volumePct: number) => Promise<void>
      setLatency: (seconds: number) => Promise<void>
      setSyncOffset: (ms: number) => Promise<void>
      renameDevice: (deviceId: string, name: string) => Promise<void>
      pinDevice: (deviceId: string, pinned: boolean) => Promise<void>
      getDesktopSourceId: () => Promise<string | null>
      openExtensionFolder: () => Promise<string>
      sendPcmChunk: (chunk: ArrayBuffer) => void
      onDevicesUpdated: (cb: (devices: DeviceInfo[]) => void) => () => void
      onStateChanged: (cb: (s: { state?: ConnectionState; connectedDeviceId?: string | null; error?: string }) => void) => () => void
      onStopCapture: (cb: () => void) => () => void
      onSyncOffsetChanged: (cb: (ms: number) => void) => () => void
    }
  }
}

const MODEL_ICONS: Record<string, string> = {
  AppleTV: '📺',
  HomePod: '🔊',
  AirPort: '📡',
}

function deviceIcon(model: string): string {
  for (const [key, icon] of Object.entries(MODEL_ICONS)) {
    if (model.includes(key)) return icon
  }
  return '🔈'
}

function statusColor(state: ConnectionState): string {
  if (state === 'streaming') return '#00ff55'
  if (state === 'connecting' || state === 'waking') return '#ffd60a'
  if (state === 'error') return '#ff453a'
  return '#636366'
}

function statusLabel(state: ConnectionState): string {
  if (state === 'streaming') return 'Streaming'
  if (state === 'connecting') return 'Connecting…'
  if (state === 'waking') return 'Waking device…'
  if (state === 'error') return 'Error'
  return 'Not connected'
}

/** Returns inline style for a range slider with a filled track using the accent colour. */
function sliderStyle(value: number, min: number, max: number): React.CSSProperties {
  const pct = ((value - min) / (max - min)) * 100
  return {
    flex: 1,
    cursor: 'pointer',
    background: `linear-gradient(to right, #00ff55 ${pct}%, #3a3a3c ${pct}%)`,
  }
}

export function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [connState, setConnState] = useState<ConnectionState>('idle')
  const [connectedId, setConnectedId] = useState<string | null>(null)
  const [volume, setVolume] = useState(80)
  const [latency, setLatency] = useState(1.0)
  const [syncOffset, setSyncOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [muted, setMutedState] = useState(getMuted())
  const [audioSources, setAudioSources] = useState<AudioSourceInfo[]>([{ id: 'loopback', label: 'System Audio', isLoopback: true }])
  const [selectedSource, setSelectedSource] = useState<string>('loopback')
  const [showSettings, setShowSettings] = useState(false)
  const [showOffline, setShowOffline] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'settings' | 'instructions'>('settings')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const volumeDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load initial state
  useEffect(() => {
    window.airAudio.getState().then(({ devices, state, connectedDeviceId, latencySeconds, syncOffsetMs, volume }) => {
      setDevices(devices)
      setConnState(state)
      setConnectedId(connectedDeviceId)
      setLatency(latencySeconds)
      setSyncOffset(syncOffsetMs ?? 0)
      if (volume !== undefined) setVolume(volume)
    })
  }, [])

  // Subscribe to device list and state changes from main process
  useEffect(() => {
    const unsub1 = window.airAudio.onDevicesUpdated((d) => setDevices(d))
    const unsub2 = window.airAudio.onStateChanged(({ state, connectedDeviceId, error }) => {
      if (state) {
        setConnState(state)
        if (state === 'streaming') {
          startCapture(selectedSource).catch(console.error)
          // Refresh source list once capture permission is granted
          getAudioSources().then(setAudioSources).catch(() => {})
        }
        if (state === 'idle' || state === 'error') stopCapture()
      }
      if (connectedDeviceId !== undefined) setConnectedId(connectedDeviceId ?? null)
      if (error) setError(error)
      else setError(null)
    })
    const unsub3 = window.airAudio.onStopCapture(() => stopCapture())
    const unsub4 = window.airAudio.onSyncOffsetChanged((ms) => setSyncOffset(ms))
    return () => { unsub1(); unsub2(); unsub3(); unsub4() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSource])

  const handleConnect = useCallback(async (deviceId: string) => {
    if (connectedId === deviceId) {
      await window.airAudio.disconnect()
      return
    }
    setError(null)
    await window.airAudio.connect(deviceId, volume)
  }, [connectedId, volume])

  const handleVolume = useCallback((val: number) => {
    setVolume(val)
    if (volumeDebounce.current) clearTimeout(volumeDebounce.current)
    volumeDebounce.current = setTimeout(() => {
      if (connState === 'streaming') window.airAudio.setVolume(val)
    }, 150)
  }, [connState])

  const handleLatency = useCallback((val: number) => {
    setLatency(val)
    window.airAudio.setLatency(val)
  }, [])

  const handleSyncOffset = useCallback((val: number) => {
    setSyncOffset(val)
    window.airAudio.setSyncOffset(val)
  }, [])

  const handleMute = useCallback(() => {
    const next = !muted
    setMutedState(next)
    setMuted(next)
  }, [muted])

  const handleSourceChange = useCallback(async (sourceId: string) => {
    setSelectedSource(sourceId)
    if (connState === 'streaming') {
      await restartCapture(sourceId).catch(console.error)
    }
  }, [connState])

  const handlePin = useCallback((device: DeviceInfo, e: React.MouseEvent) => {
    e.stopPropagation()
    window.airAudio.pinDevice(device.id, !device.pinned)
  }, [])

  const startRename = useCallback((device: DeviceInfo, e: React.MouseEvent) => {
    e.stopPropagation()
    setRenamingId(device.id)
    setRenameValue(device.name)
    setTimeout(() => renameInputRef.current?.select(), 0)
  }, [])

  const commitRename = useCallback(() => {
    if (!renamingId) return
    window.airAudio.renameDevice(renamingId, renameValue)
    setRenamingId(null)
  }, [renamingId, renameValue])

  const cancelRename = useCallback(() => setRenamingId(null), [])

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.logo}>♫ AirAudio</span>
        <span
          style={{ ...styles.statusDot, background: statusColor(connState) }}
          title={"🟢 Streaming\n🟡 Connecting\n🔴 Error\n⚫ Not connected"}
        />
      </div>

      {/* Status */}
      <div style={styles.statusBar}>
        {statusLabel(connState)}
        {connectedId && connState === 'streaming' && (
          <span style={styles.connectedName}>
            {' · '}{devices.find(d => d.id === connectedId)?.name ?? connectedId}
          </span>
        )}
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      {/* Device list */}
      <div className="device-list" style={styles.deviceList}>
        {devices.length === 0 ? (
          <div style={styles.empty}>Scanning for AirPlay devices…</div>
        ) : (() => {
          const onlineDevices  = devices.filter(d => d.online)
          const offlineDevices = devices.filter(d => !d.online)

          const renderDevice = (device: DeviceInfo) => {
            const isConnected  = device.id === connectedId
            const isActive     = isConnected && (connState === 'connecting' || connState === 'waking' || connState === 'streaming')
            const isConnecting = (connState === 'connecting' || connState === 'waking') && device.id === connectedId
            const isRenaming   = renamingId === device.id
            return (
              <div
                key={device.id}
                style={{
                  ...styles.deviceRow,
                  ...(isConnected && connState === 'streaming'
                    ? styles.deviceRowStreaming
                    : isActive
                    ? styles.deviceRowActive
                    : hoveredId === device.id
                    ? styles.deviceRowHover
                    : {}),
                  opacity: device.online ? 1 : 0.45,
                  cursor: 'pointer',
                }}
                onClick={() => !isRenaming && handleConnect(device.id)}
                onMouseEnter={() => setHoveredId(device.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <span style={styles.deviceIcon}>{deviceIcon(device.model)}</span>
                <span style={styles.deviceNameWrap}>
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      style={styles.renameInput}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') cancelRename()
                        e.stopPropagation()
                      }}
                      onBlur={commitRename}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      <span
                        style={styles.deviceName}
                        onDoubleClick={(e) => startRename(device, e)}
                        title="Double-click to rename"
                      >
                        {device.name}
                      </span>
                      {device.model && device.model !== 'AirPlay Device' && (
                        <span style={styles.deviceModel}>{device.model}</span>
                      )}
                    </>
                  )}
                </span>
                {(hoveredId === device.id || device.pinned) && !isRenaming && (
                  <button
                    style={styles.pinBtn}
                    onClick={(e) => handlePin(device, e)}
                    title={device.pinned ? 'Unpin' : 'Pin to top'}
                  >
                    {device.pinned ? '★' : '☆'}
                  </button>
                )}
                <span style={{
                  ...styles.indicator,
                  ...(isConnected && connState === 'streaming'
                    ? { background: 'transparent', fontSize: 28, color: '#3a3a3c', width: 32, height: 32 }
                    : { background: isActive ? statusColor(connState) : '#3a3a3c' }),
                }}>
                  {connState === 'waking' && isConnected ? '⚡' :
                   isConnecting ? '…' :
                   isConnected && connState === 'streaming' ? '✓' : ''}
                </span>
              </div>
            )
          }

          return (
            <>
              {onlineDevices.map(renderDevice)}

              {offlineDevices.length > 0 && (
                <>
                  <button
                    style={styles.offlineToggle}
                    onClick={() => setShowOffline(s => !s)}
                  >
                    <span style={styles.offlineToggleChevron}>
                      {showOffline ? '▾' : '▸'}
                    </span>
                    {offlineDevices.length} offline device{offlineDevices.length > 1 ? 's' : ''}
                  </button>
                  {showOffline && offlineDevices.map(renderDevice)}
                </>
              )}
            </>
          )
        })()}
      </div>

      {/* Volume control */}
      <div style={styles.controlRow}>
        <span style={{ ...styles.controlLabel, fontSize: 16 }}>🔊</span>
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={(e) => handleVolume(Number((e.target as HTMLInputElement).value))}
          style={sliderStyle(volume, 0, 100)}
        />
        <span style={styles.controlValue}>{volume}%</span>
      </div>

      {/* Settings panel (toggled by gear button) */}
      {showSettings && (
        <div style={styles.settingsPanel}>

          {/* Tab bar */}
          <div style={styles.tabBar}>
            {(['settings', 'instructions'] as const).map((tab) => (
              <button
                key={tab}
                style={{ ...styles.tabBtn, ...(settingsTab === tab ? styles.tabBtnActive : {}) }}
                onClick={() => setSettingsTab(tab)}
              >
                {tab === 'settings' ? 'Settings' : 'AV Sync'}
              </button>
            ))}
          </div>

          {/* Settings tab */}
          {settingsTab === 'settings' && (
            <>
              <div style={styles.controlRow}>
                <span style={styles.controlLabel}>Source</span>
                <select
                  value={selectedSource}
                  onChange={(e) => handleSourceChange(e.target.value)}
                  style={styles.sourceSelect}
                >
                  {audioSources.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div style={styles.controlRow}>
                <span style={styles.controlLabel}>Latency</span>
                <input
                  type="range"
                  min={0.5}
                  max={2.0}
                  step={0.5}
                  value={latency}
                  onChange={(e) => handleLatency(Number((e.target as HTMLInputElement).value))}
                  style={sliderStyle(latency, 0.5, 2.0)}
                  title="Lower = more responsive, higher = more stable on weak WiFi. Reconnect to apply."
                />
                <span style={styles.controlValue}>{latency.toFixed(1)}s</span>
              </div>
            </>
          )}

          {/* AV Sync / Instructions tab */}
          {settingsTab === 'instructions' && (
            <div style={styles.instructionsPanel}>
              {/* Sync offset trim */}
              <div style={{ ...styles.controlRow, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ ...styles.controlLabel, width: 'auto', fontSize: 11, color: '#636366' }}>◀ audio ahead</span>
                  <span style={{ fontSize: 12, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
                    {syncOffset > 0 ? `+${syncOffset}` : syncOffset}ms
                  </span>
                  <span style={{ ...styles.controlLabel, width: 'auto', fontSize: 11, color: '#636366', textAlign: 'right' }}>video ahead ▶</span>
                </div>
                <input
                  type="range"
                  min={-500}
                  max={2500}
                  step={50}
                  value={syncOffset}
                  onChange={(e) => handleSyncOffset(Number((e.target as HTMLInputElement).value))}
                  style={sliderStyle(syncOffset, -500, 2500)}
                />
              </div>

              <p style={styles.instrIntro}>
                Install the browser extension to keep video in sync with your AirPlay speakers.
              </p>
              {[
                'Open Chrome and go to chrome://extensions',
                'Enable Developer mode (toggle, top right)',
                'Click "Load unpacked"',
                'Select the AirAudio extension folder',
              ].map((step, i) => (
                <div key={i} style={styles.instrStep}>
                  <span style={styles.instrNum}>{i + 1}</span>
                  <span style={styles.instrText}>{step}</span>
                </div>
              ))}
              <button
                style={styles.openFolderBtn}
                onClick={() => window.airAudio.openExtensionFolder()}
              >
                📂 Open Extension Folder
              </button>
            </div>
          )}

        </div>
      )}

      {/* Footer */}
      <div style={styles.footer}>
        <div style={styles.footerLeft}>
          {connState === 'streaming' ? (
            <>
              <button
                style={styles.muteBtn}
                onClick={handleMute}
                title={muted ? 'Unmute' : 'Mute'}
              >
                {muted ? '🔇' : '🔊'}
              </button>
              <button style={styles.disconnectBtn} onClick={() => window.airAudio.disconnect()}>
                Disconnect
              </button>
            </>
          ) : (
            <span style={styles.hint}>Click a device to connect</span>
          )}
        </div>
        <button
          style={{ ...styles.gearBtn, color: showSettings ? '#0a84ff' : '#636366', fontSize: 19 }}
          onClick={() => setShowSettings((s) => !s)}
          title="Settings"
        >⚙</button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#1c1c1e',
    color: '#fff',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 18px 12px',
    borderBottom: '1px solid #2c2c2e',
  },
  gearBtn: {
    background: 'none',
    border: 'none',
    fontSize: 15,
    cursor: 'pointer',
    padding: 0,
    lineHeight: 1,
    transition: 'color 0.15s',
  },
  logo: {
    fontWeight: 600,
    fontSize: 15,
    letterSpacing: '-0.3px',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    transition: 'background 0.3s',
  },
  statusBar: {
    padding: '7px 18px',
    fontSize: 12,
    color: '#8e8e93',
  },
  connectedName: {
    color: '#00ff55',
  },
  errorBanner: {
    margin: '0 12px 4px',
    padding: '6px 10px',
    background: '#3a1515',
    border: '1px solid #ff453a44',
    borderRadius: 8,
    fontSize: 11,
    color: '#ff6b6b',
  },
  deviceList: {
    flex: 1,
    overflowY: 'auto',
    padding: '6px 10px',
  },
  empty: {
    padding: 20,
    textAlign: 'center',
    color: '#636366',
    fontSize: 12,
  },
  deviceRow: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    padding: '11px 10px',
    marginBottom: 3,
    background: 'transparent',
    border: 'none',
    borderRadius: 10,
    color: '#fff',
    cursor: 'pointer',
    textAlign: 'left',
    gap: 10,
    transition: 'background 0.15s',
  },
  deviceRowStreaming: {
    background: '#353535',
  },
  deviceRowActive: {
    background: '#2c2c2e',
  },
  deviceRowHover: {
    background: '#232325',
  },
  deviceIcon: {
    fontSize: 18,
    width: 24,
    textAlign: 'center',
  },
  deviceNameWrap: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
  },
  deviceName: {
    flex: 1,
    fontSize: 14,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  renameInput: {
    flex: 1,
    fontSize: 13,
    fontWeight: 500,
    background: '#3a3a3c',
    border: '1px solid #0a84ff',
    borderRadius: 4,
    color: '#fff',
    padding: '1px 5px',
    outline: 'none',
    width: '100%',
  },
  deviceModel: {
    fontSize: 11,
    color: '#636366',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  indicator: {
    width: 22,
    height: 22,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 9,
    flexShrink: 0,
  },
  settingsPanel: {
    borderTop: '1px solid #2c2c2e',
    background: '#161618',
  },
  tabBar: {
    display: 'flex',
    borderBottom: '1px solid #2c2c2e',
  },
  tabBtn: {
    flex: 1,
    padding: '8px 0',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: '#636366',
    fontSize: 12,
    cursor: 'pointer',
    transition: 'color 0.15s',
  },
  tabBtnActive: {
    color: '#fff',
    borderBottomColor: '#00ff55',
  },
  instructionsPanel: {
    padding: '12px 16px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  instrIntro: {
    fontSize: 11,
    color: '#8e8e93',
    lineHeight: 1.4,
    marginBottom: 2,
  },
  instrStep: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
  },
  instrNum: {
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: '#2c2c2e',
    color: '#00ff55',
    fontSize: 10,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  instrText: {
    fontSize: 12,
    color: '#ebebf5cc',
    lineHeight: 1.4,
  },
  openFolderBtn: {
    marginTop: 4,
    padding: '7px 12px',
    background: '#2c2c2e',
    border: '1px solid #3a3a3c',
    borderRadius: 8,
    color: '#fff',
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  pinBtn: {
    background: 'none',
    border: 'none',
    color: '#ffd60a',
    fontSize: 13,
    cursor: 'pointer',
    padding: '0 4px',
    flexShrink: 0,
  },
  controlRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 18px',
    borderTop: '1px solid #2c2c2e',
  },
  controlLabel: {
    fontSize: 12,
    color: '#8e8e93',
    width: 46,
  },
  controlValue: {
    fontSize: 12,
    color: '#8e8e93',
    width: 32,
    textAlign: 'right',
  },
  footer: {
    padding: '10px 18px 16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  footerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  muteBtn: {
    background: '#2c2c2e',
    border: '1px solid #3a3a3c',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    padding: '6px 10px',
    cursor: 'pointer',
  },
  disconnectBtn: {
    background: '#2d2d2d',
    border: '0px solid #ff453a44',
    borderRadius: 8,
    color: '#ff6b6b',
    fontSize: 12,
    padding: '6px 20px',
    cursor: 'pointer',
  },
  hint: {
    fontSize: 11,
    color: '#48484a',
  },
  offlineToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '6px 10px',
    background: 'none',
    border: 'none',
    borderRadius: 8,
    color: '#636366',
    fontSize: 11,
    cursor: 'pointer',
    textAlign: 'left' as const,
    marginTop: 2,
  },
  offlineToggleChevron: {
    fontSize: 10,
    color: '#48484a',
  },
  sourceSelect: {
    flex: 1,
    maxWidth: 160,
    background: '#2c2c2e',
    border: '1px solid #3a3a3c',
    borderRadius: 6,
    color: '#fff',
    fontSize: 12,
    padding: '3px 6px',
    cursor: 'pointer',
    outline: 'none',
  },
}
