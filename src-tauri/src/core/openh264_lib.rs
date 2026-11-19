// Cisco's OpenH264 library, fetched on first use instead of being built into Link.
//
// H.264 is covered by patents. Cisco pays the licence fees for the OpenH264 binaries it hosts, provided
// each user's machine downloads them rather than the product shipping or compiling its own copy
// (https://www.openh264.org/faq.html). When the user first shares this PC's screen, the UI asks, and
// this module downloads Cisco's file over HTTPS, decompresses it and checks a pinned SHA-256 before it
// is loaded. This is the only internet access in the Rust core.
//
// Only the encoder on this PC needs the library: phones encode with their own hardware, and the
// WebView decodes what the PC receives.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// The version Link is built against; the Rust bindings must match the library's interface.
pub const VERSION: &str = "2.7.0";
const FILE_NAME: &str = "openh264-2.7.0-win64.dll";
const SOURCE_URL: &str = "https://ciscobinary.openh264.org/openh264-2.7.0-win64.dll.bz2";
/// SHA-256 of the decompressed DLL, as published for this release (the openh264 crate carries the same list).
const SHA256_HEX: &str = "0ef5e7f3b38753b15c13afa0418d4d7805fa228e6adfd3e425bbf758cff1c288";
/// Size limits that stop a wrong or hostile response from filling the disk.
const MAX_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LIBRARY_BYTES: u64 = 8 * 1024 * 1024;

/// The error returned when something needs the library and it is not installed yet.
pub const NOT_INSTALLED: &str = "The H.264 video component is not installed.";

pub fn library_path(config_dir: &Path) -> PathBuf {
    config_dir.join("components").join(FILE_NAME)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// The size and modification time of a library file that already passed the checksum, by path. Hashing
/// the 1 MB DLL took a full read on every status poll and before every encoder or decoder; a file whose
/// size and time are unchanged is the same file. Loading is still safe if it was swapped in between:
/// the openh264 crate checks the hash again itself (see load_api).
static VERIFIED: std::sync::Mutex<Option<(PathBuf, u64, std::time::SystemTime)>> = std::sync::Mutex::new(None);

/// True when the library is on disk and is exactly the file Cisco published.
pub fn is_installed(config_dir: &Path) -> bool {
    let path = library_path(config_dir);
    let Ok(meta) = std::fs::metadata(&path) else { return false };
    let stamp = meta.modified().ok().map(|modified| (meta.len(), modified));
    if let (Some((len, modified)), Ok(verified)) = (stamp, VERIFIED.lock()) {
        if verified.as_ref().is_some_and(|(p, l, m)| *p == path && *l == len && *m == modified) {
            return true;
        }
    }
    let ok = std::fs::read(&path).map(|bytes| sha256_hex(&bytes) == SHA256_HEX).unwrap_or(false);
    if let (true, Some((len, modified)), Ok(mut verified)) = (ok, stamp, VERIFIED.lock()) {
        *verified = Some((path, len, modified));
    }
    ok
}

pub fn status(config_dir: &Path) -> Value {
    json!({
        "supported": cfg!(all(windows, target_arch = "x86_64")),
        "installed": is_installed(config_dir),
        "version": VERSION,
        "source": "ciscobinary.openh264.org",
    })
}

/// Downloads, unpacks and verifies the library. Blocking; call it from a worker thread.
#[cfg(all(windows, target_arch = "x86_64"))]
pub fn install(config_dir: &Path) -> Result<(), String> {
    use std::io::Read;

    if is_installed(config_dir) {
        return Ok(());
    }

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(90)))
        .build()
        .into();
    let mut response = agent.get(SOURCE_URL).call().map_err(|e| format!("Could not download the video component from Cisco: {e}"))?;
    let compressed = response
        .body_mut()
        .with_config()
        .limit(MAX_DOWNLOAD_BYTES)
        .read_to_vec()
        .map_err(|e| format!("The download from Cisco was interrupted: {e}"))?;

    let mut library = Vec::new();
    bzip2::read::BzDecoder::new(compressed.as_slice())
        .take(MAX_LIBRARY_BYTES + 1)
        .read_to_end(&mut library)
        .map_err(|e| format!("The downloaded file could not be unpacked: {e}"))?;
    if library.len() as u64 > MAX_LIBRARY_BYTES {
        return Err("The downloaded file is larger than expected, so it was rejected.".into());
    }
    if sha256_hex(&library) != SHA256_HEX {
        return Err("The downloaded file does not match Cisco's published checksum, so it was rejected.".into());
    }

    let path = library_path(config_dir);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the components folder: {e}"))?;
    }
    // Written beside the final name and renamed, so a half-written file is never mistaken for the library.
    let partial = path.with_extension("dll.part");
    std::fs::write(&partial, &library).map_err(|e| format!("Could not save the video component: {e}"))?;
    std::fs::rename(&partial, &path).map_err(|e| format!("Could not save the video component: {e}"))?;
    Ok(())
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
pub fn install(_config_dir: &Path) -> Result<(), String> {
    Err("The H.264 video component is only available for 64-bit Windows.".into())
}

/// Loads the library for the encoder. The openh264 crate checks the file against its own list of Cisco's
/// published hashes as well, on top of the check above.
pub fn load_api(config_dir: &Path) -> Result<openh264::OpenH264API, String> {
    if !is_installed(config_dir) {
        return Err(NOT_INSTALLED.into());
    }
    openh264::OpenH264API::from_blob_path(library_path(config_dir)).map_err(|e| format!("Could not load the video component: {e}"))
}

#[cfg(all(test, windows, target_arch = "x86_64"))]
mod tests {
    use super::*;
    use openh264::encoder::{Encoder, EncoderConfig};
    use openh264::formats::YUVBuffer;

    /// Needs the network: fetches the library from Cisco exactly as the app does. Run with
    /// `cargo test --lib openh264_lib -- --ignored`.
    #[test]
    #[ignore = "downloads from Cisco"]
    fn downloads_verifies_loads_and_encodes() {
        let dir = std::env::temp_dir().join(format!("link-h264-test-{}", std::process::id()));
        assert!(!is_installed(&dir));
        assert_eq!(load_api(&dir).err().as_deref(), Some(NOT_INSTALLED));

        install(&dir).expect("download and verify");
        assert!(is_installed(&dir));
        install(&dir).expect("installing again is a no-op");

        {
            let api = load_api(&dir).expect("the library loads");
            let mut encoder = Encoder::with_api_config(api, EncoderConfig::new()).expect("an encoder can be created");
            let frame = YUVBuffer::new(64, 64);
            let stream = encoder.encode(&frame).expect("a frame encodes");
            assert!(!stream.to_vec().is_empty(), "the encoder produced no bytes");
        } // dropping the encoder unloads the DLL; Windows will not let a loaded DLL be replaced

        // A file that is not Cisco's must be refused.
        std::fs::write(library_path(&dir), b"not the real library").unwrap();
        assert!(!is_installed(&dir));
        assert_eq!(load_api(&dir).err().as_deref(), Some(NOT_INSTALLED));

        std::fs::remove_dir_all(&dir).ok();
    }
}
