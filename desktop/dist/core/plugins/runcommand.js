"use strict";
// Run Command plugin.
// Desktop holds and executes a whitelist of commands; the phone only ever displays and triggers
// by key — it never sends an arbitrary command string, and the desktop never accepts one. This
// is a hard security boundary, not just a design choice.
//
// The whitelist itself is desktop-owned config (matches upstream — only the desktop's own
// settings UI edits it, the phone can never add/remove/modify entries, only select by key).
// Persisted as JSON in configDir so edits survive a restart.
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
exports.RunCommandManager = exports.PACKET_TYPE_RUNCOMMAND_REQUEST = exports.PACKET_TYPE_RUNCOMMAND = void 0;
exports.isRunCommandRequestPacket = isRunCommandRequestPacket;
exports.isRunCommandListPacket = isRunCommandListPacket;
exports.createRequestCommandListPacket = createRequestCommandListPacket;
exports.createTriggerCommandPacket = createTriggerCommandPacket;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const packet_1 = require("../packet");
exports.PACKET_TYPE_RUNCOMMAND = 'link.runcommand';
exports.PACKET_TYPE_RUNCOMMAND_REQUEST = 'link.runcommand.request';
const DEFAULT_WHITELIST = {
    notepad: { name: 'Open Notepad', command: 'notepad.exe' },
};
class RunCommandManager {
    whitelist;
    configPath;
    constructor(configDir) {
        this.configPath = path.join(configDir, 'runcommand.json');
        this.whitelist = this.load();
    }
    load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            if (data.lock) {
                delete data.lock;
                this.save(data);
            }
            return data;
        }
        catch {
            this.save(DEFAULT_WHITELIST);
            return { ...DEFAULT_WHITELIST };
        }
    }
    save(whitelist) {
        fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
        fs.writeFileSync(this.configPath, JSON.stringify(whitelist, null, 2), 'utf8');
    }
    getCommands() {
        return { ...this.whitelist };
    }
    setCommand(key, entry) {
        this.whitelist[key] = entry;
        this.save(this.whitelist);
    }
    removeCommand(key) {
        delete this.whitelist[key];
        this.save(this.whitelist);
    }
    createCommandListPacket() {
        return (0, packet_1.createPacket)(exports.PACKET_TYPE_RUNCOMMAND, {
            commandList: JSON.stringify(this.whitelist),
            canAddCommand: false, // upstream semantics: whether the PHONE can remotely add commands — it never can, only the desktop's own UI edits the list
        });
    }
    isRunCommandRequestPacket(packet) {
        return packet.type === exports.PACKET_TYPE_RUNCOMMAND_REQUEST;
    }
    /**
     * Handles an incoming request packet: `{requestCommandList: true}` or `{key: "..."}`.
     * Returns a command-list packet to send back if the request was for the list, otherwise null
     * (a `{key}` trigger has no direct response packet, matching upstream).
     */
    handleRunCommandRequest(packet) {
        const body = packet.body;
        if (body.requestCommandList) {
            return this.createCommandListPacket();
        }
        if (typeof body.key === 'string') {
            const entry = this.whitelist[body.key];
            if (entry) {
                // detached, not shell-interpolated with any peer-supplied data — `command` comes only
                // from our own persisted whitelist above, keyed by `key`.
                (0, child_process_1.exec)(entry.command, () => { });
            }
            return null;
        }
        return null;
    }
}
exports.RunCommandManager = RunCommandManager;
function isRunCommandRequestPacket(packet) {
    return packet.type === exports.PACKET_TYPE_RUNCOMMAND_REQUEST;
}
/** Incoming command-list packet FROM a peer — i.e. this device is the requester, viewing a
 * peer's whitelist (mesh case: any device, mobile or desktop, viewing a paired desktop's panel). */
function isRunCommandListPacket(packet) {
    return packet.type === exports.PACKET_TYPE_RUNCOMMAND && typeof packet.body?.commandList === 'string';
}
function createRequestCommandListPacket() {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_RUNCOMMAND_REQUEST, { requestCommandList: true });
}
function createTriggerCommandPacket(key) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_RUNCOMMAND_REQUEST, { key });
}
//# sourceMappingURL=runcommand.js.map