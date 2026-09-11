import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const OWNER = 'dixittharunraja';
const REPO = 'releases';
const RELEASE_TAG = 'latest';

const ARTIFACT_MAPPINGS = [
  {
    pattern: 'dist_electron',
    ext: '.exe',
    targetName: 'link-desktop-setup.exe',
    label: 'Windows Desktop (.exe)'
  },
  {
    path: 'android/app/build/outputs/apk/release/app-release.apk',
    targetName: 'link.apk',
    label: 'Android Package (.apk)'
  },
  {
    pattern: 'dist_electron',
    ext: '.deb',
    targetName: 'link.deb',
    label: 'Linux Package (.deb)'
  }
];

function findFile(mapping) {
  if (mapping.path && fs.existsSync(mapping.path)) {
    return mapping.path;
  }
  if (mapping.pattern && fs.existsSync(mapping.pattern)) {
    const files = fs.readdirSync(mapping.pattern);
    const match = files.find(f => f.endsWith(mapping.ext) && !f.includes('blockmap'));
    if (match) return path.join(mapping.pattern, match);
  }
  return null;
}

function streamUpload(uploadUrl, filePath, targetName, token, retries = 3) {
  return new Promise((resolve, reject) => {
    const stats = fs.statSync(filePath);
    const url = new URL(uploadUrl);

    const attempt = (remainingRetries) => {
      const req = https.request({
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Authorization': `token ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': stats.size,
          'User-Agent': 'rodix-build-publisher'
        },
        timeout: 120000 // 2 minutes
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Upload failed with HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('Connection timed out'));
      });

      req.on('error', (err) => {
        if (remainingRetries > 0) {
          console.log(`\n      ⚠️ Network hiccup (${err.message}). Retrying in 3s... (${remainingRetries} attempts left)`);
          setTimeout(() => attempt(remainingRetries - 1), 3000);
        } else {
          reject(err);
        }
      });

      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(req);
    };

    attempt(retries);
  });
}

async function ensureRepoInitialized(headers) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits`, { headers });
  if (res.status === 409 || res.status === 404) {
    console.log('📝 Initializing empty releases repository with README...');
    const readmeContent = Buffer.from('# Rodix Releases\n\nPublic binary distribution repository for Rodix applications.').toString('base64');
    await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/README.md`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: 'Initial commit: add README',
        content: readmeContent
      })
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

async function uploadRelease() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  // 1. Scan for all built artifacts
  const toUpload = [];
  for (const mapping of ARTIFACT_MAPPINGS) {
    const filePath = findFile(mapping);
    if (filePath) {
      const stats = fs.statSync(filePath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      toUpload.push({
        filePath,
        targetName: mapping.targetName,
        label: mapping.label,
        sizeMB,
        sizeBytes: stats.size
      });
    }
  }

  if (toUpload.length === 0) {
    console.warn('⚠️ No built artifacts found to release.');
    console.log('ℹ️ Run your build command first (e.g., npm run build:windows or npm run build:android).');
    return;
  }

  console.log(`📦 Found ${toUpload.length} artifact(s) ready to publish:`);
  toUpload.forEach(item => {
    console.log(`   • ${item.label}: ${path.basename(item.filePath)} (${item.sizeMB} MB) → ${item.targetName}`);
  });

  if (!token) {
    console.warn('\n⚠️ GITHUB_TOKEN or GH_TOKEN is not set in environment.');
    console.log('ℹ️ To publish directly to GitHub Releases, set $env:GITHUB_TOKEN="your_token"');
    return;
  }

  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'rodix-build-publisher'
  };

  try {
    await ensureRepoInitialized(headers);

    // 2. Get or Create Release
    let release = null;
    const getRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${RELEASE_TAG}`, { headers });

    if (getRes.status === 200) {
      release = await getRes.json();
    } else if (getRes.status === 404) {
      console.log(`\nCreating new release with tag "${RELEASE_TAG}"...`);
      const createRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tag_name: RELEASE_TAG,
          name: `Rodix Ecosystem - Latest Release`,
          body: `Official public release binaries for Rodix applications (Link & Life OS).\n\nDirect downloads are synchronized with rodix.in.`,
          draft: false,
          prerelease: false
        })
      });
      if (!createRes.ok) {
        throw new Error(`Failed to create release: ${createRes.status} ${await createRes.text()}`);
      }
      release = await createRes.json();
    } else {
      throw new Error(`GitHub API error: ${getRes.status} ${await getRes.text()}`);
    }

    // 3. Get existing assets
    const assetsRes = await fetch(release.assets_url, { headers });
    const existingAssets = assetsRes.ok ? await assetsRes.json() : [];

    console.log(`\n🚀 Publishing to GitHub Release ("${RELEASE_TAG}")...`);

    for (const item of toUpload) {
      // Overwrite if exists
      const existing = existingAssets.find(a => a.name === item.targetName);
      if (existing) {
        process.stdout.write(`   🗑️ Replacing old ${item.targetName}... `);
        await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`, {
          method: 'DELETE',
          headers
        });
        console.log('done.');
      }

      // Stream upload large asset
      process.stdout.write(`   ⬆️ Uploading ${item.targetName} (${item.sizeMB} MB)... `);
      const uploadUrl = release.upload_url.replace('{?name,label}', `?name=${encodeURIComponent(item.targetName)}`);
      
      try {
        await streamUpload(uploadUrl, item.filePath, item.targetName, token);
        console.log('✅ Success!');
      } catch (uploadErr) {
        console.log(`❌ Failed: ${uploadErr.message}`);
      }
    }

    console.log(`\n🎉 Release published successfully!`);
    console.log(`🔗 Release URL: ${release.html_url}`);
  } catch (err) {
    console.error(`\n💥 Release error: ${err.message}`);
  }
}

uploadRelease();
