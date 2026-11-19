import { describe, expect, it } from 'vitest';
import { compareVersions, CURRENT_VERSION, versionOfRelease } from './updater';

describe('comparing versions', () => {
  it('sees a newer patch, minor or major version', () => {
    expect(compareVersions('0.1.0', '0.1.1')).toBe(1);
    expect(compareVersions('0.1.9', '0.2.0')).toBe(1);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(1);
  });

  it('compares numbers, not text (0.10 is newer than 0.9)', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(1);
  });

  it('ignores a leading v and treats equal versions as no update', () => {
    expect(compareVersions('0.2.0', 'v0.2.0')).toBe(0);
  });

  it('never offers an older version as an update', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBe(-1);
  });
});

describe('reading the version of a release', () => {
  it('uses the tag', () => {
    expect(versionOfRelease('v1.2.3', 'Link 1.2.3', '')).toBe('1.2.3');
    expect(versionOfRelease('1.2.3', undefined, undefined)).toBe('1.2.3');
  });

  it('falls back to the name or notes when the tag is not a version', () => {
    expect(versionOfRelease('latest', 'Link v0.4.0', 'notes')).toBe('0.4.0');
    expect(versionOfRelease('latest', 'Latest build', 'Link: v0.5.1 for Windows')).toBe('0.5.1');
  });

  it('gives nothing when there is no version anywhere', () => {
    expect(versionOfRelease('nightly', 'Nightly build', 'no numbers here')).toBeNull();
  });
});

describe('this build', () => {
  it('reports the version from package.json', () => {
    expect(CURRENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
