// The ports the native servers listen on, identical on both platforms: LINK_PORT in
// src-tauri/src/core/transport.rs and the *_PORT constants beside it in core/*.rs, and
// LinkTransport.java on Android. QR codes carry these so a scanned code names the server it is for.
export const LINK_PORT = 1739;
export const AUDIO_SINK_PORT = LINK_PORT + 3;
export const REMOTE_MIC_PORT = AUDIO_SINK_PORT + 2;
export const PORTAL_PORT = LINK_PORT + 7;
export const WALKIE_TALKIE_PORT = LINK_PORT + 8;
export const JOYSTICK_PORT = LINK_PORT + 9;
export const INPUT_GUEST_PORT = LINK_PORT + 10;
