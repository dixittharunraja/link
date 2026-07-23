import * as fs from 'fs';
import { FsRoot } from './fs-client';

export function getLocalPhysicalDrives(activeLinkDrives: Set<string>): FsRoot[] {
  const roots: FsRoot[] = [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  for (const letter of letters) {
    const drive = `${letter}:\\`;
    const driveLetter = `${letter}:`;

    // Loop prevention: Skip any drive letters currently occupied by Link mounts
    if (activeLinkDrives.has(driveLetter.toUpperCase())) {
      continue;
    }

    try {
      if (fs.existsSync(drive)) {
        roots.push({
          name: `${letter} Drive`,
          path: drive.replace(/\\/g, '/'),
        });
      }
    } catch (e) {
      // Skip offline/restricted drives (like empty card readers or floppy drives)
    }
  }

  return roots;
}
