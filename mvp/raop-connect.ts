/**
 * createRaopClient — wraps RaopClient.create() with a 403 retry.
 *
 * The @basmilius/apple-raop library only calls authSetup() for AirPort-named
 * devices. Many 3rd-party AirPlay receivers (e.g. Elac OD-11, Sonos, etc.)
 * also require the auth-setup POST to /auth-setup before ANNOUNCE, otherwise
 * they respond with 403 Forbidden.
 *
 * This helper:
 *  1. Tries normal connection.
 *  2. On 403, retries with a patched DiscoveryResult that tricks the library
 *     into always calling authSetup() by setting am="AirPort…" and et="1".
 */

import { TimingServer, type DiscoveryResult } from '@basmilius/apple-common'
import { RaopClient } from '@basmilius/apple-raop'

export async function createRaopClient(
  result: DiscoveryResult,
  timingServer: TimingServer,
  { verbose = false } = {},
): Promise<RaopClient> {
  try {
    return await RaopClient.create(result, timingServer)
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (!msg.includes('403')) throw err

    if (verbose) {
      console.log('[raop] Got 403 on first attempt — retrying with forced auth-setup...')
    }

    // Patch TXT record to force the library to call authSetup() for this device.
    // et='1' → sets MFiSAP bit, am='AirPort <original>' → passes the AirPort check.
    const patchedResult: DiscoveryResult = {
      ...result,
      txt: {
        ...result.txt,
        am: `AirPort ${result.txt['am'] ?? 'Device'}`,
        et: result.txt['et'] ? `${result.txt['et']},1` : '1',
      },
    }

    return await RaopClient.create(patchedResult, timingServer)
  }
}
