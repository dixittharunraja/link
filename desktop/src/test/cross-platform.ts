// Cross-platform test: this Node/TypeScript client connects to the REAL running Android app
// (via `adb reverse`) to prove the wire protocol actually interoperates between the two
// independent language implementations (Node here, Java on the phone). Auto-accepts pairing
// in code instead of needing to drive a GUI confirm() dialog.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadOrCreateIdentity } from '../core/identity';
import { loadOrCreateTlsIdentity } from '../core/tls';
import { TrustStore } from '../core/trust';
import { DeviceManager } from '../core/device-manager';
import { createClipboardPacket, isClipboardPacket } from '../core/plugins/clipboard';
import { isBatteryPacket } from '../core/plugins/battery';
import { createFindMyPhonePacket } from '../core/plugins/findmyphone';
import { isRunCommandRequestPacket, RunCommandManager } from '../core/plugins/runcommand';
import {
  isLockPacket,
  isLockRequestPacket,
  createLockRequestPacket,
  createLockPacket,
} from '../core/plugins/lockdevice';
import { isConnectivityPacket, ConnectivityBody } from '../core/plugins/connectivity';
import { createMprisStatePacket, isMprisRequestPacket, MprisRequest } from '../core/plugins/mpris';

const CAPABILITIES = {
  incoming: [
    'link.clipboard', 'link.clipboard.connect', 'link.battery',
    'link.findmyphone.request', 'link.runcommand.request', 'link.share.request',
    'link.lock', 'link.lock.request', 'link.connectivity_report', 'link.mpris.request',
  ],
  outgoing: [
    'link.clipboard', 'link.clipboard.connect', 'link.battery',
    'link.findmyphone.request', 'link.runcommand', 'link.share.request',
    'link.lock', 'link.lock.request', 'link.mpris',
  ],
};
const PHONE_HOST = '192.168.137.41'; // phone's real WiFi IP — same subnet as this PC, no adb tunnel needed
const PHONE_PORT = 1739;

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function main() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-crossplatform-'));
  const identity = loadOrCreateIdentity(configDir, 'desktop', CAPABILITIES);
  const tls = loadOrCreateTlsIdentity(configDir, identity.deviceId);
  const trust = new TrustStore(configDir);
  const runCommandManager = new RunCommandManager(configDir);
  const manager = new DeviceManager({ cert: tls.cert, key: tls.key, myIdentity: identity }, trust, 19999);

  log(`Test client identity: ${identity.deviceName} (${identity.deviceId})`);

  let phoneDeviceId: string | null = null;

  manager.on('deviceConnected', (peerIdentity, trusted) => {
    phoneDeviceId = peerIdentity.deviceId;
    log(`Connected to phone: ${peerIdentity.deviceName} (${peerIdentity.deviceId}), trusted=${trusted}`);
    if (!trusted) {
      log('Requesting pairing...');
      manager.requestPairing(peerIdentity.deviceId);
    }
  });

  manager.on('incomingPairRequest', (deviceId, verificationKey) => {
    log(`Incoming pair request from ${deviceId}, verification key: ${verificationKey} — auto-accepting`);
    manager.acceptPairing(deviceId);
  });

  manager.on('pairingSuccessful', async (deviceId) => {
    log(`✅ PAIRING SUCCESSFUL with ${deviceId}`);
    log('Sending clipboard and findmyphone packets (fire-and-forget — check phone logcat/listen for the ring)...');
    manager.sendTo(deviceId, createClipboardPacket('clipboard sync test from Node <-> Android'));
    manager.sendTo(deviceId, createFindMyPhonePacket());


    log('Querying phone lock state...');
    manager.sendTo(deviceId, createLockRequestPacket(undefined, true));

    log('Sending initial MPRIS state...');
    manager.sendTo(deviceId, createMprisStatePacket([]));

    log('Now testing the REVERSE directions: copy any text, send a file, or tap "Lock" / "Query Lock" on the phone, in the next 90 seconds...');
  });

  manager.on('pairingFailed', (deviceId, reason) => {
    log(`❌ Pairing failed: ${reason}`);
  });

  manager.on('packet', (deviceId, packet) => {
    log(`[Packet Received] type=${packet.type}`);
    if (isBatteryPacket(packet)) {
      const body = packet.body as { isCharging: boolean; currentCharge: number };
      log(`✅ BATTERY RECEIVED from phone — ${body.currentCharge}% charging=${body.isCharging}`);
    }
    if (isRunCommandRequestPacket(packet)) {
      const body = packet.body as { requestCommandList?: boolean; key?: string };
      if (body.requestCommandList) {
        log('✅ RUNCOMMAND: phone requested command list — responding');
      } else if (body.key) {
        log(`✅ RUNCOMMAND: phone triggered key "${body.key}" — executing`);
      }
      const response = runCommandManager.handleRunCommandRequest(packet);
      if (response) manager.sendTo(deviceId, response);
    }
    if (isClipboardPacket(packet)) {
      const text = (packet.body as any).content;
      if (!text) {
        log(`(ignoring empty-content clipboard packet — not a real copy)`);
        return;
      }
      log(`✅ REVERSE CLIPBOARD SYNC CONFIRMED — received from phone: "${text}"`);
    }
    if (isLockPacket(packet)) {
      const body = packet.body as { isLocked?: boolean; lockResult?: boolean };
      log(`✅ LOCK RECEIVED — isLocked=${body.isLocked} lockResult=${body.lockResult}`);
    }
    if (isLockRequestPacket(packet)) {
      const body = packet.body as { setLocked?: boolean; requestLocked?: boolean };
      log(`✅ LOCK REQUEST RECEIVED — setLocked=${body.setLocked} requestLocked=${body.requestLocked}`);
      if (body.setLocked) {
        log('Executing mock desktop lock (sending lockResult=true)');
        manager.sendTo(deviceId, createLockPacket(true, true));
      } else if (body.requestLocked) {
        manager.sendTo(deviceId, createLockPacket(false));
      }
    }
    if (isConnectivityPacket(packet)) {
      const body = packet.body as ConnectivityBody;
      log(`✅ CONNECTIVITY RECEIVED from phone — ${JSON.stringify(body.signalStrengths)}`);
    }
    if (isMprisRequestPacket(packet)) {
      const body = packet.body as MprisRequest;
      log(`✅ MPRIS REQUEST RECEIVED — action=${body.action} player=${body.player}`);
    }
  });

  manager.on('deviceDisconnected', (deviceId) => {
    log(`Device disconnected: ${deviceId}`);
  });

  log(`Connecting to phone at ${PHONE_HOST}:${PHONE_PORT}...`);
  await manager.connectTo(PHONE_HOST, PHONE_PORT);

  setTimeout(() => {
    log('Test window ended.');
    process.exit(0);
  }, 90000);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
