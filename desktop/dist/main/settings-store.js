"use strict";
// Tiny shared helper for the handful of single-value app settings persisted as their own small
// JSON file in configDir (discovery visibility, pause-music-enabled, screensaver-inhibit-enabled).
// Previously each of these duplicated the same try/read/parse and mkdir/write boilerplate inline
// in main.ts — this collapses that to one call per setting, at both load and save time.
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
exports.loadSetting = loadSetting;
exports.saveSetting = saveSetting;
exports.loadBlocklist = loadBlocklist;
exports.saveBlocklist = saveBlocklist;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** Reads `configDir/fileName`, returns `data[key]` if present, otherwise `defaultValue`. Any
 * read/parse failure (missing file, corrupt JSON) is swallowed and treated as "use the default". */
function loadSetting(configDir, fileName, key, defaultValue) {
    try {
        const filePath = path.join(configDir, fileName);
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (data[key] !== undefined)
                return data[key];
        }
    }
    catch (err) {
        console.error(`[Link] Failed to load setting ${key} from ${fileName}:`, err);
    }
    return defaultValue;
}
/** Writes `{ [key]: value }` to `configDir/fileName`, creating configDir if needed. */
function saveSetting(configDir, fileName, key, value) {
    try {
        fs.mkdirSync(configDir, { recursive: true });
        const filePath = path.join(configDir, fileName);
        let existing = {};
        if (fs.existsSync(filePath)) {
            try {
                existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            }
            catch (e) { }
        }
        existing[key] = value;
        fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
    }
    catch (err) {
        console.error(`[Link] Failed to save setting ${key} to ${fileName}:`, err);
    }
}
function loadBlocklist(configDir) {
    try {
        const filePath = path.join(configDir, 'blocklist.json');
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (Array.isArray(data.entries)) {
                return data.entries;
            }
        }
    }
    catch (err) {
        console.error('[Link] Failed to load blocklist:', err);
    }
    return [];
}
function saveBlocklist(configDir, entries) {
    try {
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'blocklist.json'), JSON.stringify({ entries }, null, 2), 'utf8');
    }
    catch (err) {
        console.error('[Link] Failed to save blocklist:', err);
    }
}
//# sourceMappingURL=settings-store.js.map