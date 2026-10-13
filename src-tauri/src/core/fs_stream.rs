use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::core::transport::DeviceManager;

// A loopback-only HTTP server that lets any media player stream a file straight from a phone, with
// seeking: each HTTP Range request becomes one or more file-system reads on the peer. Every URL
// carries a random per-device token, and only 127.0.0.1 is bound.

const STREAM_CHUNK: u64 = 1024 * 1024;

struct StreamServer {
    port: u16,
    // token -> device id
    tokens: Mutex<HashMap<String, String>>,
}

static SERVER: OnceLock<StreamServer> = OnceLock::new();

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().map(str::to_lowercase).as_deref() {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("opus") => "audio/ogg",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default())
}

/// Parses "bytes=a-b" (either bound optional) against the file size; returns the inclusive range.
fn parse_range(header: Option<&str>, size: u64) -> Option<(u64, u64)> {
    let spec = header?.trim().strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.parse::<u64>().ok(), end.parse::<u64>().ok()) {
        (Some(s), Some(e)) => (s, e.min(size.saturating_sub(1))),
        (Some(s), None) => (s, size.saturating_sub(1)),
        (None, Some(n)) => (size.saturating_sub(n), size.saturating_sub(1)),
        (None, None) => return None,
    };
    (start <= end && start < size).then_some((start, end))
}

async fn respond(stream: &mut TcpStream, status: &str, headers: &str, body: &[u8]) {
    let head = format!("HTTP/1.1 {}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n", status, headers, body.len());
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

async fn serve(manager: Arc<DeviceManager>, mut stream: TcpStream) {
    let mut buf = vec![0u8; 8192];
    let Ok(n) = stream.read(&mut buf).await else { return };
    let request = String::from_utf8_lossy(&buf[..n]).to_string();
    let mut lines = request.lines();
    let target = lines.next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next()).unwrap_or("");
    let range_header = lines.find_map(|l| l.strip_prefix("Range:").or_else(|| l.strip_prefix("range:"))).map(str::to_string);
    let (path_part, query) = target.split_once('?').unwrap_or((target, ""));

    let token = path_part.trim_start_matches('/').split('/').next().unwrap_or("");
    let device_id = SERVER.get().and_then(|s| s.tokens.lock().ok().and_then(|t| t.get(token).cloned()));
    let (Some(device_id), Some(remote_path)) = (device_id, query_param(query, "p")) else {
        return respond(&mut stream, "403 Forbidden", "", b"").await;
    };

    let Ok((false, size)) = manager.fs_stat(&device_id, &remote_path).await else {
        return respond(&mut stream, "404 Not Found", "", b"").await;
    };
    let (start, end, partial) = match parse_range(range_header.as_deref(), size) {
        Some((s, e)) => (s, e, true),
        None => (0, size.saturating_sub(1), false),
    };
    let length = if size == 0 { 0 } else { end - start + 1 };

    let mut headers = format!("Access-Control-Allow-Origin: *\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\n", mime_for(&remote_path));
    if partial {
        headers.push_str(&format!("Content-Range: bytes {}-{}/{}\r\n", start, end, size));
    }
    let head = format!("HTTP/1.1 {}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n", if partial { "206 Partial Content" } else { "200 OK" }, headers, length);
    if stream.write_all(head.as_bytes()).await.is_err() {
        return;
    }

    let mut offset = start;
    while length > 0 && offset <= end {
        let want = STREAM_CHUNK.min(end - offset + 1);
        let Ok(bytes) = manager.fs_read(&device_id, &remote_path, offset, want).await else { return };
        if bytes.is_empty() || stream.write_all(&bytes).await.is_err() {
            return;
        }
        offset += bytes.len() as u64;
    }
}

impl DeviceManager {
    /// Returns a loopback URL a media player can stream `remote_path` from.
    pub async fn fs_stream_url(self: &Arc<Self>, device_id: &str, remote_path: &str) -> Result<String, String> {
        if SERVER.get().is_none() {
            let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            if SERVER.set(StreamServer { port, tokens: Mutex::new(HashMap::new()) }).is_ok() {
                let manager = self.clone();
                tokio::spawn(async move {
                    while let Ok((stream, _)) = listener.accept().await {
                        tokio::spawn(serve(manager.clone(), stream));
                    }
                });
            }
        }
        let server = SERVER.get().ok_or("Stream server unavailable")?;
        let token = {
            let mut tokens = server.tokens.lock().map_err(|e| e.to_string())?;
            match tokens.iter().find(|(_, d)| d.as_str() == device_id) {
                Some((token, _)) => token.clone(),
                None => {
                    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
                    tokens.insert(token.clone(), device_id.to_string());
                    token
                }
            }
        };
        let file_name = remote_path.replace('\\', "/").rsplit('/').next().unwrap_or("file").to_string();
        Ok(format!(
            "http://127.0.0.1:{}/{}/{}?p={}",
            server.port,
            token,
            urlencoding::encode(&file_name),
            urlencoding::encode(remote_path)
        ))
    }
}
