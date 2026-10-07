import { desktopCapturer } from 'electron';
import { DeviceManager } from '../core/device-manager';
import { createPacket } from '../core/packet';

export class ScreenCaptureServer {
  private isRunning = false;
  private intervalTimer: NodeJS.Timeout | null = null;
  private targetDeviceId: string | null = null;
  private isCapturingFrame = false;

  constructor(private deviceManager: DeviceManager) {}

  public start(targetDeviceId: string) {
    if (this.isRunning && this.targetDeviceId === targetDeviceId) return;
    this.stop();

    this.isRunning = true;
    this.targetDeviceId = targetDeviceId;

    // Capture screen at ~30 FPS (33ms interval)
    this.intervalTimer = setInterval(() => {
      this.captureAndSendFrame();
    }, 33);

    console.log(`[ScreenCaptureServer] Started capture stream for peer ${targetDeviceId}`);
  }

  private async captureAndSendFrame() {
    if (!this.isRunning || !this.targetDeviceId || this.isCapturingFrame) return;
    this.isCapturingFrame = true;

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        // 1600x900-equivalent — a modest bump over the original 1280x720 (this is a JPEG-per-
        // frame polling stream, not a real video codec, so resolution/quality/fps all trade off
        // directly against bandwidth+CPU; frame rate stays at 30fps below since it's the biggest
        // multiplier of the three).
        thumbnailSize: { width: 1600, height: 900 },
      });

      if (!this.isRunning || !this.targetDeviceId) return;

      if (sources && sources.length > 0) {
        // Use primary screen source
        const primarySource = sources[0];
        const thumbnail = primarySource.thumbnail;
        if (thumbnail && !thumbnail.isEmpty()) {
          const jpegBuffer = thumbnail.toJPEG(82);
          const base64Data = jpegBuffer.toString('base64');
          const size = thumbnail.getSize();

          const frameBody = {
            type: 'frame',
            data: base64Data,
            w: size.width,
            h: size.height,
          };

          this.deviceManager.sendTo(
            this.targetDeviceId,
            createPacket('link.remotecontrol.stream', frameBody)
          );
        }
      }
    } catch (err) {
      console.error('[ScreenCaptureServer] Frame capture error:', err);
    } finally {
      this.isCapturingFrame = false;
    }
  }

  public stop() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.isRunning = false;
    this.targetDeviceId = null;
    this.isCapturingFrame = false;
    console.log('[ScreenCaptureServer] Capture stream stopped');
  }
}
