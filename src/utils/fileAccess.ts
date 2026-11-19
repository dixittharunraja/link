import type { PeerDevice } from '../types/peer';

/**
 * Whether the Files tab may browse this peer: paired, connected, and not denied the file access capability.
 * Kept out of FileExplorerTab.tsx so App.tsx can pick the Files device without loading that lazily loaded tab.
 * FileExplorerTab.tsx has the same check; keep the two in step (or have it import this one).
 */
export function hasFileAccess(peer: PeerDevice): boolean {
  if (!peer.trusted || !peer.connected) return false;
  return peer.allowedCapabilities === undefined || peer.allowedCapabilities.includes('fileaccess');
}
