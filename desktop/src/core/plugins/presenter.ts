// Presenter plugin.
// Handles mapping relative movement increments (dx/dy) to screen coordinate changes 
// for displaying the pointer overlay.


import { LinkPacket, createPacket } from '../packet';

export const PACKET_TYPE_PRESENTER = 'link.presenter';

interface PresenterMoveBody {
  dx: number;
  dy: number;
}

interface PresenterStopBody {
  stop: true;
}

export function createPresenterMovePacket(dx: number, dy: number): LinkPacket<PresenterMoveBody> {
  return createPacket(PACKET_TYPE_PRESENTER, { dx, dy });
}

export function createPresenterStopPacket(): LinkPacket<PresenterStopBody> {
  return createPacket(PACKET_TYPE_PRESENTER, { stop: true });
}

export function isPresenterPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_PRESENTER;
}

export function isPresenterStopPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_PRESENTER && (packet.body as { stop?: boolean }).stop === true;
}

/**
 * Tracks the normalized (0-1) dot position, matching upstream's exact math: dx added directly to
 * x, dy scaled by the screen aspect ratio before being added to y, both clamped to [0,1].
 */
export class PresenterPosition {
  private x = 0.5;
  private y = 0.5;

  constructor(private aspectRatio: number) {}

  update(dx: number, dy: number): { x: number; y: number } {
    this.x = clamp01(this.x + dx);
    this.y = clamp01(this.y + dy * this.aspectRatio);
    return { x: this.x, y: this.y };
  }

  reset() {
    this.x = 0.5;
    this.y = 0.5;
  }
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
