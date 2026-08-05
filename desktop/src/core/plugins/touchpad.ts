// Touchpad/Remotecontrol plugin.
// Receives touchpad movement, clicks, and scroll gestures from the phone, and injects them
// into Windows using a persistent C#-compiled native helper communicating over stdin.

import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LinkPacket } from '../packet';

export const PACKET_TYPE_TOUCHPAD_REQUEST = 'link.touchpad.request';

export interface TouchpadRequest {
  dx?: number;
  dy?: number;
  singleclick?: boolean;
  doubleclick?: boolean;
  middleclick?: boolean;
  rightclick?: boolean;
  singlehold?: boolean;
  singlerelease?: boolean;
  scroll?: boolean;
  specialKey?: number;
}

export function isTouchpadRequestPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_TOUCHPAD_REQUEST;
}

export class TouchpadHandler {
  private helperProcess: ChildProcess | null = null;
  private cscPath = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';

  constructor(private configDir: string) {
    this.ensureHelperReady();
  }

  private ensureHelperReady() {
    const helperExe = path.join(this.configDir, 'mouse-helper.exe');
    // Force recompile to get the new media key injection features
    try { fs.unlinkSync(helperExe); } catch {}
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
      } catch (err) {
        console.error('[Touchpad] Failed to compile C# mouse helper:', err);
      } finally {
        try { fs.unlinkSync(helperCs); } catch {}
      }
    }

    if (fs.existsSync(helperExe)) {
      try {
        this.helperProcess = spawn(helperExe, [], { stdio: ['pipe', 'ignore', 'ignore'] });
        this.helperProcess.on('exit', () => {
          this.helperProcess = null;
        });
      } catch (err) {
        console.error('[Touchpad] Failed to start native mouse helper:', err);
      }
    }
  }

  public handleRequest(packet: LinkPacket) {
    if (!this.helperProcess || !this.helperProcess.stdin) return;
    const body = packet.body as TouchpadRequest;

    if (body.scroll) {
      const dx = body.dx ?? 0;
      const dy = body.dy ?? 0;
      // Scroll direction: positive y is scroll down in phone touch gestures but Windows expects positive for UP.
      // So invert dy.
      this.helperProcess.stdin.write(`scroll ${dx} ${-dy}\n`);
    } else if (body.dx !== undefined && body.dy !== undefined) {
      // Speed multiplier for desktop touchpad experience
      const speed = 2.0;
      this.helperProcess.stdin.write(`move ${body.dx * speed} ${body.dy * speed}\n`);
    } else if (body.singleclick) {
      this.helperProcess.stdin.write('click left\n');
    } else if (body.doubleclick) {
      this.helperProcess.stdin.write('click double\n');
    } else if (body.rightclick) {
      this.helperProcess.stdin.write('click right\n');
    } else if (body.middleclick) {
      this.helperProcess.stdin.write('click middle\n');
    } else if (body.singlehold) {
      this.helperProcess.stdin.write('hold left\n');
    } else if (body.singlerelease) {
      this.helperProcess.stdin.write('release left\n');
    } else if (body.specialKey !== undefined) {
      this.helperProcess.stdin.write(`special ${body.specialKey}\n`);
    }
  }

  public injectMediaKey(key: string) {
    if (!this.helperProcess || !this.helperProcess.stdin) return;
    this.helperProcess.stdin.write(`key ${key}\n`);
  }

  public writeCommand(command: string) {
    if (!this.helperProcess || !this.helperProcess.stdin) return;
    this.helperProcess.stdin.write(`${command}\n`);
  }

  public stop() {
    if (this.helperProcess) {
      this.helperProcess.kill();
      this.helperProcess = null;
    }
  }
}
