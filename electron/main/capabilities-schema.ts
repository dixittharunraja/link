// Centralized permission/capability keys and metadata.

export const ALL_PERMISSION_KEYS = [
  'fileaccess',
  'lock',
  'runcommand',
  'presenter',
  'flashlight',
  'systemvolume',
  'mpris',
  'telephony',
  'notification',
  'dnd',
  'clipboard',
  'remoteinput',
] as const;

export type PermissionKey = typeof ALL_PERMISSION_KEYS[number];

// Features whose incomingCapabilities lists are pushed to peers (gates visibility in the UI —
// DeviceControlPanel.tsx's supportsIncoming() hides a control until the peer announces it).
// Everything below is announced; telephony/notification/dnd/clipboard are the only keys that
// intentionally aren't (those surface their own state through a different channel, not a button
// gated on capability announcement). flashlight used to be left out here too — that wasn't
// deliberate, it just meant the peer never announced 'link.flashlight' support, so the button
// stayed permanently hidden even with the permission granted (see fileaccess/lock/runcommand/
// remoteinput below, which need to be in this list for the exact same reason).
export const GATED_CAPABILITY_KEYS: PermissionKey[] = [
  'presenter',
  'systemvolume',
  'mpris',
  'lock',
  'runcommand',
  'remoteinput',
  'flashlight',
  'fileaccess',
];
