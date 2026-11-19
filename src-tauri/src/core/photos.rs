use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::core::transport::DeviceManager;

// The "Recent photos" strip: the newest photos on a paired phone, read on demand. Nothing is synced; only small
// thumbnails are cached.
//
// Wire format (the phone's file server, LinkFsServer.java, on the same connection as listing and reading):
//   recentPhotos { limit (<= 60), before? (ms, continue after the last photo of the previous page) }
//       -> { success, photos: [{ path, name, size, modified (ms) }] }, newest first
//   thumbnail { path, max (longest side, 64..4096), quality (30..95) }
//       -> binary frame carrying a JPEG (the phone applies EXIF rotation and converts PNG / WebP / HEIC to JPEG)
// The file explorer uses the same thumbnails for image files on the phone. They are cached on disk (see photo_thumbnail).
// A photo's bytes are fetched with the ordinary "read" action only when it is saved, opened or copied.

const THUMB_SIDE: u32 = 256;
const THUMB_QUALITY: u32 = 70;
// The viewer's preview: big enough to look sharp on a normal screen, far smaller than the original.
const PREVIEW_SIDE_LIMIT: u32 = 2048;
const PREVIEW_QUALITY: u32 = 75;
// Copying to the clipboard asks the phone for a full-size JPEG when the original is not a format decoded here.
const COPY_SIDE: u32 = 4096;
const COPY_QUALITY: u32 = 92;
// Originals larger than this are converted on the phone instead of being pulled over the network and decoded here.
const MAX_ORIGINAL_BYTES: u64 = 40 * 1024 * 1024;
const READ_CHUNK: u64 = 4 * 1024 * 1024;

fn extension_of(path: &str) -> String {
    path.rsplit('.').next().map(|e| e.to_ascii_lowercase()).unwrap_or_default()
}

/// Formats decoded on this PC. JPEG and HEIC go through the phone instead, which also applies their rotation.
fn decodes_here(path: &str) -> bool {
    matches!(extension_of(path).as_str(), "png" | "webp" | "gif" | "bmp")
}

fn data_url(jpeg: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg))
}

// Cached thumbnails kept on disk; past the high mark the oldest are removed down to the low mark.
const CACHE_HIGH: usize = 4000;
const CACHE_LOW: usize = 3000;
static CACHE_WRITES: AtomicU32 = AtomicU32::new(0);

/// Writes one cached thumbnail (temp file, then rename, so a half-written one is never read) and
/// now and then trims the cache.
fn store_thumbnail(file: &Path, jpeg: &[u8]) {
    let Some(dir) = file.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let partial = file.with_extension("part");
    if std::fs::write(&partial, jpeg).is_err() || std::fs::rename(&partial, file).is_err() {
        let _ = std::fs::remove_file(&partial);
        return;
    }
    if CACHE_WRITES.fetch_add(1, Ordering::Relaxed) % 200 == 0 {
        trim_cache(dir);
    }
}

fn trim_cache(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> =
        read.flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
    if files.len() <= CACHE_HIGH {
        return;
    }
    files.sort();
    for (_, path) in files.iter().take(files.len() - CACHE_LOW) {
        let _ = std::fs::remove_file(path);
    }
}

/// Decodes image bytes to the RGBA pixels the clipboard wants.
fn to_rgba(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let image = image::load_from_memory(bytes).map_err(|e| format!("Could not read the image: {}", e))?.to_rgba8();
    Ok((image.width() as usize, image.height() as usize, image.into_raw()))
}

// Largest allocation one thumbnail decode may make (a 50 MP RGBA image is about 200 MB).
const THUMB_DECODE_LIMIT: u64 = 256 * 1024 * 1024;

/// A JPEG of a local image at most `max_side` pixels on its longest side, turned upright by its
/// EXIF orientation: the `thumbnail` action of this PC's own file server (fs_server.rs), for a phone
/// browsing it. Blocking: call off the async threads.
pub fn thumbnail_jpeg(path: &Path, max_side: u32, quality: u8) -> Result<Vec<u8>, String> {
    let image = if decodes_with_windows(&path.to_string_lossy()) { wic::thumbnail(path, max_side)? } else { decode_thumbnail(path, max_side)? };
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode_image(&image.to_rgb8())
        .map_err(|e| e.to_string())?;
    Ok(jpeg)
}

