import * as dgram from 'dgram';
import * as os from 'os';
import { LinkPacket } from './packet';

// Broadcast on each interface's own subnet, not 255.255.255.255 (picks wrong one on VPN/Docker).
function getInterfaceBroadcastAddresses(): string[] {
  const addresses: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const ipParts = net.address.split('.').map(Number);
      const maskParts = net.netmask.split('.').map(Number);
      if (ipParts.length !== 4 || maskParts.length !== 4) continue;
      const broadcastParts = ipParts.map((byte, i) => (byte | (~maskParts[i] & 0xff)) & 0xff);
      addresses.push(broadcastParts.join('.'));
    }
  }
  return addresses;
}

const DISCOVERY_INTERVAL_MS = 2000;
// 3x interval = buffer for Wi-Fi drops.
const PEER_EXPIRY_MS = DISCOVERY_INTERVAL_MS * 3;

export class DiscoveryService {
  private socket: dgram.Socket | null = null;
  private broadcastInterval: NodeJS.Timeout | null = null;
  private expiryInterval: NodeJS.Timeout | null = null;
  private visibilityEnabled = true;

  private discoveredPeers = new Map<string, { ip: string; lastSeen: number }>();

  constructor(
    private localIdentity: any,
    private onDeviceDiscovered: (ip: string, identity: any) => void,
    private onDeviceExpired?: (deviceId: string) => void,
  ) {}

  start(visibilityEnabled = true) {
    this.visibilityEnabled = visibilityEnabled;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('message', (msg, rinfo) => {
      try {
        const str = msg.toString('utf8').trim();
        const packet = JSON.parse(str) as LinkPacket;
        if (packet.type === 'link.identity') {
          if (packet.body.deviceId !== this.localIdentity.deviceId) {
            // Update the last-seen timestamp every time a broadcast arrives. This is the
            // heartbeat that keeps the peer alive in the expiry check below.
            this.discoveredPeers.set(packet.body.deviceId, {
              ip: rinfo.address,
              lastSeen: Date.now(),
            });
            this.onDeviceDiscovered(rinfo.address, packet.body);
          }
        }
      } catch {
        // Ignore parsing errors from other network traffic
      }
    });

    this.socket.on('error', (err) => {
      console.error('[Link] Discovery UDP socket error:', err);
    });

    this.socket.bind(1716, '0.0.0.0', () => {
      if (this.socket) {
        try {
          this.socket.setBroadcast(true);
        } catch (err) {
          console.warn('[Link] Failed to enable UDP broadcast flag:', err);
        }
      }
      if (this.visibilityEnabled) {
        this.startBroadcasting();
      }
      // Always start the expiry check regardless of visibility — we always listen for
      // other devices' broadcasts, so we always need to expire stale ones.
      this.startExpiryCheck();
    });
  }

  setVisibility(enabled: boolean) {
    this.visibilityEnabled = enabled;
    if (enabled) {
      this.startBroadcasting();
    } else {
      this.stopBroadcasting();
    }
  }

  private broadcastOnce() {
    if (!this.socket) return;
    try {
      this.localIdentity.visibility = true;
      const packet = {
        id: Date.now(),
        type: 'link.identity',
        body: this.localIdentity,
      };
      const payload = JSON.stringify(packet) + '\n';
      // Send on every real interface's own subnet broadcast address, not just the global limited-
      // broadcast address — see getInterfaceBroadcastAddresses() for why.
      const targets = getInterfaceBroadcastAddresses();
      if (targets.length === 0) targets.push('255.255.255.255');
      for (const addr of targets) {
        this.socket.send(payload, 0, payload.length, 1716, addr);
      }
    } catch {
      // Ignore transient transmit errors
    }
  }

  private startBroadcasting() {
    if (this.broadcastInterval) return;
    // setInterval's first tick fires only after the full delay — without this, a device that just
    // launched or just re-enabled visibility stayed invisible to peers for up to a full interval
    // for no reason, when there's nothing to wait for.
    this.broadcastOnce();
    this.broadcastInterval = setInterval(() => this.broadcastOnce(), DISCOVERY_INTERVAL_MS);
  }

  private stopBroadcasting() {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  /**
   * Periodically checks the last-seen timestamp for each discovered peer. If a peer has not
   * sent a UDP broadcast within PEER_EXPIRY_MS (3 missed intervals), it is considered gone
   * and the onDeviceExpired callback fires so the caller can close any open TCP connection.
   *
   * This makes discovery realtime: a device that toggles visibility OFF will stop sending
   * broadcasts, and will automatically disappear from every peer's Nearby list after ~9s.
   */
  private startExpiryCheck() {
    this.expiryInterval = setInterval(() => {
      const now = Date.now();
      for (const [deviceId, info] of this.discoveredPeers.entries()) {
        if (now - info.lastSeen > PEER_EXPIRY_MS) {
          this.discoveredPeers.delete(deviceId);
          this.onDeviceExpired?.(deviceId);
        }
      }
    }, DISCOVERY_INTERVAL_MS);
  }

  stop() {
    this.stopBroadcasting();
    if (this.expiryInterval) {
      clearInterval(this.expiryInterval);
      this.expiryInterval = null;
    }
    this.discoveredPeers.clear();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
  }
}
