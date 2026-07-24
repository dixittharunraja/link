// Screensaver-inhibit — faithful port of kdeconnect-kde's plugins/screensaver-inhibit/
// screensaverinhibitplugin-win.cpp. LOCAL-ONLY: no wire packet of its own (see docs/features.txt)
// — upstream Windows implementation is exactly SetThreadExecutionState(ES_CONTINUOUS |
// ES_DISPLAY_REQUIRED) on activation and SetThreadExecutionState(ES_CONTINUOUS) on deactivation,
// matching the plugin's own connect/disconnect lifecycle 1:1 (constructor/destructor upstream).
//
// SetThreadExecutionState's effect only lasts for the calling thread/process's lifetime (MSDN:
// cleared automatically once that process terminates) — a one-shot PowerShell exec like
// systemvolume's wouldn't hold the inhibition, so this spawns a long-lived helper process instead
// and simply kills it to turn inhibition back off.

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

const SCRIPT_PATH = path.join(__dirname, '../../scripts/screensaver-inhibit.ps1');

export class ScreensaverInhibitor {
  private helperProcess: ChildProcess | null = null;

  start() {
    if (this.helperProcess) return; // already inhibiting

    this.helperProcess = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH],
      { stdio: 'ignore' }
    );
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