/// HEIC/HEIF (iPhone and many Android cameras) and AVIF, which the image crate cannot decode. Windows decodes
/// them through WIC with Microsoft's free HEIF and AV1 extensions (preinstalled on Windows 11).
fn decodes_with_windows(path: &str) -> bool {
    matches!(extension_of(path).as_str(), "heic" | "heif" | "hif" | "avif")
}

fn decode_thumbnail(path: &Path, max_side: u32) -> Result<image::DynamicImage, String> {
    use image::ImageDecoder;
    let cannot = |e: image::ImageError| format!("Cannot decode this image: {}", e);
    let mut reader = image::ImageReader::open(path).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(THUMB_DECODE_LIMIT);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(cannot)?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(cannot)?;
    image.apply_orientation(orientation);
    if image.width().max(image.height()) > max_side {
        image = image.thumbnail(max_side, max_side);
    }
    Ok(image)
}

#[cfg(windows)]
mod wic {
    use std::path::Path;

    use windows::core::{w, HSTRING};
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    struct Com(bool);
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Decodes the first frame scaled inside the decoder (WIC's Fant scaler reads only what it needs, so a 48 MP HEIC
    /// is never expanded in full), then turns it upright: WIC decoders report the orientation but never apply it.
    pub fn thumbnail(path: &Path, max_side: u32) -> Result<image::DynamicImage, String> {
        let fail = |what: &str, e: windows::core::Error| format!("Cannot decode this image ({}): {}", what, e.message());
        unsafe {
            // A blocking-pool thread may already be in COM; only a successful init here is undone.
            let _com = Com(CoInitializeEx(None, COINIT_MULTITHREADED).is_ok());
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(|e| fail("imaging", e))?;
            let decoder = factory
                .CreateDecoderFromFilename(&HSTRING::from(path.as_os_str()), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)
                .map_err(|e| fail("no Windows codec for this format; install Microsoft's HEIF or AV1 extension", e))?;
            let frame = decoder.GetFrame(0).map_err(|e| fail("frame", e))?;
            let (mut width, mut height) = (0u32, 0u32);
            frame.GetSize(&mut width, &mut height).map_err(|e| fail("size", e))?;
            if width == 0 || height == 0 {
                return Err("Cannot decode this image: it is empty".into());
            }
            let scale = (max_side as f64 / width.max(height) as f64).min(1.0);
            let (w, h) = (((width as f64 * scale).round() as u32).max(1), ((height as f64 * scale).round() as u32).max(1));
            let scaler = factory.CreateBitmapScaler().map_err(|e| fail("scaler", e))?;
            scaler.Initialize(&frame, w, h, WICBitmapInterpolationModeFant).map_err(|e| fail("scale", e))?;
            let converter = factory.CreateFormatConverter().map_err(|e| fail("converter", e))?;
            converter
                .Initialize(&scaler, &GUID_WICPixelFormat24bppRGB, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
                .map_err(|e| fail("convert", e))?;
            let stride = w * 3;
            let mut pixels = vec![0u8; (stride * h) as usize];
            converter.CopyPixels(std::ptr::null(), stride, &mut pixels).map_err(|e| fail("pixels", e))?;
            let rgb = image::RgbImage::from_raw(w, h, pixels).ok_or("Cannot decode this image: bad size")?;
            let mut image = image::DynamicImage::ImageRgb8(rgb);
            if let Some(orientation) = orientation(&frame).and_then(image::metadata::Orientation::from_exif) {
                image.apply_orientation(orientation);
            }
            Ok(image)
        }
    }

    /// The EXIF-style orientation (1-8) the decoder reports, if any.
    unsafe fn orientation(frame: &IWICBitmapFrameDecode) -> Option<u8> {
        let reader = unsafe { frame.GetMetadataQueryReader() }.ok()?;
        let mut value = PROPVARIANT::default();
        unsafe { reader.GetMetadataByName(w!("System.Photo.Orientation"), &mut value) }.ok()?;
        u16::try_from(&value).ok().and_then(|v| u8::try_from(v).ok())
    }
}

#[cfg(not(windows))]
mod wic {
    pub fn thumbnail(_path: &std::path::Path, _max_side: u32) -> Result<image::DynamicImage, String> {
        Err("HEIC and AVIF thumbnails are only decoded on Windows".into())
    }
}

impl DeviceManager {
    /// Newest photos on the phone, as the array the phone returned (see the wire format above).
    pub async fn recent_photos(&self, device_id: &str, limit: u32, before: Option<i64>) -> Result<Value, String> {
        let mut args = json!({ "limit": limit.clamp(1, 60) });
        if let Some(before) = before.filter(|b| *b > 0) {
            args["before"] = json!(before);
        }
        let reply = self.fs_request(device_id, "recentPhotos", args).await?;
        Ok(reply.get("photos").cloned().unwrap_or_else(|| json!([])))
    }

    /// A small JPEG of one photo, as a data URL an <img> can show. Thumbnails are kept on disk,
    /// keyed by the photo's path, size and modification time, so a folder opened again (or the
    /// strip reopened after a restart) costs no decode on the phone. The explorer and the strip
    /// pass the size and time from their listings; without them a stat reads them first.
    ///
    /// `max` asks for a larger JPEG (the viewer's screen-sized preview). Those are made on demand
    /// and not stored on disk, so browsing photos leaves no cache behind; the viewer keeps a few in memory.
    pub async fn photo_thumbnail(&self, device_id: &str, path: &str, known: Option<(u64, u64)>, max: Option<u32>) -> Result<String, String> {
        if let Some(side) = max.filter(|side| *side > THUMB_SIDE) {
            let jpeg = self.photo_jpeg(device_id, path, side.min(PREVIEW_SIDE_LIMIT), PREVIEW_QUALITY).await?;
            return Ok(data_url(&jpeg));
        }
        let stamp = match known {
            Some(stamp) => Some(stamp),
            None => self
                .fs_request(device_id, "stat", json!({ "path": path }))
                .await
                .ok()
                .and_then(|stat| Some((stat.get("size")?.as_u64()?, stat.get("mtime")?.as_u64()?))),
        };
        let cache_file = match stamp {
            Some((size, mtime)) => Some(self.thumbnail_cache_file(device_id, path, size, mtime).await),
            None => None,
        };
        if let Some(file) = &cache_file {
            if let Ok(jpeg) = tokio::fs::read(file).await {
                return Ok(data_url(&jpeg));
            }
        }
        let jpeg = self.photo_jpeg(device_id, path, THUMB_SIDE, THUMB_QUALITY).await?;
        if let Some(file) = cache_file {
            let bytes = jpeg.clone();
            tokio::task::spawn_blocking(move || store_thumbnail(&file, &bytes));
        }
        Ok(data_url(&jpeg))
    }

    /// Where the thumbnail of this version (size and modification time) of a photo is cached.
    async fn thumbnail_cache_file(&self, device_id: &str, path: &str, size: u64, mtime: u64) -> PathBuf {
        let dir = match self.app_handle().await.and_then(|app| app.path().app_cache_dir().ok()) {
            Some(dir) => dir.join("thumbnails"),
            None => std::env::temp_dir().join("link-thumbnails"),
        };
        let key = Sha256::digest(format!("{}\n{}\n{}\n{}\n{}", device_id, path, size, mtime, THUMB_SIDE).as_bytes());
        dir.join(format!("{}.jpg", hex::encode(&key[..16])))
    }

    async fn photo_jpeg(&self, device_id: &str, path: &str, side: u32, quality: u32) -> Result<Vec<u8>, String> {
        let reply = self.fs_request_data(device_id, false, "thumbnail", json!({ "path": path, "max": side, "quality": quality })).await?;
        reply.data.filter(|d| !d.is_empty()).ok_or_else(|| "The phone sent no image data".to_string())
    }

    async fn read_whole(&self, device_id: &str, path: &str, size: u64) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::with_capacity(size as usize);
        let mut offset = 0;
        while offset < size {
            let chunk = self.fs_read(device_id, path, offset, READ_CHUNK.min(size - offset)).await?;
            if chunk.is_empty() {
                break;
            }
            offset += chunk.len() as u64;
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    /// Puts a photo on this PC's clipboard as an image. PNG / WebP / GIF / BMP originals are copied as they are (a screenshot
    /// stays sharp); anything else, or anything that will not decode, is converted to a full-size JPEG by the phone.
    pub async fn copy_photo_to_clipboard(&self, device_id: &str, path: &str) -> Result<(), String> {
        let mut decoded = None;
        if decodes_here(path) {
            let (_, size) = self.fs_stat(device_id, path).await?;
            if size > 0 && size <= MAX_ORIGINAL_BYTES {
                let bytes = self.read_whole(device_id, path, size).await?;
                decoded = tokio::task::spawn_blocking(move || to_rgba(&bytes)).await.map_err(|e| e.to_string())?.ok();
            }
        }
        let (width, height, rgba) = match decoded {
            Some(done) => done,
            None => {
                let jpeg = self.photo_jpeg(device_id, path, COPY_SIDE, COPY_QUALITY).await?;
                tokio::task::spawn_blocking(move || to_rgba(&jpeg)).await.map_err(|e| e.to_string())??
            }
        };
        tokio::task::spawn_blocking(move || {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard
                .set_image(arboard::ImageData { width, height, bytes: std::borrow::Cow::Owned(rgba) })
                .map_err(|e| format!("Could not copy the image: {}", e))
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_formats_by_extension() {
        assert!(decodes_here("/storage/emulated/0/Pictures/Screenshots/Screenshot_1.PNG"));
        assert!(decodes_here("a.webp"));
        assert!(!decodes_here("/DCIM/Camera/IMG_1.jpg"));
        assert!(!decodes_here("/DCIM/Camera/IMG_2.heic"));
        assert!(!decodes_here("noextension"));
    }

    #[test]
    fn decodes_a_png_to_rgba() {
        let mut png = Vec::new();
        let source = image::RgbaImage::from_pixel(3, 2, image::Rgba([10, 20, 30, 255]));
        image::DynamicImage::ImageRgba8(source).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let (width, height, rgba) = to_rgba(&png).unwrap();
        assert_eq!((width, height, rgba.len()), (3, 2, 3 * 2 * 4));
        assert_eq!(&rgba[..4], &[10, 20, 30, 255]);
        assert!(to_rgba(b"not an image").is_err());
    }

    /// Writes a real HEIC with Windows' own HEIF encoder (left half red, right half blue), then thumbnails it through
    /// the WIC path. Needs Microsoft's HEIF and HEVC extensions, so it is not part of the normal run.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn thumbnails_a_heic_through_windows() {
        use windows::Win32::Foundation::GENERIC_WRITE;
        use windows::Win32::Graphics::Imaging::*;
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
        let file = std::env::temp_dir().join(format!("link-thumb-test-{}.heic", std::process::id()));
        let (w, h) = (400u32, 200u32);
        // 32bpp BGR (the fourth byte is unused): the pixel format Windows' HEIF encoder takes.
        let mut bgr = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..h {
            for x in 0..w {
                bgr.extend_from_slice(if x < w / 2 { &[0, 0, 255, 255] } else { &[255, 0, 0, 255] });
            }
        }
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).unwrap();
            let stream = factory.CreateStream().unwrap();
            stream.InitializeFromFilename(&windows::core::HSTRING::from(file.as_os_str()), GENERIC_WRITE.0).unwrap();
            let encoder = factory.CreateEncoder(&GUID_ContainerFormatHeif, std::ptr::null()).expect("HEIF encoder (needs the HEIF and HEVC extensions)");
            encoder.Initialize(&stream, WICBitmapEncoderNoCache).unwrap();
            let (mut frame, mut options) = (None, None);
            encoder.CreateNewFrame(&mut frame, &mut options).unwrap();
            let frame = frame.unwrap();
            frame.Initialize(options.as_ref()).unwrap();
            frame.SetSize(w, h).unwrap();
            let mut format = GUID_WICPixelFormat32bppBGR;
            frame.SetPixelFormat(&mut format).unwrap();
            assert_eq!(format, GUID_WICPixelFormat32bppBGR, "the HEIF encoder wants another pixel format");
            frame.WritePixels(h, w * 4, &bgr).unwrap();
            frame.Commit().unwrap();
            encoder.Commit().unwrap();
        }
        let thumb = image::load_from_memory(&thumbnail_jpeg(&file, 100, 90).unwrap()).unwrap().to_rgb8();
        let _ = std::fs::remove_file(&file);
        assert_eq!((thumb.width(), thumb.height()), (100, 50));
        let (left, right) = (thumb.get_pixel(20, 25), thumb.get_pixel(80, 25));
        assert!(left[0] > 180 && left[2] < 80, "left should be red, got {:?}", left);
        assert!(right[2] > 180 && right[0] < 80, "right should be blue, got {:?}", right);
    }

    #[test]
    fn makes_a_bounded_jpeg_thumbnail() {
        let dir = std::env::temp_dir().join(format!("link-thumb-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("wide.png");
        image::RgbImage::from_pixel(400, 100, image::Rgb([200, 10, 10])).save(&file).unwrap();
        let thumb = image::load_from_memory(&thumbnail_jpeg(&file, 100, 70).unwrap()).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (100, 25));
        std::fs::write(dir.join("bad.png"), b"not an image").unwrap();
        assert!(thumbnail_jpeg(&dir.join("bad.png"), 100, 70).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
