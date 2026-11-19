use serde::{Deserialize, Serialize};

pub const PACKET_TYPE_IDENTITY: &str = "link.identity";
pub const PACKET_TYPE_PAIR: &str = "link.pair";
pub const PACKET_TYPE_HEARTBEAT: &str = "link.heartbeat";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkPacket {
    pub id: i64,
    #[serde(rename = "type")]
    pub packet_type: String,
    pub body: serde_json::Value,
    #[serde(rename = "payloadSize", skip_serializing_if = "Option::is_none")]
    pub payload_size: Option<i64>,
    #[serde(rename = "payloadTransferInfo", skip_serializing_if = "Option::is_none")]
    pub payload_transfer_info: Option<serde_json::Value>,
}

impl LinkPacket {
    pub fn new(packet_type: &str, body: serde_json::Value) -> Self {
        Self {
            id: chrono::Utc::now().timestamp_millis(),
            packet_type: packet_type.to_string(),
            body,
            payload_size: None,
            payload_transfer_info: None,
        }
    }

    pub fn serialize(&self) -> Result<Vec<u8>, serde_json::Error> {
        let mut json = serde_json::to_vec(self)?;
        json.push(b'\n');
        Ok(json)
    }
}

/// Longest line accepted before the peer has identified itself. The identity packet (certificate
/// and capability lists) is a few kilobytes.
pub const MAX_LINE_BEFORE_IDENTITY: usize = 64 * 1024;
/// Longest line accepted from an identified peer. File bytes never travel as packets (they have
/// their own connections, see fs_server.rs), so the largest lines are a share offer listing
/// thousands of files, long clipboard text and notification icons, all far below this.
pub const MAX_LINE: usize = 16 * 1024 * 1024;

pub struct PacketStreamReader {
    buffer: Vec<u8>,
    // Bytes at the start of `buffer` already known to hold no newline.
    scanned: usize,
    limit: usize,
    overflowed: bool,
}

impl PacketStreamReader {
    pub fn new() -> Self {
        Self { buffer: Vec::new(), scanned: 0, limit: MAX_LINE_BEFORE_IDENTITY, overflowed: false }
    }

    /// Sets the longest line accepted from here on.
    pub fn set_limit(&mut self, limit: usize) {
        self.limit = limit;
    }

    /// Whether a line ran past the limit. The reader then holds nothing and the connection should
    /// be dropped, since its framing can no longer be trusted.
    pub fn overflowed(&self) -> bool {
        self.overflowed
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<LinkPacket> {
        if self.overflowed {
            return Vec::new();
        }
        self.buffer.extend_from_slice(chunk);
        let mut packets = Vec::new();

        while let Some(pos) = self.buffer[self.scanned..].iter().position(|&b| b == b'\n').map(|p| p + self.scanned) {
            self.scanned = 0;
            if pos > self.limit {
                break;
            }
            let line = self.buffer.drain(..=pos).collect::<Vec<u8>>();
            // Strip trailing \n or \r\n
            let trimmed = line.strip_suffix(b"\n").unwrap_or(&line);
            let trimmed = trimmed.strip_suffix(b"\r").unwrap_or(trimmed);

            if trimmed.is_empty() {
                continue;
            }

            if let Ok(packet) = serde_json::from_slice::<LinkPacket>(trimmed) {
                packets.push(packet);
            }
        }

        // What is left is an unfinished line, or a finished one that was too long.
        if self.buffer.len() > self.limit {
            self.overflowed = true;
            self.buffer = Vec::new();
            self.scanned = 0;
        } else {
            self.scanned = self.buffer.len();
        }
        packets
    }
}
