import * as dgram from 'dgram';
import * as os from 'os';
import * as crypto from 'crypto';
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
    private myCertFingerprint?: string,
    private resolveAnonToken?: (token: string) => any,
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
        } else if (packet.type === 'link.identity.anon' && packet.body?.token) {
          // Anonymous token broadcast from a trusted peer in "Trusted Devices Only" mode.
          if (this.resolveAnonToken) {
            const matched = this.resolveAnonToken(packet.body.token);
            if (matched && matched.deviceId !== this.localIdentity.deviceId) {
              this.discoveredPeers.set(matched.deviceId, {
                ip: rinfo.address,
                lastSeen: Date.now(),
              });
              this.onDeviceDiscovered(rinfo.address, {
                deviceId: matched.deviceId,
                deviceName: matched.deviceName,
                deviceType: 'phone',
                visibility: false,
              });
            }
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
      this.startBroadcasting();
      this.startExpiryCheck();
    });
  }

  setVisibility(enabled: boolean) {
    this.visibilityEnabled = enabled;
    this.broadcastOnce();
  }

  broadcastNow() {
    this.broadcastOnce();
  }

  private broadcastOnce() {
    if (!this.socket) return;
    try {
      let packet: any;
      if (this.visibilityEnabled) {
        // Mode 1: Visible to Everyone — announcements with real device name & ID
        this.localIdentity.visibility = true;
        packet = {
          id: Date.now(),
          type: 'link.identity',
          body: this.localIdentity,
        };
      } else {
        // Mode 2: Trusted Devices Only — anonymous token that only paired devices can recognize
        const token = crypto
          .createHash('sha256')
          .update(this.localIdentity.deviceId + ':' + (this.myCertFingerprint || ''))
          .digest('hex')
          .substring(0, 32);
        packet = {
          id: Date.now(),
          type: 'link.identity.anon',
          body: {
            token,
            port: 1716,
          },
        };
      }
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
