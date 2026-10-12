use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::core::packet::LinkPacket;
use crate::core::transport::DeviceManager;

// Wire protocol shared with the Android core (LinkSpeedTest.java): ping rounds measure latency,
// then each bulk leg moves raw bytes over a separate one-shot TLS connection (the "payload
// channel") whose port travels in the packet's payloadTransferInfo.
pub const REQUEST: &str = "link.speedtest.request";
pub const RESPONSE: &str = "link.speedtest.response";

const PAYLOAD_MB: usize = 20;
const PING_ROUNDS: usize = 5;
const STEP_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedTestResult {
    latency_ms: u64,
    upload_speed_mbps: f64,
    download_speed_mbps: f64,
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn mbps(megabytes: f64, started: Instant) -> f64 {
    megabytes * 8.0 / started.elapsed().as_secs_f64().max(0.001)
}

fn step_of(pkt: &LinkPacket) -> &str {
    pkt.body.get("step").and_then(|v| v.as_str()).unwrap_or("")
}

fn payload_port(pkt: &LinkPacket) -> Option<u16> {
    pkt.payload_transfer_info.as_ref()?.get("port")?.as_u64().map(|p| p as u16)
}

fn request(test_id: &str, step: &str) -> LinkPacket {
    LinkPacket::new(REQUEST, serde_json::json!({ "testId": test_id, "step": step, "payloadMb": PAYLOAD_MB }))
}

impl DeviceManager {
    /// Serves `bytes` zero-filled bytes to one connecting peer; returns the port to announce.
    async fn serve_payload(self: &Arc<Self>, bytes: usize) -> Result<u16, String> {
        let listener = TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let acceptor = self.tls_acceptor();
        tokio::spawn(async move {
            let Ok(Ok((stream, _))) = tokio::time::timeout(STEP_TIMEOUT, listener.accept()).await else { return };
            let Ok(mut tls) = acceptor.accept(stream).await else { return };
            let chunk = vec![0u8; 64 * 1024];
            let mut sent = 0;
            while sent < bytes {
                let n = chunk.len().min(bytes - sent);
                if tls.write_all(&chunk[..n]).await.is_err() {
                    return;
                }
                sent += n;
            }
            let _ = tls.shutdown().await;
        });
        Ok(port)
    }

    /// Pulls a payload from the peer's payload server, refusing it unless the certificate it
    /// presents is the one pinned for that device. Returns the byte count.
    async fn fetch_payload(self: &Arc<Self>, device_id: &str, port: u16) -> Result<usize, String> {
        let (host, pinned) = self
            .peer_endpoint(device_id)
            .await
            .ok_or_else(|| "Missing host or pinned certificate for peer".to_string())?;
        let stream = TcpStream::connect((host.as_str(), port)).await.map_err(|e| e.to_string())?;
        let server_name = rustls::pki_types::ServerName::try_from("link.local".to_string()).map_err(|e| e.to_string())?;
        let mut tls = self.tls_connector().connect(server_name, stream).await.map_err(|e| e.to_string())?;

        let presented = tls
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|c| c.first())
            .map(|c| hex::encode(Sha256::digest(c.as_ref())))
            .ok_or("Payload connection presented no certificate")?;
        if presented != pinned {
            return Err("Payload connection certificate does not match pinned device — refusing transfer".into());
        }

        let mut total = 0;
        let mut buf = vec![0u8; 128 * 1024];
        loop {
            match tls.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => total += n,
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(total)
    }

    async fn await_response(rx: &mut mpsc::Receiver<LinkPacket>, step: &str) -> Result<LinkPacket, String> {
        loop {
            match tokio::time::timeout(STEP_TIMEOUT, rx.recv()).await {
                Err(_) => return Err(format!("Timed out waiting for the {} step", step)),
                Ok(None) => return Err("Connection closed during the speed test".to_string()),
                Ok(Some(pkt)) if step_of(&pkt) == step => return Ok(pkt),
                Ok(Some(_)) => {}
            }
        }
    }

    /// Initiator: latency, then upload, then download, reporting progress as events.
    pub async fn run_speed_test(self: &Arc<Self>, device_id: &str) -> Result<SpeedTestResult, String> {
        let test_id = format!("st-{}", chrono::Utc::now().timestamp_millis());
        let mut rx = self.register_speedtest(&test_id).await;
        let result = self.speed_test_steps(device_id, &test_id, &mut rx).await;
        self.unregister_speedtest(&test_id).await;
        result
    }

    async fn speed_test_steps(
        self: &Arc<Self>,
        device_id: &str,
        test_id: &str,
        rx: &mut mpsc::Receiver<LinkPacket>,
    ) -> Result<SpeedTestResult, String> {
        self.emit_speedtest_progress(device_id, "Starting latency test...").await;
        let mut rtts = Vec::new();
        for _ in 0..PING_ROUNDS {
            let started = Instant::now();
            self.send_link_packet(device_id, request(test_id, "ping")).await?;
            Self::await_response(rx, "ping").await?;
            rtts.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        let latency_ms = (rtts.iter().sum::<f64>() / rtts.len() as f64).round() as u64;

        self.emit_speedtest_progress(device_id, &format!("Measuring upload speed (sending {}MB data)...", PAYLOAD_MB)).await;
        let bytes = PAYLOAD_MB * 1024 * 1024;
        let port = self.serve_payload(bytes).await?;
        let mut upload = request(test_id, "upload");
        upload.payload_size = Some(bytes as i64);
        upload.payload_transfer_info = Some(serde_json::json!({ "port": port }));
        let started = Instant::now();
        self.send_link_packet(device_id, upload).await?;
        let ack = Self::await_response(rx, "upload").await?;
        // The peer reports the bytes it actually received, so the figure can't be inflated by an instant ACK.
        let received_mb = ack.body.get("payloadMb").and_then(|v| v.as_f64()).unwrap_or(PAYLOAD_MB as f64);
        let upload_speed_mbps = mbps(received_mb, started);

        self.emit_speedtest_progress(device_id, &format!("Measuring download speed (receiving {}MB data)...", PAYLOAD_MB)).await;
        let started = Instant::now();
        self.send_link_packet(device_id, request(test_id, "download")).await?;
        let offer = Self::await_response(rx, "download").await?;
        let port = payload_port(&offer).ok_or("Download response missing payloadTransferInfo — cannot measure a real transfer")?;
        let received = self.fetch_payload(device_id, port).await.map_err(|e| format!("Download failed: {}", e))?;
        let download_speed_mbps = mbps(received as f64 / (1024.0 * 1024.0), started);

        Ok(SpeedTestResult {
            latency_ms,
            upload_speed_mbps: round1(upload_speed_mbps),
            download_speed_mbps: round1(download_speed_mbps),
        })
    }

    /// Responder: the peer started a test against this device.
    pub async fn answer_speed_test(self: &Arc<Self>, from: &str, pkt: LinkPacket) {
        let Some(test_id) = pkt.body.get("testId").and_then(|v| v.as_str()).map(str::to_string) else { return };
        let reply = |step: &str, extra: serde_json::Value| {
            let mut body = serde_json::json!({ "testId": test_id, "step": step });
            if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
                b.extend(e.clone());
            }
            LinkPacket::new(RESPONSE, body)
        };

        match step_of(&pkt) {
            "ping" => {
                let _ = self.send_link_packet(from, reply("ping", serde_json::json!({}))).await;
            }
            "upload" => {
                let Some(port) = payload_port(&pkt) else { return };
                if let Ok(received) = self.fetch_payload(from, port).await {
                    let mb = received as f64 / (1024.0 * 1024.0);
                    let _ = self.send_link_packet(from, reply("upload", serde_json::json!({ "payloadMb": mb }))).await;
                }
            }
            "download" => {
                let mb = pkt.body.get("payloadMb").and_then(|v| v.as_u64()).unwrap_or(PAYLOAD_MB as u64) as usize;
                let bytes = mb * 1024 * 1024;
                if let Ok(port) = self.serve_payload(bytes).await {
                    let mut offer = reply("download", serde_json::json!({ "payloadMb": mb }));
                    offer.payload_size = Some(bytes as i64);
                    offer.payload_transfer_info = Some(serde_json::json!({ "port": port }));
                    let _ = self.send_link_packet(from, offer).await;
                }
            }
            _ => {}
        }
    }

    async fn emit_speedtest_progress(&self, device_id: &str, message: &str) {
        if let Some(app) = self.app_handle().await {
            let _ = app.emit("speed-test-progress", serde_json::json!({ "deviceId": device_id, "message": message }));
        }
    }
}
