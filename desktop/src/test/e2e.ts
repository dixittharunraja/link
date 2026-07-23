// End-to-end smoke test: two devices, connect, pair, unpair, packet round-trip — run against the
// actual transport/pairing/trust modules (no Electron, no GUI). This is the automated equivalent
// of the manual "run two instances, click Pair" test.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadOrCreateIdentity } from '../core/identity';
import { loadOrCreateTlsIdentity } from '../core/tls';
import { TrustStore } from '../core/trust';
import { DeviceManager } from '../core/device-manager';
import { isClipboardPacket, createClipboardPacket } from '../core/plugins/clipboard';

const CAPABILITIES = { incoming: ['link.clipboard'], outgoing: ['link.clipboard'] };

function makeDevice(name: string, port: number) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `link-e2e-${name}-`));
  const identity = loadOrCreateIdentity(configDir, 'desktop', CAPABILITIES);
  const tls = loadOrCreateTlsIdentity(configDir, identity.deviceId);
  const trust = new TrustStore(configDir);
  const manager = new DeviceManager({ cert: tls.cert, key: tls.key, myIdentity: identity }, trust, port);
  return { configDir, identity, manager };
}

function fail(msg: string): never {
  console.error(`❌ FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg: string) {
  console.log(`✅ ${msg}`);
}

async function main() {
  const a = makeDevice('A', 17391);
  const b = makeDevice('B', 17392);

  console.log(`Device A: ${a.identity.deviceName} (${a.identity.deviceId})`);
  console.log(`Device B: ${b.identity.deviceName} (${b.identity.deviceId})`);

  let aConnected = false;
  let bConnected = false;
  a.manager.on('deviceConnected', (identity, trusted) => {
    if (identity.deviceId === b.identity.deviceId) {
      aConnected = true;
      ok(`A sees B connected (trusted=${trusted})`);
    }
  });
  b.manager.on('deviceConnected', (identity, trusted) => {
    if (identity.deviceId === a.identity.deviceId) {
      bConnected = true;
      ok(`B sees A connected (trusted=${trusted})`);
    }
  });

  // B auto-accepts any incoming pair request (simulates the user clicking "Accept").
  b.manager.on('incomingPairRequest', (deviceId, verificationKey) => {
    ok(`B received incoming pair request from ${deviceId}, verification key: ${verificationKey}`);
    b.manager.acceptPairing(deviceId);
  });

  let aPaired = false;
  let bPaired = false;
  a.manager.on('pairingSuccessful', () => {
    aPaired = true;
    ok('A: pairingSuccessful');
  });
  b.manager.on('pairingSuccessful', () => {
    bPaired = true;
    ok('B: pairingSuccessful');
  });

  a.manager.on('pairingFailed', (id, reason) => fail(`A pairing failed: ${reason}`));
  b.manager.on('pairingFailed', (id, reason) => fail(`B pairing failed: ${reason}`));
  a.manager.on('trustMismatch', () => fail('A: unexpected trust mismatch'));
  b.manager.on('trustMismatch', () => fail('B: unexpected trust mismatch'));

  await a.manager.connectTo('127.0.0.1', 17392);
  await waitFor(() => aConnected && bConnected, 'initial connection');

  a.manager.requestPairing(b.identity.deviceId);
  await waitFor(() => aPaired && bPaired, 'pairing to complete');

  // --- Packet round-trip (clipboard) ---
  let clipboardReceived = false;
  b.manager.on('packet', (deviceId, packet) => {
    if (isClipboardPacket(packet) && (packet.body as { content?: string }).content === 'hello from e2e test') {
      clipboardReceived = true;
      ok('B received clipboard packet with correct content');
    }
  });
  a.manager.sendTo(b.identity.deviceId, createClipboardPacket('hello from e2e test'));
  await waitFor(() => clipboardReceived, 'clipboard round-trip');

  // --- Unpair cleanup (both sides) ---
  a.manager.unpair(b.identity.deviceId);
  await new Promise((r) => setTimeout(r, 300));

  const bTrust = new TrustStore(b.configDir);
  const aTrust = new TrustStore(a.configDir);
  if (aTrust.isPaired(b.identity.deviceId)) fail('A still has B trusted after unpair');
  if (bTrust.isPaired(a.identity.deviceId)) fail('B still has A trusted after unpair (receiving-side cleanup broken)');
  ok('Unpair cleaned up trust on BOTH sides');

  console.log('\n🎉 All checks passed.');
  process.exit(0);
}

function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (cond()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        fail(`Timed out waiting for: ${label}`);
      }
    }, 50);
  });
}

main().catch((err) => fail(err.stack || String(err)));
