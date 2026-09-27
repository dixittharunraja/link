"use strict";
// Touchpad/Remotecontrol plugin.
// Receives touchpad movement, clicks, and scroll gestures from the phone, and injects them
// into Windows using a persistent C#-compiled native helper communicating over stdin.
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
exports.TouchpadHandler = exports.PACKET_TYPE_TOUCHPAD_REQUEST = void 0;
exports.isTouchpadRequestPacket = isTouchpadRequestPacket;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.PACKET_TYPE_TOUCHPAD_REQUEST = 'link.touchpad.request';
function isTouchpadRequestPacket(packet) {
    return packet.type === exports.PACKET_TYPE_TOUCHPAD_REQUEST;
}
class TouchpadHandler {
    configDir;
    helperProcess = null;
    cscPath = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';
    constructor(configDir) {
        this.configDir = configDir;
        this.ensureHelperReady();
    }
    ensureHelperReady() {
        if (process.platform === 'linux') {
            // xdotool reads commands from stdin (`xdotool -`), no compiled helper needed — Wayland has
            // no universal input-injection API, so this targets X11 only.
            try {
                this.helperProcess = (0, child_process_1.spawn)('xdotool', ['-'], { stdio: ['pipe', 'ignore', 'pipe'] });
                // spawn()'s ENOENT (xdotool missing) is an async 'error' event, not a synchronous throw —
                // without this listener a missing binary silently no-ops every touchpad/digitizer/
                // presenter injection with zero log output. 'exit' alone doesn't fire for ENOENT.
                this.helperProcess.on('error', (err) => {
                    console.error('[Touchpad] xdotool not found or failed to start — install it ' +
                        '(e.g. `sudo apt install xdotool`) or run via the packaged .deb, which declares it ' +
                        'as a dependency:', err.message);
                    this.helperProcess = null;
                });
                this.helperProcess.on('exit', () => {
                    console.error('[Touchpad] xdotool helper exited unexpectedly — Linux input forwarding is down until respawn');
                    this.helperProcess = null;
                });
                // xdotool prints command-level failures (no display, bad keysym, XTest denied, etc.) to
                // its own stderr rather than exiting — without capturing this, those failures are
                // completely invisible even though the write to stdin itself "succeeds".
                this.helperProcess.stderr?.on('data', (data) => {
                    console.error('[Touchpad] xdotool stderr:', data.toString().trim());
                });
            }
            catch (err) {
                console.error('[Touchpad] Failed to start xdotool:', err);
            }
            return;
        }
        const helperExe = path.join(this.configDir, 'mouse-helper.exe');
        // Force recompile to get the new media key injection features
        try {
            fs.unlinkSync(helperExe);
        }
        catch { }
        if (!fs.existsSync(helperExe)) {
            const helperCs = path.join(this.configDir, 'mouse-helper.cs');
            const csCode = `
using System;
using System.Runtime.InteropServices;

public class MouseHelper {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    // Absolute positioning in VIRTUAL-DESKTOP pixel coordinates — unlike mouse_event's ABSOLUTE
    // flag (which normalizes to the primary monitor only), SetCursorPos addresses any monitor, so
    // the digitizer can target a chosen display in a multi-monitor setup.
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const byte VK_MEDIA_NEXT_TRACK = 0xB0;
    private const byte VK_MEDIA_PREV_TRACK = 0xB1;
    private const byte VK_MEDIA_STOP = 0xB2;
    private const byte VK_MEDIA_PLAY_PAUSE = 0xB3;
    private const byte VK_CONTROL = 0x11;
    private const byte VK_Z = 0x5A;
    private const byte VK_Y = 0x59;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    private static double carryX = 0.0;
    private static double carryY = 0.0;
    private static double carryScroll = 0.0;

    public static void Main() {
        string line;
        while ((line = Console.ReadLine()) != null) {
            try {
                string[] parts = line.Split(' ');
                if (parts.Length == 0) continue;
                string cmd = parts[0];
                if (cmd == "move" && parts.Length >= 3) {
                    double rawDx = double.Parse(parts[1]) + carryX;
                    double rawDy = double.Parse(parts[2]) + carryY;
                    int dx = (int)Math.Round(rawDx);
                    int dy = (int)Math.Round(rawDy);
                    carryX = rawDx - dx;
                    carryY = rawDy - dy;
                    if (dx != 0 || dy != 0) {
                        mouse_event(MOUSEEVENTF_MOVE, dx, dy, 0, UIntPtr.Zero);
                    }
                } else if (cmd == "abs" && parts.Length >= 3) {
                    double rx = double.Parse(parts[1]);
                    double ry = double.Parse(parts[2]);
                    int x = (int)(rx * 65535.0);
                    int y = (int)(ry * 65535.0);
                    mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, x, y, 0, UIntPtr.Zero);
                } else if (cmd == "setpos" && parts.Length >= 3) {
                    int px = int.Parse(parts[1]);
                    int py = int.Parse(parts[2]);
                    SetCursorPos(px, py);
                } else if (cmd == "touch" && parts.Length >= 2) {
                    bool down = bool.Parse(parts[1]);
                    if (down) {
                        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                    } else {
                        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                    }
                } else if (cmd == "click" && parts.Length >= 2) {
                    string button = parts[1];
                    if (button == "left") {
                        mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                    } else if (button == "right") {
                        mouse_event(MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
                    } else if (button == "middle") {
                        mouse_event(MOUSEEVENTF_MIDDLEDOWN | MOUSEEVENTF_MIDDLEUP, 0, 0, 0, UIntPtr.Zero);
                    } else if (button == "double") {
                        mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                        mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                    }
                } else if (cmd == "hold" && parts.Length >= 2) {
                    string button = parts[1];
                    if (button == "left") {
                        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                    }
                } else if (cmd == "release" && parts.Length >= 2) {
                    string button = parts[1];
                    if (button == "left") {
                        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                    }
                } else if (cmd == "scroll" && parts.Length >= 3) {
                    double rawScroll = (double.Parse(parts[2]) * 120) + carryScroll;
                    int dy = (int)Math.Round(rawScroll);
                    carryScroll = rawScroll - dy;
                    if (dy != 0) {
                        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, dy, UIntPtr.Zero);
                    }
                } else if (cmd == "key" && parts.Length >= 2) {
                    string key = parts[1];
                    byte vk = 0;
                    if (key == "playpause") vk = VK_MEDIA_PLAY_PAUSE;
                    else if (key == "next") vk = VK_MEDIA_NEXT_TRACK;
                    else if (key == "prev") vk = VK_MEDIA_PREV_TRACK;
                    else if (key == "stop") vk = VK_MEDIA_STOP;

                    if (vk != 0) {
                        keybd_event(vk, 0, 0, UIntPtr.Zero);
                        keybd_event(vk, 0, 2, UIntPtr.Zero); // KEYEVENTF_KEYUP
                    }
                } else if (cmd == "unicode" && parts.Length >= 2) {
                    // Send unicode text input using keybd_event with KEYEVENTF_UNICODE (0x0004)
                    short code = short.Parse(parts[1]);
                    keybd_event(0, (byte)code, 0x0004, UIntPtr.Zero);
                    keybd_event(0, (byte)code, 0x0004 | 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
                } else if (cmd == "special" && parts.Length >= 2) {
                    int specialKey = int.Parse(parts[1]);
                    if (specialKey < 0) {
                        // Negative specialKey represents a Unicode code point
                        short code = (short)(-specialKey);
                        keybd_event(0, (byte)code, 0x0004, UIntPtr.Zero);
                        keybd_event(0, (byte)code, 0x0004 | 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
                    } else if (specialKey >= 40 && specialKey <= 43) {
                        // Ctrl+A/C/V/X (select-all/copy/paste/cut) — same VK_CONTROL-modifier
                        // pattern as the "undo"/"redo" commands below, just parameterized over the
                        // combo letter instead of two dedicated commands.
                        byte comboVk = 0;
                        if (specialKey == 40) comboVk = 0x41; // A
                        else if (specialKey == 41) comboVk = 0x43; // C
                        else if (specialKey == 42) comboVk = 0x56; // V
                        else if (specialKey == 43) comboVk = 0x58; // X
                        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
                        keybd_event(comboVk, 0, 0, UIntPtr.Zero);
                        keybd_event(comboVk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                    } else {
                        byte vk = 0;
                        if (specialKey == 8) vk = 0x21; // Page Up
                        else if (specialKey == 9) vk = 0x22; // Page Down
                        else if (specialKey == 14) vk = 0x1B; // Escape
                        else if (specialKey == 25) vk = 0x74; // F5
                        else if (specialKey == 31) vk = 0x7B; // F11
                        else if (specialKey == 12) vk = 0x0D; // Return / Enter
                        else if (specialKey == 4) vk = 0x25; // Left
                        else if (specialKey == 5) vk = 0x26; // Up
                        else if (specialKey == 6) vk = 0x27; // Right
                        else if (specialKey == 7) vk = 0x28; // Down
                        else if (specialKey == 1) vk = 0x08; // Backspace / Del

                        if (vk != 0) {
                            keybd_event(vk, 0, 0, UIntPtr.Zero);
                            keybd_event(vk, 0, 2, UIntPtr.Zero); // KEYEVENTF_KEYUP
                        }
                    }
                } else if (cmd == "undo" || cmd == "redo") {
                    // Ctrl+Z / Ctrl+Y — the near-universal undo/redo combos, so the digitizer's
                    // undo/redo buttons work in whatever app is receiving the pen input.
                    byte vk = (cmd == "undo") ? VK_Z : VK_Y;
                    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
                    keybd_event(vk, 0, 0, UIntPtr.Zero);
                    keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
            } catch {
                // ignore parsing errors
            }
        }
    }
}
      `;
            try {
                fs.mkdirSync(this.configDir, { recursive: true });
                fs.writeFileSync(helperCs, csCode, 'utf8');
                const { spawnSync } = require('child_process');
                spawnSync(this.cscPath, ['/out:' + helperExe, helperCs], { stdio: 'ignore' });
            }
            catch (err) {
                console.error('[Touchpad] Failed to compile C# mouse helper:', err);
            }
            finally {
                try {
                    fs.unlinkSync(helperCs);
                }
                catch { }
            }
        }
        if (fs.existsSync(helperExe)) {
            try {
                this.helperProcess = (0, child_process_1.spawn)(helperExe, [], { stdio: ['pipe', 'ignore', 'ignore'] });
                this.helperProcess.on('exit', () => {
                    this.helperProcess = null;
                });
            }
            catch (err) {
                console.error('[Touchpad] Failed to start native mouse helper:', err);
            }
        }
    }
    // A dead xdotool child (crash, killed, lost X connection, etc.) previously meant Linux input
    // forwarding stayed broken for the rest of the app's lifetime with zero recovery. Respawn it
    // on demand instead of requiring a full app restart.
    ensureHelperAlive() {
        if (process.platform === 'linux' && !this.helperProcess) {
            this.ensureHelperReady();
        }
    }
    linuxSpecialKeysym(id) {
        if (id === 8)
            return 'Prior';
        if (id === 9)
            return 'Next';
        if (id === 14)
            return 'Escape';
        if (id === 25)
            return 'F5';
        if (id === 31)
            return 'F11';
        if (id === 12)
            return 'Return';
        if (id === 4)
            return 'Left';
        if (id === 5)
            return 'Up';
        if (id === 6)
            return 'Right';
        if (id === 7)
            return 'Down';
        if (id === 1)
            return 'BackSpace';
        return '';
    }
    handleRequest(packet) {
        this.ensureHelperAlive();
        if (!this.helperProcess || !this.helperProcess.stdin)
            return;
        const body = packet.body;
        if (process.platform === 'linux') {
            try {
                if (body.scroll) {
                    const dy = body.dy ?? 0;
                    if (dy < 0)
                        this.helperProcess.stdin.write('click 4\n');
                    else if (dy > 0)
                        this.helperProcess.stdin.write('click 5\n');
                }
                else if (body.dx !== undefined && body.dy !== undefined) {
                    const speed = 2.0;
                    const dx = Math.round(body.dx * speed);
                    const dy = Math.round(body.dy * speed);
                    this.helperProcess.stdin.write(`mousemove_relative -- ${dx} ${dy}\n`);
                }
                else if (body.singleclick) {
                    this.helperProcess.stdin.write('click 1\n');
                }
                else if (body.doubleclick) {
                    this.helperProcess.stdin.write('click --repeat 2 1\n');
                }
                else if (body.rightclick) {
                    this.helperProcess.stdin.write('click 3\n');
                }
                else if (body.middleclick) {
                    this.helperProcess.stdin.write('click 2\n');
                }
                else if (body.singlehold) {
                    this.helperProcess.stdin.write('mousedown 1\n');
                }
                else if (body.singlerelease) {
                    this.helperProcess.stdin.write('mouseup 1\n');
                }
                else if (body.specialKey !== undefined) {
                    const key = this.linuxSpecialKeysym(body.specialKey);
                    if (key)
                        this.helperProcess.stdin.write(`key ${key}\n`);
                }
            }
            catch (err) {
                console.error('[Touchpad] handleRequest failed for', body, err);
            }
            return;
        }
        if (body.scroll) {
            const dx = body.dx ?? 0;
            const dy = body.dy ?? 0;
            // Scroll direction: positive y is scroll down in phone touch gestures but Windows expects positive for UP.
            // So invert dy.
            this.helperProcess.stdin.write(`scroll ${dx} ${-dy}\n`);
        }
        else if (body.dx !== undefined && body.dy !== undefined) {
            // Speed multiplier for desktop touchpad experience
            const speed = 2.0;
            this.helperProcess.stdin.write(`move ${body.dx * speed} ${body.dy * speed}\n`);
        }
        else if (body.singleclick) {
            this.helperProcess.stdin.write('click left\n');
        }
        else if (body.doubleclick) {
            this.helperProcess.stdin.write('click double\n');
        }
        else if (body.rightclick) {
            this.helperProcess.stdin.write('click right\n');
        }
        else if (body.middleclick) {
            this.helperProcess.stdin.write('click middle\n');
        }
        else if (body.singlehold) {
            this.helperProcess.stdin.write('hold left\n');
        }
        else if (body.singlerelease) {
            this.helperProcess.stdin.write('release left\n');
        }
        else if (body.specialKey !== undefined) {
            this.helperProcess.stdin.write(`special ${body.specialKey}\n`);
        }
    }
    linuxMediaKeysym(key) {
        if (key === 'playpause')
            return 'XF86AudioPlay';
        if (key === 'next')
            return 'XF86AudioNext';
        if (key === 'prev')
            return 'XF86AudioPrev';
        if (key === 'stop')
            return 'XF86AudioStop';
        return '';
    }
    injectMediaKey(key) {
        this.ensureHelperAlive();
        if (!this.helperProcess || !this.helperProcess.stdin)
            return;
        if (process.platform === 'linux') {
            try {
                const xdoKey = this.linuxMediaKeysym(key);
                if (xdoKey)
                    this.helperProcess.stdin.write(`key ${xdoKey}\n`);
            }
            catch (err) {
                console.error('[Touchpad] injectMediaKey failed for', key, err);
            }
            return;
        }
        this.helperProcess.stdin.write(`key ${key}\n`);
    }
    writeCommand(command) {
        this.ensureHelperAlive();
        if (!this.helperProcess || !this.helperProcess.stdin)
            return;
        if (process.platform === 'linux') {
            try {
                const parts = command.split(' ');
                if (parts.length === 0)
                    return;
                const cmd = parts[0];
                const stdin = this.helperProcess.stdin;
                if (cmd === 'undo')
                    stdin.write('key ctrl+z\n');
                // Linux redo diverges from Windows' Ctrl+Y: GTK-HIG apps (Xournal++, GIMP, etc — the
                // realistic digitizer/annotation targets on Linux) bind redo to Ctrl+Shift+Z, where
                // Ctrl+Y is typically unbound.
                else if (cmd === 'redo')
                    stdin.write('key ctrl+shift+z\n');
                else if (cmd === 'move' && parts.length >= 3) {
                    const speed = 2.0;
                    const dx = Math.round(parseFloat(parts[1]) * speed);
                    const dy = Math.round(parseFloat(parts[2]) * speed);
                    if (dx !== 0 || dy !== 0)
                        stdin.write(`mousemove_relative -- ${dx} ${dy}\n`);
                }
                else if (cmd === 'setpos' && parts.length >= 3) {
                    const px = parseInt(parts[1], 10);
                    const py = parseInt(parts[2], 10);
                    stdin.write(`mousemove ${px} ${py}\n`);
                }
                else if (cmd === 'touch' && parts.length >= 2) {
                    const down = parts[1] === 'true';
                    stdin.write(down ? 'mousedown 1\n' : 'mouseup 1\n');
                }
                else if (cmd === 'click' && parts.length >= 2) {
                    const btn = parts[1];
                    if (btn === 'left')
                        stdin.write('click 1\n');
                    else if (btn === 'right')
                        stdin.write('click 3\n');
                    else if (btn === 'middle')
                        stdin.write('click 2\n');
                    else if (btn === 'double')
                        stdin.write('click --repeat 2 1\n');
                }
                else if (cmd === 'hold' && parts.length >= 2) {
                    if (parts[1] === 'left')
                        stdin.write('mousedown 1\n');
                }
                else if (cmd === 'release' && parts.length >= 2) {
                    if (parts[1] === 'left')
                        stdin.write('mouseup 1\n');
                }
                else if (cmd === 'scroll' && parts.length >= 3) {
                    const dy = parseFloat(parts[2]);
                    if (dy < 0)
                        stdin.write('click 4\n');
                    else if (dy > 0)
                        stdin.write('click 5\n');
                }
                else if (cmd === 'key' && parts.length >= 2) {
                    const xdoKey = this.linuxMediaKeysym(parts[1]);
                    if (xdoKey)
                        stdin.write(`key ${xdoKey}\n`);
                }
                else if (cmd === 'unicode' && parts.length >= 2) {
                    const code = parseInt(parts[1], 10);
                    stdin.write(`key U${code.toString(16)}\n`);
                }
                else if (cmd === 'special' && parts.length >= 2) {
                    const id = parseInt(parts[1], 10);
                    if (id < 0) {
                        stdin.write(`key U${(-id).toString(16)}\n`);
                    }
                    else {
                        const key = this.linuxSpecialKeysym(id);
                        if (key)
                            stdin.write(`key ${key}\n`);
                    }
                }
            }
            catch (err) {
                console.error('[Touchpad] writeCommand failed for', command, err);
            }
            return;
        }
        this.helperProcess.stdin.write(`${command}\n`);
    }
    stop() {
        if (this.helperProcess) {
            this.helperProcess.kill();
            this.helperProcess = null;
        }
    }
}
exports.TouchpadHandler = TouchpadHandler;
//# sourceMappingURL=touchpad.js.map