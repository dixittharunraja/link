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

pub struct PacketStreamReader {
    buffer: Vec<u8>,
}

impl PacketStreamReader {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<LinkPacket> {
        self.buffer.extend_from_slice(chunk);
        let mut packets = Vec::new();

        while let Some(pos) = self.buffer.iter().position(|&b| b == b'\n') {
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

        packets
    }
}
