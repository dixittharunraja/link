"use strict";
// MPRIS / Media Player Control plugin — real system media session integration.
// Queries Windows SMTC active players and controls playback status/seeks using native WinRT calls.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKET_TYPE_MPRIS_REQUEST = exports.PACKET_TYPE_MPRIS = void 0;
exports.isMprisRequestPacket = isMprisRequestPacket;
exports.queryMprisSessions = queryMprisSessions;
exports.controlMpris = controlMpris;
exports.createMprisStatePacket = createMprisStatePacket;
const packet_1 = require("../packet");
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
exports.PACKET_TYPE_MPRIS = 'link.mpris';
exports.PACKET_TYPE_MPRIS_REQUEST = 'link.mpris.request';
function isMprisRequestPacket(packet) {
    return packet.type === exports.PACKET_TYPE_MPRIS_REQUEST;
}
const SCRIPT_PATH = path.join(__dirname, '../../scripts/mpris-control.ps1');
function runScript(args) {
    return new Promise((resolve, reject) => {
        const escapedArgs = args.map(arg => `"${arg.replace(/"/g, '\\"')}"`);
        const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT_PATH}" ${escapedArgs.join(' ')}`;
        (0, child_process_1.exec)(command, { timeout: 3000 }, (err, stdout) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(stdout.trim());
        });
    });
}
async function queryMprisSessionsLinux() {
    const { promisify } = require('util');
    const execAsync = promisify(child_process_1.exec);
    try {
        const { stdout: playersStr } = await execAsync('playerctl -l');
        const players = playersStr.trim().split('\n').filter((p) => p);
        if (players.length === 0)
            return [];
        const sessions = [];
        for (const player of players) {
            try {
                const { stdout: status } = await execAsync(`playerctl -p ${player} status`);
                const isPlaying = status.trim() === 'Playing';
                const { stdout: metadata } = await execAsync(`playerctl -p ${player} metadata -f "{{title}}|||{{artist}}|||{{album}}|||{{mpris:length}}"`);
                const [title, artist, album, lengthStr] = metadata.trim().split('|||');
                sessions.push({
                    player,
                    playerId: player,
                    title: title || '',
                    artist: artist || '',
                    album: album || '',
                    isPlaying,
                    canPlay: true,
                    canPause: true,
                    canGoNext: true,
                    canGoPrevious: true,
                    canSeek: true,
                    length: lengthStr ? Math.floor(parseInt(lengthStr, 10) / 1000) : 0,
                    pos: 0,
                });
            }
            catch { }
        }
        return sessions;
    }
    catch (e) {
        console.error('[Link] Error querying MPRIS sessions (Linux):', e);
        return [];
    }
}
async function queryMprisSessions() {
    if (process.platform === 'linux')
        return queryMprisSessionsLinux();
    try {
        const stdout = await runScript(['get']);
        if (!stdout || stdout === '[]')
            return [];
        try {
            return JSON.parse(stdout);
        }
        catch {
            // PowerShell ConvertTo-Json doesn't escape quotes inside string properties.
            // Repair unescaped double quotes inside JSON string values.
            const repaired = stdout.replace(/("title":\s*")([^]*?)("(?=,\s*"artist"))/g, (_m, p1, p2, p3) => {
                return p1 + p2.replace(/"/g, '\\"') + p3;
            }).replace(/("artist":\s*")([^]*?)("(?=,\s*"album"))/g, (_m, p1, p2, p3) => {
                return p1 + p2.replace(/"/g, '\\"') + p3;
            }).replace(/("album":\s*")([^]*?)("(?=,\s*"isPlaying"))/g, (_m, p1, p2, p3) => {
                return p1 + p2.replace(/"/g, '\\"') + p3;
            });
            return JSON.parse(repaired);
        }
    }
    catch (e) {
        console.error('[Link] Error querying MPRIS sessions:', e);
        return [];
    }
}
async function controlMprisLinux(player, action) {
    const { promisify } = require('util');
    const execAsync = promisify(child_process_1.exec);
    try {
        let cmdAction = action.toLowerCase();
        if (cmdAction === 'playpause')
            cmdAction = 'play-pause';
        else if (cmdAction === 'nexttrack')
            cmdAction = 'next';
        else if (cmdAction === 'prevtrack' || cmdAction === 'prev')
            cmdAction = 'previous';
        try {
            if (player) {
                await execAsync(`playerctl -p "${player}" ${cmdAction}`);
            }
            else {
                await execAsync(`playerctl ${cmdAction}`);
            }
        }
        catch {
            // Fall back to whatever playerctl considers the active player.
            await execAsync(`playerctl ${cmdAction}`);
        }
        return true;
    }
    catch (e) {
        console.error('[Link] Error controlling MPRIS player (Linux):', e);
        return false;
    }
}
async function controlMpris(player, action) {
    if (process.platform === 'linux')
        return controlMprisLinux(player, action);
    try {
        const stdout = await runScript(['control', player, action]);
        return stdout.includes('control-result: True');
    }
    catch (e) {
        console.error('[Link] Error controlling MPRIS player:', e);
        return false;
    }
}
function createMprisStatePacket(sessions) {
    if (sessions.length === 0) {
        return (0, packet_1.createPacket)(exports.PACKET_TYPE_MPRIS, {
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
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_MPRIS, {
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
//# sourceMappingURL=mpris.js.map