// Automated E2E verification test for link.clipboard.file sync.
// Spins up two local virtual devices, pairs them, transfers a simulated file clipboard payload,
// and verifies that the payload is received and matches the source data.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadOrCreateIdentity } from '../core/identity';
import { loadOrCreateTlsIdentity } from '../core/tls';
import { TrustStore } from '../core/trust';
import { DeviceManager } from '../core/device-manager';
import { createPacket } from '../core/packet';
import { startPayloadUpload, downloadPayload } from '../core/payload-transfer';

const CAPABILITIES = {
  incoming: ['link.clipboard.file'],
  outgoing: ['link.clipboard.file'],
};

function makeDevice(name: string, port: number) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `link-clip-e2e-${name}-`));
  const identity = loadOrCreateIdentity(configDir, 'desktop', CAPABILITIES);
  const tls = loadOrCreateTlsIdentity(configDir, identity.deviceId);
  const trust = new TrustStore(configDir);
  const manager = new DeviceManager({ cert: tls.cert, key: tls.key, myIdentity: identity }, trust, port);
  return { configDir, identity, manager, tls };
}

function ok(msg: string) {
  console.log(`✅ ${msg}`);
}

function fail(msg: string): never {
  console.error(`❌ FAIL: ${msg}`);
  process.exit(1);
}

async function waitFor(cond: () => boolean, desc: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${desc}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  const a = makeDevice('A', 18391);
  const b = makeDevice('B', 18392);

  let aConnected = false;
  let bConnected = false;
  a.manager.on('deviceConnected', (identity, trusted) => {
    if (identity.deviceId === b.identity.deviceId) {
      aConnected = true;
    }
  });
  b.manager.on('deviceConnected', (identity, trusted) => {
    if (identity.deviceId === a.identity.deviceId) {
      bConnected = true;
    }
  });

  b.manager.on('incomingPairRequest', (deviceId, key) => {
    b.manager.acceptPairing(deviceId);
  });

  let aPaired = false;
  let bPaired = false;
  a.manager.on('pairingSuccessful', () => { aPaired = true; });
  b.manager.on('pairingSuccessful', () => { bPaired = true; });

  await a.manager.connectTo('127.0.0.1', 18392);
  await waitFor(() => aConnected && bConnected, 'initial connection');

  a.manager.requestPairing(b.identity.deviceId);
  await waitFor(() => aPaired && bPaired, 'pairing to succeed');
  ok('Devices successfully paired');

  // --- Test link.clipboard.file ---
  const testFileName = 'ClipboardImage_test.png';
  const testFileData = Buffer.from('Fake PNG binary data content for verification ' + Date.now(), 'utf-8');
  let receivedData: Buffer | null = null;
  let receivedFileName: string | null = null;

  b.manager.on('packet', (deviceId, packet) => {
    if (packet.type === 'link.clipboard.file') {
      (async () => {
        try {
          const senderHost = b.manager.remoteAddressOf(deviceId);
          const expectedFingerprint = b.manager.pinnedFingerprintOf(deviceId);
          if (!senderHost || !expectedFingerprint) return;

          const transferInfo = packet.payloadTransferInfo as { port: number } | undefined;
          if (!transferInfo || typeof transferInfo.port !== 'number') {
            fail('Received clip file packet without payloadTransferInfo.port');
          }
          receivedFileName = (packet.body as { filename: string }).filename;
          receivedData = await downloadPayload(senderHost, transferInfo.port, b.tls.cert, b.tls.key, expectedFingerprint);
        } catch (err: any) {
          fail(`Download failed: ${err.message}`);
        }
      })();
    }
  });

  // A starts upload and sends packet
  const upload = await startPayloadUpload(a.tls.cert, a.tls.key, testFileData);
  const packet = createPacket('link.clipboard.file', { filename: testFileName });
  packet.payloadTransferInfo = upload.info as any;
  a.manager.sendTo(b.identity.deviceId, packet);

  await waitFor(() => receivedData !== null, 'clipboard file payload to be received');

  if (receivedFileName !== testFileName) {
    fail(`Filename mismatch: expected ${testFileName}, got ${receivedFileName}`);
  }
  if (!receivedData || !(receivedData as Buffer).equals(testFileData)) {
    fail('Received file data does not match sent data');
  }

  ok('E2E Clipboard File Sync verified successfully!');

  // Cleanup
  a.manager.unpair(b.identity.deviceId);
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
