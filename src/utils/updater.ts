// "Check for updates": asks GitHub for the newest release of Link and compares it with this build.
//
// Releases are published on the project's own repository, one tag per version (v0.1.0, v0.2.0, ...),
// so each download is tied to the exact source it was built from. Nothing is downloaded here; the user is
// sent to the release page.

interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface ReleaseInfo {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  release?: ReleaseInfo;
  error?: string;
}

/** This build's version, from package.json. */
export const CURRENT_VERSION: string = __APP_VERSION__;

const RELEASE_REPO = 'dixittharunraja/link';

/**
 * Compares two versions such as '0.1.0' and 'v0.2.0'.
 * Returns 1 when `latest` is newer, 0 when they are the same, -1 when `latest` is older.
 */
export function compareVersions(current: string, latest: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').trim().split('.').map((n) => parseInt(n, 10) || 0);
  const c = parts(current);
  const l = parts(latest);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return 1;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return -1;
  }
  return 0;
}

/** The version a release stands for: its tag (v0.2.0), or the first version found in its name or notes. */
export function versionOfRelease(tag: string | undefined, name: string | undefined, body: string | undefined): string | null {
  const fromTag = /^v?(\d+\.\d+\.\d+)$/.exec((tag ?? '').trim());
  if (fromTag) return fromTag[1];
  const fromText = /v?(\d+\.\d+\.\d+)/.exec(`${name ?? ''} ${body ?? ''}`);
  return fromText ? fromText[1] : null;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const none = (error: string): UpdateCheckResult => ({ hasUpdate: false, currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION, error });
  try {
    // "latest" is GitHub's newest full release (drafts and pre-releases are skipped).
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (res.status === 404) return none('No releases published yet.');
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const data = await res.json();
    const version = versionOfRelease(data.tag_name, data.name, data.body);
    if (!version) return none('The latest release does not say which version it is.');

    return {
      hasUpdate: compareVersions(CURRENT_VERSION, version) > 0,
      currentVersion: CURRENT_VERSION,
      latestVersion: version,
      release: {
        version,
        name: data.name || `Link v${version}`,
        body: data.body || '',
        publishedAt: data.published_at || '',
        htmlUrl: data.html_url || `https://github.com/${RELEASE_REPO}/releases`,
        assets: (data.assets || []).map((a: any) => ({ name: a.name, size: a.size, browser_download_url: a.browser_download_url })),
      },
    };
  } catch (err: any) {
    return none(err?.message || 'Failed to check for updates. Check your internet connection.');
  }
}
