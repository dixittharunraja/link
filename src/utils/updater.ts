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

export const CURRENT_VERSION = '0.1.0';

const GITHUB_REPO = 'dixittharunraja/releases';

/**
 * Compare two semver-like version strings (e.g. '0.1.0' and '0.1.1' or 'v0.2.0')
 * Returns 1 if v2 > v1 (update available), 0 if equal, -1 if v2 < v1
 */
function compareVersions(current: string, latest: string): number {
  const clean = (v: string) => v.replace(/^v/i, '').trim().split('.').map(n => parseInt(n, 10) || 0);
  const [c1, c2, c3] = clean(current);
  const [l1, l2, l3] = clean(latest);

  if (l1 > c1) return 1;
  if (l1 < c1) return -1;
  if (l2 > c2) return 1;
  if (l2 < c2) return -1;
  if (l3 > c3) return 1;
  if (l3 < c3) return -1;
  return 0;
}

/**
 * Check GitHub releases repository for newer version of Link.
 * Fetches tag 'latest' or releases list.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/latest`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        return {
          hasUpdate: false,
          currentVersion: CURRENT_VERSION,
          latestVersion: CURRENT_VERSION,
          error: 'No releases published yet.',
        };
      }
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const latestTag = data.tag_name || '0.1.0';
    const releaseName = data.name || latestTag;
    const body = data.body || '';
    const publishedAt = data.published_at || '';
    const htmlUrl = data.html_url || `https://github.com/${GITHUB_REPO}/releases`;
    const assets: ReleaseAsset[] = (data.assets || []).map((a: any) => ({
      name: a.name,
      size: a.size,
      browser_download_url: a.browser_download_url,
    }));

    // Extract semver from tag name or body if tag is 'latest'
    let effectiveVersion = latestTag;
    if (effectiveVersion === 'latest') {
      const match = (releaseName + ' ' + body).match(/v?(\d+\.\d+\.\d+)/);
      if (match) {
        effectiveVersion = match[1];
      }
    }

    const hasUpdate = compareVersions(CURRENT_VERSION, effectiveVersion) > 0;

    return {
      hasUpdate,
      currentVersion: CURRENT_VERSION,
      latestVersion: effectiveVersion,
      release: {
        version: effectiveVersion,
        name: releaseName,
        body,
        publishedAt,
        htmlUrl,
        assets,
      },
    };
  } catch (err: any) {
    return {
      hasUpdate: false,
      currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION,
      error: err.message || 'Failed to check for updates. Check internet connection.',
    };
  }
}
