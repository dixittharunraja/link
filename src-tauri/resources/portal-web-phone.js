// The script of the Web Portal page when the PHONE serves it (LinkWebShare.java). The look is the desktop page's
// (portal-web.html: same markup, same CSS) and so is the flow (Connect, PIN, accepted, two-way files); only this script
// differs, because the phone speaks plain HTTP (/join, /status, /files, /f/<id>, /up) where the desktop speaks a WebSocket.
// The Java page is generated from both files: `npm run gen:phone-portal`.
const secConnect = document.getElementById('sec-connect');
const secPin = document.getElementById('sec-pin');
const secUpload = document.getElementById('sec-upload');
const btnConnect = document.getElementById('btn-connect');
const pinDisplay = document.getElementById('pin-display');
const pinStatus = document.getElementById('pin-status');
const subtitle = document.getElementById('subtitle');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const fileListContainer = document.getElementById('file-list');
const uploadStatus = document.getElementById('upload-status');
const downloadsContainer = document.getElementById('downloads-container');
const downloadList = document.getElementById('download-list');

let token = '';
let pollTimer = null;
let refreshTimer = null;
let sentCount = 0;

function show(section) {
  [secConnect, secPin, secUpload].forEach((s) => s.classList.remove('active'));
  section.classList.add('active');
}

function formatBytes(bytes) {
  if (bytes < 0) return '';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function updateDownloadsList(files) {
  if (!files || files.length === 0) {
    downloadsContainer.style.display = 'none';
    downloadList.innerHTML = '';
    return;
  }
  downloadsContainer.style.display = 'flex';
  downloadList.innerHTML = '';
  files.forEach((file) => {
    const item = document.createElement('div');
    item.className = 'download-item';
    const name = document.createElement('div');
    name.className = 'download-name';
    name.title = file.name;
    name.textContent = file.name + ' ';
    const size = document.createElement('span');
    size.className = 'download-size';
    size.textContent = file.size >= 0 ? '(' + formatBytes(file.size) + ')' : '';
    name.appendChild(size);
    const link = document.createElement('a');
    link.href = '/f/' + encodeURIComponent(file.id) + '?token=' + encodeURIComponent(token);
    link.download = file.name;
    link.style.textDecoration = 'none';
    const button = document.createElement('button');
    button.className = 'download-btn';
    button.textContent = 'Download';
    link.appendChild(button);
    item.appendChild(name);
    item.appendChild(link);
    downloadList.appendChild(item);
  });
}

// Admitted: the two-way view. The list of files the phone offers is refreshed as files are staged in the app.
function enter(newToken, files) {
  token = newToken;
  show(secUpload);
  subtitle.textContent = 'Two-way files sharing active.';
  updateDownloadsList(files);
  refreshTimer = setInterval(async () => {
    try {
      const r = await fetch('/files?token=' + encodeURIComponent(token));
      if (r.ok) updateDownloadsList(await r.json());
    } catch (e) {}
  }, 3000);
}

function reset(message) {
  clearInterval(pollTimer);
  clearInterval(refreshTimer);
  token = '';
  btnConnect.disabled = false;
  btnConnect.textContent = 'Connect';
  show(secConnect);
  subtitle.textContent = message || 'Connect to peer to send files directly over the local network.';
}

// Closing the page tells the phone right away, so its screen goes back to the QR code instead of waiting.
window.addEventListener('pagehide', () => {
  if (token) navigator.sendBeacon('/leave?token=' + encodeURIComponent(token));
});

// ---- Ask to join, compare the PIN with the phone's screen, wait for the owner to accept ----
btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true;
  btnConnect.textContent = 'Connecting...';
  try {
    const r = await fetch('/join', { method: 'POST' });
    if (!r.ok) {
      reset('The phone is busy. Try again in a moment.');
      return;
    }
    const joined = await r.json();
    show(secPin);
    pinDisplay.textContent = joined.pin;
    pinStatus.textContent = 'Waiting for host to accept connection...';
    subtitle.textContent = 'Authenticating connection...';
    pollTimer = setInterval(async () => {
      try {
        const s = await (await fetch('/status?c=' + encodeURIComponent(joined.conn))).json();
        if (s.state === 'admitted') {
          clearInterval(pollTimer);
          enter(s.token, s.files);
        } else if (s.state === 'rejected') {
          reset('The phone did not accept this connection.');
        }
      } catch (e) {
        reset('Lost contact with the phone.');
      }
    }, 1000);
  } catch (e) {
    reset('Could not reach the phone.');
  }
});

// ---- Sending files to the phone ----
dropzone.addEventListener('click', () => fileInput.click());
['dragenter', 'dragover'].forEach((name) => {
  dropzone.addEventListener(name, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((name) => {
  dropzone.addEventListener(name, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer.files);
  if (files.length > 0) files.forEach(sendFile);
});
fileInput.addEventListener('change', () => {
  Array.from(fileInput.files).forEach(sendFile);
  fileInput.value = '';
});

function sendFile(file) {
  const item = document.createElement('div');
  item.className = 'file-item';
  const top = document.createElement('div');
  top.className = 'file-name';
  top.title = file.name;
  top.textContent = file.name;
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  bar.appendChild(fill);
  const info = document.createElement('div');
  info.className = 'file-info';
  const text = document.createElement('span');
  text.textContent = 'Sending...';
  const size = document.createElement('span');
  size.textContent = formatBytes(file.size);
  info.appendChild(text);
  info.appendChild(size);
  item.appendChild(top);
  item.appendChild(bar);
  item.appendChild(info);
  fileListContainer.appendChild(item);
  uploadStatus.textContent = 'Sending ' + file.name + ' to the phone...';

  const x = new XMLHttpRequest();
  x.open('POST', '/up?token=' + encodeURIComponent(token) + '&name=' + encodeURIComponent(file.name));
  x.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
    fill.style.width = pct + '%';
    text.textContent = pct + '% (' + formatBytes(e.loaded) + ')';
  };
  x.onload = () => {
    if (x.status === 200) {
      fill.style.width = '100%';
      text.textContent = 'Transferred ✓';
      sentCount++;
      uploadStatus.innerHTML = '<span class="status-success">✓ Sent ' + sentCount + ' file(s) successfully!</span>';
    } else {
      text.textContent = 'Failed (' + x.status + ')';
    }
  };
  x.onerror = () => {
    text.textContent = 'Failed';
  };
  x.send(file);
}
