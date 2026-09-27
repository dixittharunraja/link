"use strict";
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
exports.getLocalPhysicalDrives = getLocalPhysicalDrives;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
function getLocalPhysicalDrives(activeLinkDrives) {
    if (process.platform === 'linux') {
        // No drive-letter concept on Linux — expose the user's home directory as a single browsable
        // root when this desktop is the one being mounted by a peer desktop (desktop-to-desktop
        // direction). The Link folder itself is filtered out of this root's own listing elsewhere
        // (see handleFsRequest's 'readdir' case) since it can contain other devices' phone mounts.
        return [{ name: 'Home', path: os.homedir() }];
    }
    const roots = [];
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (const letter of letters) {
        const drive = `${letter}:\\`;
        const driveLetter = `${letter}:`;
        // Loop prevention: Skip any drive letters currently occupied by Link mounts
        if (activeLinkDrives.has(driveLetter.toUpperCase())) {
            continue;
        }
        try {
            if (fs.existsSync(drive)) {
                roots.push({
                    name: `${letter} Drive`,
                    path: drive.replace(/\\/g, '/'),
                });
            }
        }
        catch (e) {
            // Skip offline/restricted drives (like empty card readers or floppy drives)
        }
    }
    return roots;
}
//# sourceMappingURL=fs-helper.js.map