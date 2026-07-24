import * as dgram from 'dgram';
import * as os from 'os';
import { LinkPacket } from './packet';

/**
 * Per-interface subnet broadcast addresses (ip | ~netmask), mirroring Android's DHCP-based
 * calculation in LinkDiscovery.getBroadcastAddress(). A bare 255.255.255.255 send lets the OS
 * pick whichever interface it considers "default" — on a machine with multiple adapters (VPN,
 * Hyper-V/Docker virtual switches, a second NIC) that can silently be the wrong one, so the
 * broadcast never reaches the LAN segment a peer is actually on. Broadcasting on every real
 * interface's own subnet address removes that guesswork.
 */
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

// Shortened from an earlier 5000ms — combined with the heartbeat cycle now detecting a dead peer
// within ~9s instead of relying on slow/opaque OS TCP keepalive, a snappier rebroadcast means
// less time sitting between "peer confirmed dead" and "next chance to rediscover it."
const DISCOVERY_INTERVAL_MS = 3000;

export class DiscoveryService {
  private socket: dgram.Socket | null = null;
  private interval: NodeJS.Timeout | null = null;
  private visibilityEnabled = true;

  constructor(
    private localIdentity: any,
    private onDeviceDiscovered: (ip: string, identity: any) => void
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
            this.onDeviceDiscovered(rinfo.address, packet.body);
          }
        }
      } catch (err) {
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
    if (!this.visibilityEnabled || !this.socket) return;
    try {
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
    } catch (err) {
      // Ignore transient transmit errors
    }
  }

  private startBroadcasting() {
    if (this.interval) return;
    // setInterval's first tick fires only after the full delay — without this, a device that just
    // launched or just re-enabled visibility stayed invisible to peers for up to a full interval
    // for no reason, when there's nothing to wait for.
    this.broadcastOnce();
    this.interval = setInterval(() => this.broadcastOnce(), DISCOVERY_INTERVAL_MS);
  }

  private stopBroadcasting() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  stop() {
    this.stopBroadcasting();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
  }
}
