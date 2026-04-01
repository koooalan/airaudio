/**
 * AirAudio AV Sync — content script
 *
 * Hooks into every <video> element on the page. When a video starts playing
 * and AirAudio is currently streaming, the video is paused for `latency +
 * syncOffset` milliseconds then resumed — matching the AirPlay speaker delay.
 *
 * A small toast overlay appears on screen while syncing and after completion,
 * with ◀ −50ms / +50ms ▶ fine-tune buttons that POST back to AirAudio so the
 * user can dial in sync without leaving the browser.
 */

;(function () {
  'use strict'

  const BASE_URL   = 'http://localhost:17374'
  const CACHE_TTL  = 2000   // ms — re-fetch at most every 2 s
  const TOAST_TTL  = 5000   // ms — how long the "synced" toast stays visible

  const attached   = new WeakSet()
  const delaying   = new WeakMap()
  const justSeeked = new WeakMap()

  let cache        = null   // { latency, syncOffset, streaming, ts }
  let toastEl      = null   // single shared toast element
  let toastTimer   = null   // auto-hide timer

  // ── Sync server communication ──────────────────────────────────────────────

  async function fetchState() {
    if (cache && (Date.now() - cache.ts) < CACHE_TTL) return cache
    try {
      const res = await fetch(BASE_URL + '/', { cache: 'no-store' })
      if (!res.ok) return null
      const data = await res.json()
      cache = { ...data, ts: Date.now() }
      return cache
    } catch {
      return null
    }
  }

  async function postOffset(newOffsetMs) {
    try {
      const res = await fetch(BASE_URL + '/offset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncOffset: newOffsetMs }),
      })
      const data = await res.json()
      // Update cache so the next play event uses the new value immediately
      if (cache) cache.syncOffset = data.syncOffset
      return data.syncOffset
    } catch {
      return newOffsetMs
    }
  }

  // ── Toast overlay ──────────────────────────────────────────────────────────

  function ensureToast() {
    if (toastEl) return toastEl

    toastEl = document.createElement('div')
    toastEl.id = '__aireaudio_toast'
    toastEl.style.cssText = `
      all: initial;
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: rgba(20, 20, 22, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      color: #fff;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      transition: opacity 0.3s ease;
      pointer-events: auto;
      user-select: none;
    `
    document.documentElement.appendChild(toastEl)
    return toastEl
  }

  function showSyncing() {
    clearTimeout(toastTimer)
    const el = ensureToast()
    el.style.opacity = '1'
    el.style.pointerEvents = 'none'
    el.innerHTML = `
      <span style="all:initial;font-size:14px">⏱</span>
      <span style="all:initial;font-family:inherit;font-size:13px;color:#fff">AirAudio syncing…</span>
    `
  }

  function showSynced(offsetMs) {
    clearTimeout(toastTimer)
    const el = ensureToast()
    el.style.opacity = '1'
    el.style.pointerEvents = 'auto'

    const label = offsetMs === 0
      ? 'Synced'
      : offsetMs > 0
        ? `Synced  (+${offsetMs}ms)`
        : `Synced  (${offsetMs}ms)`

    el.innerHTML = `
      <span style="all:initial;font-size:14px;color:#00ff55">✓</span>
      <span style="all:initial;font-family:inherit;font-size:13px;color:#fff">${label}</span>
      <span style="all:initial;display:flex;gap:4px;margin-left:4px">
        <button id="__aa_minus" style="
          all:initial;font-family:inherit;font-size:11px;color:#8e8e93;
          background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);
          border-radius:5px;padding:2px 7px;cursor:pointer;line-height:1.4
        " title="Video is late — shift audio earlier">◀ −50ms</button>
        <button id="__aa_plus" style="
          all:initial;font-family:inherit;font-size:11px;color:#8e8e93;
          background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);
          border-radius:5px;padding:2px 7px;cursor:pointer;line-height:1.4
        " title="Audio is late — shift audio later">+50ms ▶</button>
      </span>
      <button id="__aa_close" style="
        all:initial;font-family:inherit;font-size:15px;color:#48484a;
        background:none;border:none;cursor:pointer;padding:0 0 0 4px;line-height:1
      ">✕</button>
    `

    document.getElementById('__aa_minus')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      const current = cache?.syncOffset ?? 0
      const next = await postOffset(current - 50)
      showSynced(next)
      resetHideTimer()
    })

    document.getElementById('__aa_plus')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      const current = cache?.syncOffset ?? 0
      const next = await postOffset(current + 50)
      showSynced(next)
      resetHideTimer()
    })

    document.getElementById('__aa_close')?.addEventListener('click', (e) => {
      e.stopPropagation()
      hideToast()
    })

    resetHideTimer()
  }

  function hideToast() {
    clearTimeout(toastTimer)
    if (!toastEl) return
    toastEl.style.opacity = '0'
    toastEl.style.pointerEvents = 'none'
  }

  function resetHideTimer() {
    clearTimeout(toastTimer)
    toastTimer = setTimeout(hideToast, TOAST_TTL)
  }

  // ── Video hooks ────────────────────────────────────────────────────────────

  function attach(video) {
    if (attached.has(video)) return
    attached.add(video)

    video.addEventListener('seeking', () => {
      justSeeked.set(video, true)
    })

    video.addEventListener('play', async () => {
      // Skip if this play was fired by our own video.play() resume call
      if (delaying.get(video)) {
        delaying.set(video, false)
        return
      }

      // Skip delay on seek-resume (already mid-video, already in sync)
      if (justSeeked.get(video)) {
        justSeeked.set(video, false)
        return
      }

      // Check the user's enable/disable toggle
      let enabled = true
      try {
        const stored = await chrome.storage.local.get('enabled')
        enabled = stored.enabled !== false
      } catch { /* proceed as enabled */ }
      if (!enabled) return

      // Fetch state from AirAudio
      const info = await fetchState()
      if (!info || !info.streaming) return

      const delayMs = Math.max(0, info.latency * 1000 + (info.syncOffset ?? 0))
      if (delayMs <= 0) return

      // Guard: video may have been paused during the async fetch
      if (video.paused) return

      // Pause, show syncing toast, wait, resume
      delaying.set(video, true)
      video.pause()
      showSyncing()

      await new Promise(resolve => setTimeout(resolve, delayMs))

      // Only resume if the user hasn't manually paused during the wait
      if (video.paused) {
        video.play().catch(() => { delaying.set(video, false) })
      }

      showSynced(info.syncOffset ?? 0)
    })
  }

  // ── Poll for offset changes pushed from the tray app ──────────────────────
  // When the user adjusts the slider in AirAudio the syncOffset changes on the
  // server. We detect it here and show the toast so the user gets in-browser
  // feedback without having to play/pause the video again.
  let lastPolledOffset = null

  setInterval(async () => {
    const info = await fetchState()
    if (!info || !info.streaming) { lastPolledOffset = null; return }
    if (lastPolledOffset !== null && info.syncOffset !== lastPolledOffset) {
      showSynced(info.syncOffset)
    }
    lastPolledOffset = info.syncOffset
  }, 1500)

  // Attach to videos already in the DOM
  document.querySelectorAll('video').forEach(attach)

  // Watch for dynamically added videos (YouTube, Netflix, etc.)
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        if (node.tagName === 'VIDEO') {
          attach(/** @type {HTMLVideoElement} */ (node))
        } else if (typeof node.querySelectorAll === 'function') {
          node.querySelectorAll('video').forEach(attach)
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true })

})()
