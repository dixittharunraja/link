// Shared interfaces for guest-session servers (Audio Sink, Portal, Walkie Talkie, Joystick).

import WebSocket from 'ws';

export interface PendingGuest {
  ws: WebSocket;
  pin: string;
  timeout: NodeJS.Timeout | null;
  remoteAddress: string;
  deviceName?: string;
}

export interface AdmittedGuest {
  ws: WebSocket;
  remoteAddress: string;
  deviceName?: string;
}
