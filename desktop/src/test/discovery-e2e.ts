// Automated E2E verification test for UDP Auto-Discovery.
// Spins up two local DiscoveryServices, binds them on port 1716 using reuseAddr,
// and verifies they successfully discover each other's broadcasted identities.

import { DiscoveryService } from '../core/discovery';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function ok(msg: string) {
  console.log(`✅ ${msg}`);
}

function fail(msg: string): never {
  console.error(`❌ FAIL: ${msg}`);
  process.exit(1);
}

async function waitFor(cond: () => boolean, desc: string, timeoutMs = 7000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${desc}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  const idA = { deviceId: 'device-aaa-' + Date.now(), deviceName: 'Device A', deviceType: 'desktop' };
  const idB = { deviceId: 'device-bbb-' + Date.now(), deviceName: 'Device B', deviceType: 'phone' };

  let discoveredA = false;
  let discoveredB = false;

  const serviceA = new DiscoveryService(idA, (ip, peer) => {
    if (peer.deviceId === idB.deviceId) {
      discoveredB = true;
      ok(`Device A discovered Device B at ${ip}`);
    }
  });

  const serviceB = new DiscoveryService(idB, (ip, peer) => {
    if (peer.deviceId === idA.deviceId) {
      discoveredA = true;
      ok(`Device B discovered Device A at ${ip}`);
    }
  });

  console.log('Starting local discovery services...');
  serviceA.start(true);
  serviceB.start(true);

  try {
    await waitFor(() => discoveredA && discoveredB, 'bidirectional discovery over UDP');
    ok('LAN UDP Broadcast Auto-Discovery verified successfully!');
    
    // Cleanup
    serviceA.stop();
    serviceB.stop();
    process.exit(0);
  } catch (err: any) {
    serviceA.stop();
    serviceB.stop();
    fail(err.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
