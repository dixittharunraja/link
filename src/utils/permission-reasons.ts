// Permission request reasons - shown in onboarding and settings with info icons

export const PERMISSION_REASONS: Record<string, { title: string; reason: string }> = {
  notificationsSend: {
    title: 'Persistent Notification',
    reason: 'Android requires a persistent notification to allow Link to maintain network sockets in the background when your phone screen is off. Without this, the app loses connection every time you lock your phone.',
  },
  notifications: {
    title: 'Notification Mirroring',
    reason: 'Lets Link access incoming alerts (texts, calls, chats) from your phone so they instantly appear on your PC screen. Your desktop shows who is calling/texting in real-time.',
  },
  notificationAccess: {
    title: 'Notification Listener Access',
    reason: 'Enables media detection — detects what music/audio is currently playing (Spotify, YouTube, etc.). Without this, the media controller will show "No Active Media" even when audio is playing. This is the system-level permission you manually grant in Android Settings → Notifications → Notification Access.',
  },
  phoneState: {
    title: 'Phone State & Caller ID',
    reason: 'Lets Link detect incoming calls so it can automatically pause PC music/video playback during calls. Also required by Android to display the caller\'s number (Android blocks caller ID for non-dialer apps without this permission).',
  },
  contacts: {
    title: 'Contacts Sync',
    reason: 'Matches incoming call/message numbers with your contact names so desktop alerts show who is calling or texting you, not just a phone number.',
  },
  allFiles: {
    title: 'File Sync',
    reason: 'Enables bidirectional file sharing and transfers between your phone and PC. Lets you send files, photos, and documents seamlessly across devices.',
  },
  microphone: {
    title: 'Microphone Access',
    reason: 'Allows your phone to act as a wireless microphone for your PC during Remote Mic sessions. Your phone\'s mic input streams directly to your computer\'s audio.',
  },
  location: {
    title: 'Location',
    reason: 'Lets your paired devices find this phone if it is lost: they can see where it is on a map, and keep its last known position for when it is offline. Your position goes only to your own paired devices over your network or Tailscale, and you can turn it off per device in its permissions.',
  },
  batteryOpt: {
    title: 'Battery Optimization Exemption',
    reason: 'Prevents Android from killing Link when your phone screen is off. Without this exemption, background sync stops after a few minutes of inactivity, breaking mesh connectivity.',
  },
  accessibility: {
    title: 'Accessibility Service',
    reason: 'Powers Remote Input — lets a paired PC navigate, type, and control this phone remotely (D-Pad, keyboard input). This goes through Android\'s Accessibility framework for security.',
  },
  dnd: {
    title: 'Do Not Disturb Access',
    reason: 'Lets Link control Do Not Disturb mode on this phone remotely from your PC. A paired desktop can enable/disable DND to silence notifications during focus sessions.',
  },
  overlay: {
    title: 'Display Over Other Apps',
    reason: 'Lets the presenter pointer-dot appear on top of whatever app you\'re actually presenting from (slides, a PDF viewer, etc.) when a peer controls it remotely, instead of only showing while Link itself is in the foreground.',
  },
};
