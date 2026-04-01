import { createSocket } from 'node:dgram'
import { createConnection } from 'node:net'

/**
 * Parse the MAC address embedded in a RAOP device ID.
 * Format: "78A5042AA5FB@OD-11-sovrum.local" → "78:A5:04:2A:A5:FB"
 */
export function parseMacFromDeviceId(deviceId: string): string | null {
  const atIdx = deviceId.indexOf('@')
  if (atIdx === -1) return null
  const hex = deviceId.slice(0, atIdx)
  if (hex.length !== 12 || !/^[0-9A-Fa-f]{12}$/.test(hex)) return null
  return hex.match(/.{2}/g)!.join(':').toUpperCase()
}

/**
 * Send a Wake-on-LAN magic packet to the given MAC address.
 * Broadcasts on port 9 (standard WoL port).
 */
export function sendWakeOnLan(mac: string, broadcast = '255.255.255.255'): Promise<void> {
  return new Promise((resolve, reject) => {
    const bytes = mac.split(':').map((b) => parseInt(b, 16))
    if (bytes.length !== 6 || bytes.some(isNaN)) {
      return reject(new Error(`Invalid MAC: ${mac}`))
    }

    // Magic packet: 6×0xFF followed by 16 repetitions of the 6-byte MAC
    const packet = Buffer.alloc(102)
    packet.fill(0xff, 0, 6)
    for (let i = 0; i < 16; i++) {
      bytes.forEach((b, j) => { packet[6 + i * 6 + j] = b })
    }

    const sock = createSocket('udp4')
    sock.once('error', (err) => { sock.close(); reject(err) })
    sock.bind(() => {
      sock.setBroadcast(true)
      sock.send(packet, 0, packet.length, 9, broadcast, (err) => {
        sock.close()
        if (err) reject(err)
        else resolve()
      })
    })
  })
}

/**
 * Attempt a TCP connection to host:port.
 * Resolves true if the connection succeeds within timeoutMs, false otherwise.
 */
export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port, timeout: timeoutMs })
    const done = (result: boolean) => {
      sock.destroy()
      resolve(result)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.once('timeout', () => done(false))
  })
}
