/**
 * Discover AirPlay (RAOP) devices on the local network.
 * Run: npm run mvp:discover
 */

import { Discovery } from '@basmilius/apple-common'

// Human-readable hints for known TXT fields
function etHint(val: string): string {
  const nums = val.split(',').map(Number)
  const flags: string[] = []
  if (nums.includes(0)) flags.push('Unencrypted')
  if (nums.includes(1)) flags.push('RSA/AES')
  if (nums.includes(3)) flags.push('FairPlay')
  if (nums.includes(4)) flags.push('MFi-SAP')
  if (nums.includes(5)) flags.push('FairPlay 2.5')
  return flags.length ? `  (${flags.join(', ')})` : ''
}

function cnHint(val: string): string {
  const nums = val.split(',').map(Number)
  const codecs: string[] = []
  if (nums.includes(0)) codecs.push('PCM')
  if (nums.includes(1)) codecs.push('ALAC')
  if (nums.includes(2)) codecs.push('AAC')
  if (nums.includes(4)) codecs.push('AAC-ELD')
  return codecs.length ? `  (${codecs.join(', ')})` : ''
}

console.log('Searching for AirPlay (RAOP) devices on the network...\n')

const discovery = Discovery.raop()
const devices = await discovery.find(false)

if (devices.length === 0) {
  console.log('No AirPlay devices found. Make sure they are on the same network.')
  process.exit(0)
}

console.log(`Found ${devices.length} device(s):\n`)

for (const device of devices) {
  // RAOP fqdn format: "MACADDRESS@Device Name._raop._tcp.local"
  // Extract friendly name from fqdn
  const atIdx = device.fqdn.indexOf('@')
  const dotIdx = device.fqdn.indexOf('._raop')
  const friendlyName = atIdx !== -1 && dotIdx !== -1
    ? device.fqdn.slice(atIdx + 1, dotIdx)
    : device.modelName

  console.log(`  Name:    ${friendlyName}`)
  console.log(`  Address: ${device.address}:${device.service.port}`)
  console.log(`  ID:      ${device.id}`)
  console.log(`  TXT record:`)
  for (const [k, v] of Object.entries(device.txt)) {
    const hint = k === 'et' ? etHint(v) : k === 'cn' ? cnHint(v) : ''
    console.log(`    ${k.padEnd(6)} = ${v}${hint}`)
  }
  console.log()
}

process.exit(0)
