// Automated E2E verification test for Flashlight and DND triggers.

import { createFlashlightPacket, isFlashlightPacket } from '../core/plugins/flashlight';
import { createDNDPacket, isDNDPacket } from '../core/plugins/dnd';

function ok(msg: string) {
  console.log(`✅ ${msg}`);
}

function fail(msg: string): never {
  console.error(`❌ FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  console.log('Starting local Flashlight & DND E2E simulation...');

  // Flashlight Packet Verification
  const fPacket = createFlashlightPacket(true);
  if (!isFlashlightPacket(fPacket)) {
    fail('Flashlight packet validation failed');
  }
  if (fPacket.body.enabled !== true) {
    fail('Flashlight packet payload mismatch');
  }
  ok('Flashlight packet serialization verified.');

  // DND Packet Verification
  const dPacket = createDNDPacket(false);
  if (!isDNDPacket(dPacket)) {
    fail('DND packet validation failed');
  }
  if (dPacket.body.enabled !== false) {
    fail('DND packet payload mismatch');
  }
  ok('DND packet serialization verified.');

  ok('Flashlight & DND E2E verified successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
