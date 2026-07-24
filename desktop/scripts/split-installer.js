const fs = require('fs');
const path = require('path');

async function splitInstaller() {
    console.log("✂️ Starting Installer Splitting...");

    const distDir = path.join(__dirname, '../dist_electron');
    const rodixDir = path.resolve(__dirname, '../../../rodix');
    const outDir = path.join(rodixDir, 'public/installers');

    if (!fs.existsSync(rodixDir)) {
        console.warn("⚠️  Skipping installer copy/split: 'rodix' sibling directory not found.");
        return;
    }

    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    // 1. Find the .exe installer
    const files = fs.readdirSync(distDir);
    const installerFile = files.find(f => f.endsWith('.exe') && !f.includes('blockmap'));

    if (!installerFile) {
        console.error("❌ No .exe installer found in dist_electron/");
        return;
    }

    const installerPath = path.join(distDir, installerFile);
    const stats = fs.statSync(installerPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    console.log(`📦 Found installer: ${installerFile} (${fileSizeMB.toFixed(2)} MB)`);

    // Target chunk size: 24MB (to stay safely under Cloudflare's 25MB limit)
    const CHUNK_SIZE = 24 * 1024 * 1024; 
    const buffer = fs.readFileSync(installerPath);
    const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);

    console.log(`🧩 Splitting into ${totalChunks} chunks...`);

    const baseName = "link-desktop-setup.exe";

    // Clean old chunks
    fs.readdirSync(outDir).forEach(f => {
        if (f.startsWith(baseName)) {
            fs.rmSync(path.join(outDir, f), { force: true });
        }
    });

    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, buffer.length);
        const chunk = buffer.slice(start, end);
        const chunkPath = path.join(outDir, `${baseName}.part${i}`);
        
        fs.writeFileSync(chunkPath, chunk);
        console.log(`   ✅ Saved ${baseName}.part${i} (${(chunk.length / (1024 * 1024)).toFixed(2)} MB)`);
    }

    // Also copy the full file if it's small enough (optional, but good for reference)
    if (fileSizeMB < 25) {
        fs.copyFileSync(installerPath, path.join(outDir, baseName));
        console.log(`   ✅ Copied full installer (under 25MB limit)`);
    }

    // Update the download page segments count in rodix site
    const downloadPagePath = path.resolve(__dirname, '../../../rodix/src/app/download/page.tsx');
    if (fs.existsSync(downloadPagePath)) {
        let content = fs.readFileSync(downloadPagePath, 'utf8');
        const updatedContent = content.replace(/segments: \d+/, `segments: ${totalChunks}`);
        if (content !== updatedContent) {
            fs.writeFileSync(downloadPagePath, updatedContent);
            console.log(`📝 Updated segments count to ${totalChunks} in download page.`);
        }
    }

    console.log("🏁 Splitting Complete!");
}

splitInstaller().catch(err => console.error("💥 Error splitting installer:", err));
