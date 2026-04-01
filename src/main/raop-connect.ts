/**
 * createRaopClient — wraps RaopClient.create() with a 403 retry.
 *
 * The @basmilius/apple-raop library only calls authSetup() for AirPort-named
 * devices. Many 3rd-party AirPlay receivers (e.g. Elac OD-11, Sonos, etc.)
 * also require the auth-setup POST to /auth-setup before ANNOUNCE, otherwise
 * they respond with 403 Forbidden.
 */

import { TimingServer, type DiscoveryResult } from '@basmilius/apple-common'
import { RaopClient } from '@basmilius/apple-raop'

export async function createRaopClient(
  result: DiscoveryResult,
  timingServer: TimingServer,
): Promise<RaopClient> {
  try {
    return await RaopClient.create(result, timingServer)
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (!msg.includes('403')) throw err

    // Patch TXT record to force authSetup() for 3rd-party devices.
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
