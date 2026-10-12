// Screen capture for remote control: grabs the primary display and encodes it as a JPEG sized to
// fit within max_width x max_height, as the Electron core's desktopCapturer thumbnails were.

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::DynamicImage;

pub struct Frame {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub fn capture_jpeg(max_width: u32, max_height: u32, quality: u8) -> Option<Frame> {
    let monitors = xcap::Monitor::all().ok()?;
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())?;
    let shot = monitor.capture_image().ok()?;

    let scale = (max_width as f64 / shot.width() as f64).min(max_height as f64 / shot.height() as f64).min(1.0);
    let (width, height) = (((shot.width() as f64) * scale).round().max(1.0) as u32, ((shot.height() as f64) * scale).round().max(1.0) as u32);
    let resized = if scale < 1.0 {
        image::imageops::resize(&shot, width, height, FilterType::Triangle)
    } else {
        shot
    };

    // JPEG has no alpha channel.
    let rgb = DynamicImage::ImageRgba8(resized).to_rgb8();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, quality).encode_image(&rgb).ok()?;
    Some(Frame { jpeg, width: rgb.width(), height: rgb.height() })
}
