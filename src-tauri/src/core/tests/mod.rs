// Unit tests for the parts of the core that decide who is trusted, what a paired device may do, and how
// messages are read off the wire. They run with `cargo test --lib` and need no network or devices.
//
// Values that must agree with the Android implementation (the pairing code, the pool hash) are checked
// against vectors computed independently of this code, so a test cannot pass by agreeing with itself.

mod helpers;

mod cursor;
mod discovery;
mod identity;
mod packet;
mod pairing;
mod permissions;
mod remote_input;
mod settings;
mod signalling;
mod trust;
mod pairing_window;
mod tailnet;
mod pool;
mod guest;
mod mdns;
mod transport;
