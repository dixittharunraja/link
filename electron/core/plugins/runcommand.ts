// Run Command plugin.
// Desktop holds and executes a whitelist of commands; the phone only ever displays and triggers
// by key — it never sends an arbitrary command string, and the desktop never accepts one. This
// is a hard security boundary, not just a design choice.
//
// The whitelist itself is desktop-owned config (matches upstream — only the desktop's own
// settings UI edits it, the phone can never add/remove/modify entries, only select by key).
// Persisted as JSON in configDir so edits survive a restart.

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { LinkPacket, createPacket } from '../packet';

const PACKET_TYPE_RUNCOMMAND = 'link.runcommand';
const PACKET_TYPE_RUNCOMMAND_REQUEST = 'link.runcommand.request';

export interface CommandEntry {
  name: string;
  command: string;
}

const DEFAULT_WHITELIST: Record<string, CommandEntry> = {
  notepad: { name: 'Open Notepad', command: 'notepad.exe' },
};

export class RunCommandManager {
  private whitelist: Record<string, CommandEntry>;
  private readonly configPath: string;

  constructor(configDir: string) {
    this.configPath = path.join(configDir, 'runcommand.json');
    this.whitelist = this.load();
  }

  private load(): Record<string, CommandEntry> {
    try {
      const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      if (data.lock) {
        delete data.lock;
        this.save(data);
      }
      return data;
    } catch {
      this.save(DEFAULT_WHITELIST);
      return { ...DEFAULT_WHITELIST };
    }
  }

  private save(whitelist: Record<string, CommandEntry>) {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(whitelist, null, 2), 'utf8');
  }

  getCommands(): Record<string, CommandEntry> {
    return { ...this.whitelist };
  }

  setCommand(key: string, entry: CommandEntry) {
    this.whitelist[key] = entry;
    this.save(this.whitelist);
  }

  removeCommand(key: string) {
    delete this.whitelist[key];
    this.save(this.whitelist);
  }

  createCommandListPacket(): LinkPacket<{ commandList: string; canAddCommand: boolean }> {
    return createPacket(PACKET_TYPE_RUNCOMMAND, {
      commandList: JSON.stringify(this.whitelist),
      canAddCommand: false, // upstream semantics: whether the PHONE can remotely add commands — it never can, only the desktop's own UI edits the list
    });
  }

  isRunCommandRequestPacket(packet: LinkPacket): boolean {
    return packet.type === PACKET_TYPE_RUNCOMMAND_REQUEST;
  }

  /**
   * Handles an incoming request packet: `{requestCommandList: true}` or `{key: "..."}`.
   * Returns a command-list packet to send back if the request was for the list, otherwise null
   * (a `{key}` trigger has no direct response packet, matching upstream).
   */
  handleRunCommandRequest(packet: LinkPacket): LinkPacket | null {
    const body = packet.body as { requestCommandList?: boolean; key?: string };

    if (body.requestCommandList) {
      return this.createCommandListPacket();
    }

    if (typeof body.key === 'string') {
      const entry = this.whitelist[body.key];
      if (entry && entry.command) {
        // detached, not shell-interpolated with any peer-supplied data — `command` comes only
        // from our own persisted whitelist above, keyed by `key`.
        const cmd = entry.command.trim();
        // If it looks like an absolute path to a file or document that doesn't start with quotes or a command verb,
        // we can run it directly or via shell. On Windows, if it's a non-executable file (e.g. .pdf, .docx),
        // `start "" "filePath"` opens with default program.
        if (process.platform === 'win32' && fs.existsSync(cmd.replace(/^"|"$/g, ''))) {
          const cleanPath = cmd.replace(/^"|"$/g, '');
          const ext = path.extname(cleanPath).toLowerCase();
          if (ext === '.exe' || ext === '.bat' || ext === '.cmd') {
            exec(`"${cleanPath}"`, () => {});
          } else {
            exec(`start "" "${cleanPath}"`, () => {});
          }
        } else {
          exec(cmd, () => {});
        }
      }
      return null;
    }

    return null;
  }
}

export function isRunCommandRequestPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_RUNCOMMAND_REQUEST;
}

/** Incoming command-list packet FROM a peer — i.e. this device is the requester, viewing a
 * peer's whitelist (mesh case: any device, mobile or desktop, viewing a paired desktop's panel). */
export function isRunCommandListPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_RUNCOMMAND && typeof (packet.body as any)?.commandList === 'string';
}

export function createRequestCommandListPacket(): LinkPacket<{ requestCommandList: boolean }> {
  return createPacket(PACKET_TYPE_RUNCOMMAND_REQUEST, { requestCommandList: true });
}

export function createTriggerCommandPacket(key: string): LinkPacket<{ key: string }> {
  return createPacket(PACKET_TYPE_RUNCOMMAND_REQUEST, { key });
}
