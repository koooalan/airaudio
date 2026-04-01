// AirAudio — popup script

const SYNC_URL      = 'http://localhost:17374/'
const POLL_INTERVAL = 1500   // ms

const dotEl      = document.getElementById('dot')
const statusEl   = document.getElementById('status')
const latencyEl  = document.getElementById('latency')

async function refresh() {
  try {
    const res = await fetch(SYNC_URL, { cache: 'no-store' })
    if (!res.ok) throw new Error('bad status')
    const data = await res.json()

    if (data.streaming) {
      dotEl.className       = 'dot streaming'
      statusEl.textContent  = 'Streaming'
      latencyEl.textContent = `${data.latency.toFixed(1)} s delay`
    } else {
      dotEl.className       = 'dot idle'
      statusEl.textContent  = 'Not streaming'
      latencyEl.textContent = `${data.latency.toFixed(1)} s`
    }
  } catch {
    dotEl.className       = 'dot idle'
    statusEl.textContent  = 'AirAudio not running'
    latencyEl.textContent = ''
  }
}

refresh()
setInterval(refresh, POLL_INTERVAL)
