import React from 'react';

export interface MprisState {
  title?: string;
  artist?: string;
  player?: string;
  isPlaying?: boolean;
}

export interface PeerDevice {
  deviceId: string;
  name: string;
  ipAddress?: string;
  // How this device is reached right now: on the local network, or through Tailscale.
  link?: 'lan' | 'remote';
  deviceType?: string;
  incomingCapabilities?: string[];
  outgoingCapabilities?: string[];
  trusted: boolean;
  isLocked?: boolean;
  isRinging?: boolean;
  battery?: { isCharging: boolean; currentCharge: number };
  flashlight?: boolean;
  dnd?: { enabled: boolean; granted: boolean };
  connected?: boolean;
  allowedCapabilities?: string[];
  mprisState?: MprisState;
  driveLetter?: string;
}

export interface VolumeSink {
  name: string;
  description: string;
  volume: number;
  muted: boolean;
  maxVolume?: number;
}

export interface CommandEntry {
  name: string;
  command: string;
}

export interface PairedSession {
  deviceId: string;
  deviceName: string;
  token: string;
  host: string;
}

export function upsertPairedSession(
  setter: React.Dispatch<React.SetStateAction<Map<string, PairedSession>>>,
  peers: Map<string, PeerDevice>,
  deviceId: string,
  token: string,
  host: string
) {
  const peerName = peers.get(deviceId)?.name || deviceId.slice(0, 8);
  setter((prev) => {
    const copy = new Map(prev);
    copy.set(deviceId, { deviceId, deviceName: peerName, token, host });
    return copy;
  });
}

export function removePairedSession(
  setter: React.Dispatch<React.SetStateAction<Map<string, PairedSession>>>,
  deviceId: string
) {
  setter((prev) => {
    const copy = new Map(prev);
    copy.delete(deviceId);
    return copy;
  });
}
