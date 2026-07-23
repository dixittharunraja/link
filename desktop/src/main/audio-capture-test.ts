// Standalone, throwaway verification harness for audio-capture.ps1 — NOT part of the Audio Relay
// feature itself. Spawns the capture script, records N seconds of whatever's currently playing
// through the default Windows output device, and writes it to a real .wav file so it can be
// opened in any media player to confirm capture is actually correct (right speed/pitch, right
// channel count, not silence/garbage) before any networking code is built on top of it.
//
// Run after `npm run build:main`:
//   node dist/main/audio-capture-test.js [seconds]
//
// Play something on the machine first (music, a video) — the default output device is what gets
// captured, same as WASAPI loopback always is.

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface CaptureFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
}

function buildWavHeader(format: CaptureFormat, dataLength: number): Buffer {
  const { sampleRate, channels, bitsPerSample, isFloat } = format;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const audioFormat = isFloat ? 3 : 1; // WAVE_FORMAT_IEEE_FLOAT vs WAVE_FORMAT_PCM

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function main() {
  const seconds = Number(process.argv[2]) || 8;
  const scriptPath = path.join(__dirname, '..', 'scripts', 'audio-capture.ps1');
  const outPath = path.join(process.cwd(), `audio-capture-test-${Date.now()}.wav`);

  console.log(`[audio-capture-test] Recording ${seconds}s from default output device...`);
  console.log(`[audio-capture-test] Script: ${scriptPath}`);

  const proc = child_process.spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, 'capture'],
    { windowsHide: true }
  );

  let format: CaptureFormat | null = null;
  let headerBuffer = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let stopped = false;

  proc.stderr.on('data', (d) => {
    console.error('[audio-capture-test:stderr]', d.toString().trim());
  });

  proc.on('error', (err) => {
    console.error('[audio-capture-test] Failed to spawn PowerShell:', err.message);
    process.exit(1);
  });

  proc.stdout.on('data', (chunk: Buffer) => {
    if (stopped) return;

    if (!format) {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const newlineIdx = headerBuffer.indexOf(0x0a); // '\n'
      if (newlineIdx === -1) return; // still waiting for the full header line

      const headerLine = headerBuffer.subarray(0, newlineIdx).toString('utf8');
      const rest = headerBuffer.subarray(newlineIdx + 1);
      try {
        format = JSON.parse(headerLine);
      } catch (e) {
        console.error('[audio-capture-test] Failed to parse format header:', headerLine);
        proc.kill();
        process.exit(1);
      }
      console.log('[audio-capture-test] Format:', format);
      if (rest.length > 0) chunks.push(rest);
      return;
    }

    chunks.push(chunk);
  });

  setTimeout(() => {
    stopped = true;
    proc.kill();

    if (!format) {
      console.error('[audio-capture-test] Never received a format header — capture script likely failed. Check stderr above.');
      process.exit(1);
    }

    const data = Buffer.concat(chunks);
    const wav = Buffer.concat([buildWavHeader(format, data.length), data]);
    fs.writeFileSync(outPath, wav);
    console.log(`[audio-capture-test] Wrote ${(data.length / 1024 / 1024).toFixed(2)}MB -> ${outPath}`);
    console.log('[audio-capture-test] Open it in any media player to verify.');
    process.exit(0);
  }, seconds * 1000);
}

main();
