/**
 * AirAudio MVP — stream audio to an AirPlay receiver.
 *
 * Usage:
 *   npm run mvp                          # WASAPI loopback (system audio)
 *   npm run mvp -- --file path/to/song   # stream a file instead
 *   npm run mvp -- --device <id>         # target a specific device ID
 *   npm run mvp -- --volume 70           # set volume (0-100, default 80)
 *
 * Run `npm run mvp:discover` first to see available device IDs.
 */

import { Context, Discovery, TimingServer, reporter } from '@basmilius/apple-common'
// Context is used to initialize identity before RaopClient.create()
// reporter.all() // Uncomment to enable verbose RTSP debug logging
import { FileAudioSource, LoopbackSource, listAudioDevices } from './sources.js'
import { createRaopClient } from './raop-connect.js'

// --- Parse CLI args ---
const args = process.argv.slice(2)
const getArg = (flag: string) => {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}

const targetDeviceId = getArg('--device')
const filePath = getArg('--file')
const volume = Number(getArg('--volume') ?? '80')
const deviceName = getArg('--device-name') ?? 'Stereo Mix'

// List dshow audio devices and exit
if (args.includes('--list-devices')) {
  const devices = await listAudioDevices()
  if (devices.length === 0) {
    console.log('No DirectShow audio capture devices found.')
    console.log('To capture system audio, enable "Stereo Mix" in Windows sound settings')
    console.log('or install VB-Audio Virtual Cable: https://vb-audio.com/Cable/')
  } else {
    console.log('Available audio capture devices:')
    for (const d of devices) console.log(`  "${d}"`)
    console.log('\nUse: npm run mvp -- --device-name "Device Name"')
  }
  process.exit(0)
}

// --- Discover devices ---
console.log('Searching for AirPlay devices...')
const discovery = Discovery.raop()
const devices = await discovery.find(false)

if (devices.length === 0) {
  console.error('No AirPlay devices found on the network.')
  process.exit(1)
}

let target = targetDeviceId
  ? devices.find(d => d.id === targetDeviceId)
  : devices[0]

if (!target) {
  console.error(`Device "${targetDeviceId}" not found. Run npm run mvp:discover to list devices.`)
  process.exit(1)
}

// Extract friendly name from RAOP fqdn (format: "MACADDR@Name._raop._tcp.local")
const atIdx = target.fqdn.indexOf('@')
const dotIdx = target.fqdn.indexOf('._raop')
const friendlyName = atIdx !== -1 && dotIdx !== -1
  ? target.fqdn.slice(atIdx + 1, dotIdx)
  : target.modelName

console.log(`Connecting to: ${friendlyName} (${target.address}:${target.service.port})`)
console.log(`  TXT: et=${target.txt['et'] ?? '?'}  am=${target.txt['am'] ?? '?'}  cn=${target.txt['cn'] ?? '?'}  pw=${target.txt['pw'] ?? 'false'}`)

// --- Start timing server ---
const timingServer = new TimingServer()
await timingServer.listen()

new Context(target.id)

let client
try {
  client = await createRaopClient(target, timingServer, { verbose: true })
} catch (err) {
  console.error('Failed to connect:', (err as Error).message)
  console.error()
  console.error('Troubleshooting:')
  console.error('  • Is the device on the same network?')
  console.error('  • Is the device already streaming from another source?')
  console.error('  • Does the device require a password? (pw=true in TXT)')
  console.error('  • Is this an AirPlay 2 only device? (may need HomeKit pairing)')
  timingServer.close()
  process.exit(1)
}

const safeInfo = JSON.stringify(client.info, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2)
console.log(`Connected! Device info:`, safeInfo)


// --- Set up audio source ---
const source = filePath ? new FileAudioSource(filePath) : new LoopbackSource(deviceName)
const sourceLabel = filePath ? `file: ${filePath}` : `dshow "${deviceName}" (system audio)`

console.log(`\nStreaming ${sourceLabel} at volume ${volume}%`)
console.log('Press Ctrl+C to stop.\n')

// --- Handle Ctrl+C gracefully ---
process.on('SIGINT', async () => {
  console.log('\nStopping...')
  client.stop()
})

client.on('playing', (info) => {
  console.log(`▶ Now streaming — position: ${info.position} frames`)
})

client.on('stopped', () => {
  console.log('■ Stream stopped.')
})

// --- Stream ---
try {
  await client.stream(source, {
    volume,
    metadata: filePath ? {
      title: filePath.split(/[/\\]/).pop() ?? 'Unknown',
      artist: 'AirAudio',
      album: 'AirAudio',
      duration: source.duration,
    } : {
      title: 'System Audio',
      artist: 'AirAudio',
      album: 'Windows',
      duration: 0, // Live stream — no defined duration
    },
  })
} catch (err) {
  const e = err as Error
  console.error('Streaming error:', e.message)
  if (e.cause) console.error('Caused by:', (e.cause as Error).message)
} finally {
  await client.close()
  timingServer.close()
  process.exit(0)
}
