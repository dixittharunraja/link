// Digitizer plugin — absolute positioning / graphics drawing tablet support.
// Tracks session dimensions and maps absolute coordinates to screen ratios,
// controlling the global mouse helper process.

import { LinkPacket } from '../packet';
import { TouchpadHandler } from './touchpad';

export const PACKET_TYPE_DIGITIZER_SESSION = 'link.digitizer.session';
export const PACKET_TYPE_DIGITIZER = 'link.digitizer';

export interface DigitizerSessionBody {
  action: 'start' | 'end';
  width?: number;
  height?: number;
  resolutionX?: number;
  resolutionY?: number;
}

export interface DigitizerEventBody {
  x?: number;
  y?: number;
  active?: boolean;
  touching?: boolean;
  pressure?: number;
  tool?: string;
}

export function isDigitizerSessionPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_DIGITIZER_SESSION;
}

export function isDigitizerPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_DIGITIZER;
}

export class DigitizerHandler {
  private width = 0;
  private height = 0;

  constructor(private touchpadHandler: TouchpadHandler) {}

  public handleSession(packet: LinkPacket) {
    const body = packet.body as DigitizerSessionBody;
    if (body.action === 'start') {
      this.width = body.width || 0;
      this.height = body.height || 0;
      console.log(`[Digitizer] Session started: ${this.width}x${this.height}`);
    } else {
      this.width = 0;
      this.height = 0;
      console.log('[Digitizer] Session ended');
      this.touchpadHandler.writeCommand('touch false');
    }
  }

  public handleEvent(packet: LinkPacket) {
    const body = packet.body as DigitizerEventBody;

    if (body.active === false) {
      this.touchpadHandler.writeCommand('touch false');
      return;
    }

    if (body.touching !== undefined) {
      this.touchpadHandler.writeCommand(`touch ${body.touching}`);
    }

    if (body.x !== undefined && body.y !== undefined && this.width > 0 && this.height > 0) {
      const rx = Math.max(0, Math.min(1.0, body.x / this.width));
      const ry = Math.max(0, Math.min(1.0, body.y / this.height));
      this.touchpadHandler.writeCommand(`abs ${rx} ${ry}`);
    }
  }
}
