import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceInfo, ConnectionState, AuthStatus, UpdateStatus } from '../shared/types.js'
import {
  startCapture, stopCapture, restartCapture,
  setMuted, getMuted, getAudioSources,
  type AudioSourceInfo,
} from './capture/audio-capturer.js'

// ── Firebase ──────────────────────────────────────────────────────────────────
// Config is injected at build time from .env (VITE_FIREBASE_* vars).
// If the vars are missing (dev without Firebase), auth features are disabled.
import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth'
import { getFirestore, doc, onSnapshot } from 'firebase/firestore'

const _fbConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY            as string | undefined,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN        as string | undefined,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID         as string | undefined,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET     as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID             as string | undefined,
}

const _fbReady = !!_fbConfig.apiKey
const _fbApp  = _fbReady ? initializeApp(_fbConfig as Required<typeof _fbConfig>) : null
const _fbAuth = _fbApp   ? getAuth(_fbApp)       : null
const _fbDb   = _fbApp   ? getFirestore(_fbApp)  : null
const _googleProvider = _fbAuth ? new GoogleAuthProvider() : null

// ── IPC window type ───────────────────────────────────────────────────────────
declare global {
  interface Window {
    airAudio: {
      getState: () => Promise<{ devices: DeviceInfo[]; state: ConnectionState; connectedDeviceId: string | null; latencySeconds: number; syncOffsetMs: number; volume: number }>
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
      reportAuthStatus: (status: AuthStatus) => void
      getAuthStatus: () => Promise<AuthStatus>
      openPurchaseUrl: () => Promise<void>
      openManageSubscriptionUrl: () => Promise<void>
      checkForUpdates: () => Promise<void>
      installUpdate: () => Promise<void>
      onDevicesUpdated: (cb: (devices: DeviceInfo[]) => void) => () => void
      onStateChanged: (cb: (s: { state?: ConnectionState; connectedDeviceId?: string | null; error?: string }) => void) => () => void
      onStopCapture: (cb: () => void) => () => void
      onSyncOffsetChanged: (cb: (ms: number) => void) => () => void
      onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function sliderStyle(value: number, min: number, max: number, disabled?: boolean): React.CSSProperties {
  const pct = ((value - min) / (max - min)) * 100
  return {
    flex: 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    background: `linear-gradient(to right, #00ff55 ${pct}%, #3a3a3c ${pct}%)`,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
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

  // ── Auth & subscription ───────────────────────────────────────────────────
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ signedIn: false, isPremium: false })
  const [signingIn, setSigningIn] = useState(false)
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [upgradeContext, setUpgradeContext] = useState<string | null>(null)

  // ── Auto-update ───────────────────────────────────────────────────────────
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  const isPremium = authStatus.isPremium

  const renameInputRef = useRef<HTMLInputElement>(null)
  const volumeDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Firebase auth + Firestore subscription listener ───────────────────────
  useEffect(() => {
    if (!_fbAuth) return

    let unsubFirestore: (() => void) | null = null

    const unsubAuth = onAuthStateChanged(_fbAuth, (user) => {
      // Clean up previous Firestore listener
      unsubFirestore?.()
      unsubFirestore = null

      if (!user) {
        const status: AuthStatus = { signedIn: false, isPremium: false }
        setAuthStatus(status)
        window.airAudio.reportAuthStatus(status)
        return
      }

      // Subscribe to Firestore /users/{uid} for real-time isPremium updates
      if (_fbDb) {
        const userRef = doc(_fbDb, 'users', user.uid)
        unsubFirestore = onSnapshot(userRef, (snap) => {
          const isPremium = snap.exists() ? (snap.data()?.isPremium === true) : false
          const status: AuthStatus = {
            signedIn: true,
            uid: user.uid,
            email: user.email ?? undefined,
            isPremium,
          }
          setAuthStatus(status)
          window.airAudio.reportAuthStatus(status)
        }, () => {
          // Firestore error (e.g. offline) — keep existing status, don't degrade
        })
      } else {
        // No Firestore — just set signed in without premium
        const status: AuthStatus = { signedIn: true, uid: user.uid, email: user.email ?? undefined, isPremium: false }
        setAuthStatus(status)
        window.airAudio.reportAuthStatus(status)
      }
    })

    return () => {
      unsubAuth()
      unsubFirestore?.()
    }
  }, [])

  // ── Load initial state ────────────────────────────────────────────────────
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

  // ── Subscribe to IPC events ───────────────────────────────────────────────
  useEffect(() => {
    const unsub1 = window.airAudio.onDevicesUpdated((d) => setDevices(d))
    const unsub2 = window.airAudio.onStateChanged(({ state, connectedDeviceId, error }) => {
      if (state) {
        setConnState(state)
        if (state === 'streaming') {
          startCapture(selectedSource).catch(console.error)
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
    const unsub5 = window.airAudio.onUpdateStatus((s) => setUpdateStatus(s))
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSource])

  // ── Premium gate helper ───────────────────────────────────────────────────
  const openUpgradeModal = useCallback((context: string) => {
    setUpgradeContext(context)
    setShowAccountModal(true)
  }, [])

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleConnect = useCallback(async (deviceId: string) => {
    if (connectedId === deviceId) {
      await window.airAudio.disconnect()
      return
    }
    // Offline device = Wake-on-LAN path = premium
    const device = devices.find(d => d.id === deviceId)
    if (device && !device.online && !isPremium) {
      openUpgradeModal('Waking offline devices')
      return
    }
    setError(null)
    try {
      await window.airAudio.connect(deviceId, volume)
    } catch (err) {
      if ((err as Error).message?.includes('PREMIUM_REQUIRED')) {
        openUpgradeModal('This feature')
      }
    }
  }, [connectedId, volume, devices, isPremium, openUpgradeModal])

  const handleVolume = useCallback((val: number) => {
    setVolume(val)
    if (volumeDebounce.current) clearTimeout(volumeDebounce.current)
    volumeDebounce.current = setTimeout(() => {
      if (connState === 'streaming') window.airAudio.setVolume(val)
    }, 150)
  }, [connState])

  const handleLatency = useCallback((val: number) => {
    if (!isPremium) { openUpgradeModal('Latency adjustment'); return }
    setLatency(val)
    window.airAudio.setLatency(val)
  }, [isPremium, openUpgradeModal])

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
    if (!isPremium) { openUpgradeModal('Device pinning'); return }
    window.airAudio.pinDevice(device.id, !device.pinned)
  }, [isPremium, openUpgradeModal])

  const startRename = useCallback((device: DeviceInfo, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!isPremium) { openUpgradeModal('Custom device names'); return }
    setRenamingId(device.id)
    setRenameValue(device.name)
    setTimeout(() => renameInputRef.current?.select(), 0)
  }, [isPremium, openUpgradeModal])

  const commitRename = useCallback(() => {
    if (!renamingId) return
    window.airAudio.renameDevice(renamingId, renameValue)
    setRenamingId(null)
  }, [renamingId, renameValue])

  const cancelRename = useCallback(() => setRenamingId(null), [])

  const handleSignIn = useCallback(async () => {
    if (!_fbAuth || !_googleProvider) return
    setSigningIn(true)
    try {
      await signInWithPopup(_fbAuth, _googleProvider)
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== 'auth/popup-closed-by-user') {
        console.error('[auth] Sign-in error:', err)
      }
    } finally {
      setSigningIn(false)
    }
  }, [])

  const handleSignOut = useCallback(async () => {
    if (!_fbAuth) return
    await signOut(_fbAuth)
    setShowAccountModal(false)
  }, [])

  // ── Device list renderer ──────────────────────────────────────────────────
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
                title={isPremium ? 'Double-click to rename' : 'Double-click to rename (Premium)'}
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
            title={!isPremium ? 'Pin to top (Premium)' : device.pinned ? 'Unpin' : 'Pin to top'}
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

  const onlineDevices  = devices.filter(d => d.online)
  // Offline devices section is premium-only
  const offlineDevices = isPremium ? devices.filter(d => !d.online) : []

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.container}>
      {/* Account modal overlay */}
      {showAccountModal && (
        <div style={styles.modalOverlay} onClick={() => setShowAccountModal(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>
                {authStatus.signedIn && authStatus.isPremium
                  ? '★ AirAudio Premium'
                  : authStatus.signedIn
                  ? 'Your Account'
                  : 'Sign in to AirAudio'}
              </span>
              <button style={styles.modalClose} onClick={() => setShowAccountModal(false)}>✕</button>
            </div>

            {upgradeContext && !authStatus.isPremium && (
              <div style={styles.upgradeContext}>
                🔒 {upgradeContext} requires Premium
              </div>
            )}

            {!authStatus.signedIn && (
              <>
                <div style={styles.featureList}>
                  {['Adjustable latency (0.5–2.0s)', 'AV sync + browser extension', 'Audio source selection', 'Custom device names & pinning', 'Wake-on-LAN for offline devices'].map(f => (
                    <div key={f} style={styles.featureItem}>
                      <span style={{ color: '#00ff55', marginRight: 7 }}>✓</span>{f}
                    </div>
                  ))}
                </div>
                <button
                  style={{ ...styles.primaryBtn, opacity: signingIn ? 0.6 : 1 }}
                  onClick={handleSignIn}
                  disabled={signingIn || !_fbReady}
                  title={!_fbReady ? 'Firebase not configured' : undefined}
                >
                  {signingIn ? 'Opening browser…' : 'Sign in with Google'}
                </button>
                <div style={styles.modalNote}>
                  {_fbReady ? 'Sign in to access Premium features.' : 'Firebase not configured — contact developer.'}
                </div>
              </>
            )}

            {authStatus.signedIn && !authStatus.isPremium && (
              <>
                <div style={styles.accountEmail}>{authStatus.email}</div>
                <div style={styles.featureList}>
                  {['Adjustable latency (0.5–2.0s)', 'AV sync + browser extension', 'Audio source selection', 'Custom device names & pinning', 'Wake-on-LAN for offline devices'].map(f => (
                    <div key={f} style={styles.featureItem}>
                      <span style={{ color: '#00ff55', marginRight: 7 }}>✓</span>{f}
                    </div>
                  ))}
                </div>
                <button style={styles.primaryBtn} onClick={() => window.airAudio.openPurchaseUrl()}>
                  Subscribe to Premium
                </button>
                <button style={styles.secondaryBtn} onClick={handleSignOut}>Sign out</button>
              </>
            )}

            {authStatus.signedIn && authStatus.isPremium && (
              <>
                <div style={styles.accountEmail}>{authStatus.email}</div>
                <div style={styles.premiumBadgeLarge}>PREMIUM ACTIVE</div>
                <button style={styles.secondaryBtn} onClick={() => window.airAudio.openManageSubscriptionUrl()}>
                  Manage subscription
                </button>
                <button style={styles.secondaryBtn} onClick={handleSignOut}>Sign out</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={styles.logo}>♫ AirAudio</span>
          {authStatus.isPremium && (
            <span style={styles.premiumChip}>PREMIUM</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{ ...styles.statusDot, background: statusColor(connState) }}
            title={"🟢 Streaming\n🟡 Connecting\n🔴 Error\n⚫ Not connected"}
          />
          <button
            style={styles.accountBtn}
            onClick={() => { setUpgradeContext(null); setShowAccountModal(true) }}
            title={authStatus.signedIn ? authStatus.email ?? 'Account' : 'Sign in'}
          >
            {authStatus.signedIn ? '●' : '○'}
          </button>
        </div>
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
        ) : (
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
        )}
      </div>

      {/* Update banner */}
      {updateStatus && (updateStatus.type === 'available' || updateStatus.type === 'downloading' || updateStatus.type === 'ready') && (
        <div style={styles.updateBanner}>
          {updateStatus.type === 'available' && (
            <>
              <span>v{updateStatus.version} available</span>
              <button style={styles.updateBtn} onClick={() => window.airAudio.checkForUpdates()}>Download</button>
            </>
          )}
          {updateStatus.type === 'downloading' && (
            <span>Downloading update… {updateStatus.percent}%</span>
          )}
          {updateStatus.type === 'ready' && (
            <>
              <span>v{updateStatus.version} ready</span>
              <button style={styles.updateBtn} onClick={() => window.airAudio.installUpdate()}>Restart to install</button>
            </>
          )}
        </div>
      )}

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

      {/* Settings panel */}
      {showSettings && (
        <div style={styles.settingsPanel}>
          <div style={styles.tabBar}>
            {/* AV Sync tab is premium-only */}
            {(['settings', ...(isPremium ? ['instructions' as const] : [])] as const).map((tab) => (
              <button
                key={tab}
                style={{ ...styles.tabBtn, ...(settingsTab === tab ? styles.tabBtnActive : {}) }}
                onClick={() => setSettingsTab(tab as 'settings' | 'instructions')}
              >
                {tab === 'settings' ? 'Settings' : 'AV Sync'}
              </button>
            ))}
          </div>

          {settingsTab === 'settings' && (
            <>
              {/* Source selector — premium only */}
              {isPremium && (
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
              )}

              {/* Latency slider — disabled with lock for free users */}
              <div
                style={styles.controlRow}
                onClick={!isPremium ? () => openUpgradeModal('Latency adjustment') : undefined}
              >
                <span style={styles.controlLabel}>Latency</span>
                {!isPremium && <span style={{ fontSize: 11, marginRight: 2 }}>🔒</span>}
                <input
                  type="range"
                  min={0.5}
                  max={2.0}
                  step={0.5}
                  value={isPremium ? latency : 1.0}
                  disabled={!isPremium}
                  onChange={(e) => handleLatency(Number((e.target as HTMLInputElement).value))}
                  style={sliderStyle(isPremium ? latency : 1.0, 0.5, 2.0, !isPremium)}
                  title={!isPremium ? 'Premium feature — click to upgrade' : 'Lower = more responsive, higher = more stable on weak WiFi'}
                />
                <span style={{ ...styles.controlValue, opacity: isPremium ? 1 : 0.4 }}>
                  {isPremium ? `${latency.toFixed(1)}s` : '1.0s'}
                </span>
              </div>
            </>
          )}

          {settingsTab === 'instructions' && isPremium && (
            <div style={styles.instructionsPanel}>
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
              <button style={styles.muteBtn} onClick={handleMute} title={muted ? 'Unmute' : 'Mute'}>
                {muted ? '🔇' : '🔊'}
              </button>
              <button style={styles.disconnectBtn} onClick={() => window.airAudio.disconnect()}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              <span style={styles.hint}>Click a device to connect</span>
              {!authStatus.isPremium && (
                <button
                  style={styles.upgradeLink}
                  onClick={() => { setUpgradeContext(null); setShowAccountModal(true) }}
                >
                  {authStatus.signedIn ? 'Upgrade' : 'Sign in for Premium'}
                </button>
              )}
            </>
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

// ── Styles ────────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#1c1c1e',
    color: '#fff',
    position: 'relative',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 18px 12px',
    borderBottom: '1px solid #2c2c2e',
  },
  logo: {
    fontWeight: 600,
    fontSize: 15,
    letterSpacing: '-0.3px',
  },
  premiumChip: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.5px',
    color: '#00ff55',
    background: '#00ff5520',
    border: '1px solid #00ff5540',
    borderRadius: 4,
    padding: '1px 5px',
  },
  accountBtn: {
    background: 'none',
    border: 'none',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    color: '#636366',
    lineHeight: 1,
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
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    transition: 'background 0.3s',
    flexShrink: 0,
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
  updateBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 16px',
    background: '#0a84ff22',
    borderTop: '1px solid #0a84ff44',
    fontSize: 11,
    color: '#0a84ff',
  },
  updateBtn: {
    background: '#0a84ff',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    fontSize: 11,
    padding: '3px 10px',
    cursor: 'pointer',
    fontWeight: 600,
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
  upgradeLink: {
    background: 'none',
    border: 'none',
    color: '#0a84ff',
    fontSize: 11,
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
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
  // ── Account modal ──────────────────────────────────────────────────────────
  modalOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  modal: {
    width: 280,
    background: '#1c1c1e',
    border: '1px solid #3a3a3c',
    borderRadius: 14,
    padding: '18px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  modalTitle: {
    fontWeight: 600,
    fontSize: 14,
  },
  modalClose: {
    background: 'none',
    border: 'none',
    color: '#636366',
    fontSize: 13,
    cursor: 'pointer',
    padding: 0,
    lineHeight: 1,
  },
  upgradeContext: {
    fontSize: 11,
    color: '#ffd60a',
    background: '#ffd60a15',
    border: '1px solid #ffd60a30',
    borderRadius: 7,
    padding: '5px 9px',
  },
  featureList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    padding: '4px 0',
  },
  featureItem: {
    fontSize: 12,
    color: '#ebebf5cc',
    display: 'flex',
    alignItems: 'center',
  },
  accountEmail: {
    fontSize: 12,
    color: '#8e8e93',
    textAlign: 'center' as const,
  },
  premiumBadgeLarge: {
    textAlign: 'center' as const,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '1px',
    color: '#00ff55',
    background: '#00ff5515',
    border: '1px solid #00ff5530',
    borderRadius: 8,
    padding: '6px 0',
  },
  primaryBtn: {
    width: '100%',
    padding: '9px 0',
    background: '#0a84ff',
    border: 'none',
    borderRadius: 9,
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  secondaryBtn: {
    width: '100%',
    padding: '8px 0',
    background: '#2c2c2e',
    border: '1px solid #3a3a3c',
    borderRadius: 9,
    color: '#ebebf5',
    fontSize: 12,
    cursor: 'pointer',
  },
  modalNote: {
    fontSize: 10,
    color: '#48484a',
    textAlign: 'center' as const,
  },
}
