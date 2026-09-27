"use strict";
// Screensaver-inhibit. LOCAL-ONLY: no wire packet of its own (see docs/features.txt)
// — implementation is exactly SetThreadExecutionState(ES_CONTINUOUS |
// ES_DISPLAY_REQUIRED) on activation and SetThreadExecutionState(ES_CONTINUOUS) on deactivation,
// matching the plugin's own connect/disconnect lifecycle 1:1.
//
// SetThreadExecutionState's effect only lasts for the calling thread/process's lifetime (MSDN:
// cleared automatically once that process terminates) — a one-shot PowerShell exec like
// systemvolume's wouldn't hold the inhibition, so this spawns a long-lived helper process instead
// and simply kills it to turn inhibition back off.
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
exports.ScreensaverInhibitor = void 0;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const SCRIPT_PATH_WIN = path.join(__dirname, '../../scripts/screensaver-inhibit.ps1');
const SCRIPT_PATH_LINUX = path.join(__dirname, '../../scripts/screensaver-inhibit.sh');
class ScreensaverInhibitor {
    helperProcess = null;
    start() {
        if (this.helperProcess)
            return; // already inhibiting
        if (process.platform === 'linux') {
            this.helperProcess = (0, child_process_1.spawn)('bash', [SCRIPT_PATH_LINUX], { stdio: 'ignore' });
        }
        else {
            this.helperProcess = (0, child_process_1.spawn)('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH_WIN], { stdio: 'ignore' });
        }
        this.helperProcess.on('exit', () => {
            this.helperProcess = null;
        });
    }
    stop() {
        if (this.helperProcess) {
            this.helperProcess.kill();
            this.helperProcess = null;
        }
    }
}
exports.ScreensaverInhibitor = ScreensaverInhibitor;
//# sourceMappingURL=screensaver-inhibit.js.map