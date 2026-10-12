// Tauri's Android WebView reports Android in its user agent; the desktop webviews never do. Used
// instead of a Tauri OS plugin because bridge.ts needs the answer synchronously at import time.
export const IS_ANDROID = /Android/i.test(navigator.userAgent);

// Stands in for a device id when the remote control viewer is attached to an unpaired PC joined by
// address: there is no paired device to address, so the bridge routes it through the guest socket.
export const GUEST_REMOTE_CONTROL_ID = 'guest-remote-control';
