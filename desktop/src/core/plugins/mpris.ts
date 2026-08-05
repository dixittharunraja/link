// MPRIS / Media Player Control plugin — real system media session integration.
// Queries Windows SMTC active players and controls playback status/seeks using native WinRT calls.

import { LinkPacket, createPacket } from '../packet';
import * as path from 'path';
import { exec } from 'child_process';

export const PACKET_TYPE_MPRIS = 'link.mpris';
export const PACKET_TYPE_MPRIS_REQUEST = 'link.mpris.request';

export interface MprisRequest {
  player?: string;
  action?: string;
  requestPlayerList?: boolean;
  requestNowPlaying?: boolean;
}

export function isMprisRequestPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_MPRIS_REQUEST;
}

const SCRIPT_PATH = path.join(__dirname, '../../scripts/mpris-control.ps1');

function runScript(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const escapedArgs = args.map(arg => `"${arg.replace(/"/g, '\\"')}"`);
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT_PATH}" ${escapedArgs.join(' ')}`;
    exec(command, { timeout: 3000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export interface MprisSessionState {
  player: string;
  playerId: string;
  title: string;
  artist: string;
  album: string;
  isPlaying: boolean;
  canPlay: boolean;
  canPause: boolean;
  canGoNext: boolean;
  canGoPrevious: boolean;
  canSeek: boolean;
  length: number;
  pos: number;
}

export async function queryMprisSessions(): Promise<MprisSessionState[]> {
  try {
    const stdout = await runScript(['get']);
    if (!stdout || stdout === '[]') return [];
    try {
      return JSON.parse(stdout) as MprisSessionState[];
    } catch {
      // PowerShell ConvertTo-Json doesn't escape quotes inside string properties.
      // Repair unescaped double quotes inside JSON string values.
      const repaired = stdout.replace(/("title":\s*")([^]*?)("(?=,\s*"artist"))/g, (_m, p1, p2, p3) => {
        return p1 + p2.replace(/"/g, '\\"') + p3;
      }).replace(/("artist":\s*")([^]*?)("(?=,\s*"album"))/g, (_m, p1, p2, p3) => {
        return p1 + p2.replace(/"/g, '\\"') + p3;
      }).replace(/("album":\s*")([^]*?)("(?=,\s*"isPlaying"))/g, (_m, p1, p2, p3) => {
        return p1 + p2.replace(/"/g, '\\"') + p3;
      });
      return JSON.parse(repaired) as MprisSessionState[];
    }
  } catch (e) {
    console.error('[Link] Error querying MPRIS sessions:', e);
    return [];
  }
}

export async function controlMpris(player: string, action: string): Promise<boolean> {
  try {
    const stdout = await runScript(['control', player, action]);
    return stdout.includes('control-result: True');
  } catch (e) {
    console.error('[Link] Error controlling MPRIS player:', e);
    return false;
  }
}

export function createMprisStatePacket(sessions: MprisSessionState[]): LinkPacket {
  if (sessions.length === 0) {
    return createPacket(PACKET_TYPE_MPRIS, {
      playerList: [],
      player: '',
      title: 'No Active Media',
      artist: '',
      album: '',
      isPlaying: false,
      canPlay: false,
      canPause: false,
      canGoNext: false,
      canGoPrevious: false,
      canSeek: false,
      volume: 100,
      length: 0,
      pos: 0,
      supportAlbumArtPayload: false,
    });
  }

  const activeSession = sessions.find(s => s.isPlaying) || sessions[0];
  const playerList = sessions.map(s => s.player);

  return createPacket(PACKET_TYPE_MPRIS, {
    playerList,
    player: activeSession.player,
    title: activeSession.title,
    artist: activeSession.artist,
    album: activeSession.album,
    isPlaying: activeSession.isPlaying,
    canPlay: activeSession.canPlay,
    canPause: activeSession.canPause,
    canGoNext: activeSession.canGoNext,
    canGoPrevious: activeSession.canGoPrevious,
    canSeek: activeSession.canSeek,
    volume: 100,
    length: activeSession.length,
    pos: activeSession.pos,
    supportAlbumArtPayload: false,
  });
}
