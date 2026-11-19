pub mod identity;
pub mod trust;
pub mod pairing;
pub mod pairing_window;
pub mod pool;
pub mod tailnet;
pub mod packet;
pub mod discovery;
pub mod mdns;
pub mod transport;
pub mod speedtest;
pub mod share;
pub mod sendto;
pub mod sysevents;
pub mod fs_client;

pub mod permissions;
pub mod plugins;
pub mod host;
pub mod settings;
pub mod input_relay;
pub mod presenter;
pub mod fs_server;
pub mod fs_stream;
pub mod fs_transfer;
pub mod photos;
pub mod mount;
pub mod guest;
pub mod input_guest;
pub mod joystick;
pub mod walkie_talkie;
pub mod portal;
pub mod audio_sink;
pub mod camera_rx;
pub mod openh264_lib;
pub mod h264_encoder;
pub mod rtc_share;
pub mod screen_capture;
pub mod cursor;
pub mod display_helper;
pub mod reconnect;

// Unit tests for trust, permissions, pairing codes and wire parsing (cargo test --lib).
#[cfg(test)]
mod tests;
