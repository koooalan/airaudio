/**
 * Tiny HTTP server that exposes the current AirPlay latency to the
 * AirAudio browser extension so it can delay video playback to match.
 *
 * GET  http://127.0.0.1:17374/
 * → { "latency": 1.0, "syncOffset": 0, "streaming": true }
 *
 * POST http://127.0.0.1:17374/offset
 * ← { "syncOffset": -150 }
 * → { "syncOffset": -150 }
 * Lets the in-browser overlay fine-tune the offset without opening the app.
 *
 * No npm dependencies — uses Node built-in `http`.
 * Binds only to loopback (127.0.0.1) — never exposed on the LAN.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { RaopManager } from './raop-manager.js'

export const SYNC_SERVER_PORT = 17374

export interface SyncServer {
  stop(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

export function createSyncServer(
  manager: RaopManager,
  onOffsetChange?: (ms: number) => void,
): SyncServer {
  const server: Server = createServer(async (req, res) => {
    cors(res)

    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // GET / — return current state
    if (req.method === 'GET') {
      const body = JSON.stringify({
        latency:    manager.latencySeconds,
        syncOffset: manager.syncOffsetMs,
        streaming:  manager.state === 'streaming',
      })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
      res.end(body)
      return
    }

    // POST /offset — update sync offset from extension overlay
    if (req.method === 'POST' && req.url === '/offset') {
      try {
        const raw = await readBody(req)
        const { syncOffset } = JSON.parse(raw) as { syncOffset: number }
        if (typeof syncOffset !== 'number' || !isFinite(syncOffset)) throw new Error('invalid')
        const clamped = Math.min(2500, Math.max(-2500, Math.round(syncOffset)))
        onOffsetChange?.(clamped)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ syncOffset: clamped }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad request' }))
      }
      return
    }

    res.writeHead(404)
    res.end()
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE')
      console.warn(`[sync-server] port ${SYNC_SERVER_PORT} already in use — AV sync disabled`)
    else
      console.error('[sync-server] error:', err.message)
  })

  server.listen(SYNC_SERVER_PORT, '127.0.0.1', () => {
    console.log(`[sync-server] listening on http://127.0.0.1:${SYNC_SERVER_PORT}`)
  })

  return {
    stop(): Promise<void> {
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}
