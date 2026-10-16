'use strict';

const express = require('express');
const multer = require('multer');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SHARE = path.join(__dirname, 'shared');

fs.mkdirSync(SHARE, { recursive: true });
app.use(express.json({ limit: '50mb' }));

const devices = {};
const fileStore = [];
const textStore = [];
const histLog = [];
const pending = {};

const uid = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();

function safeFileName(name) {
  const base = path.basename(String(name || 'file'))
    .replace(/[\\/]/g, '_')
    .replace(/[^a-zA-Z0-9_.-]/g, '_');
  return (base || 'file').replace(/^_+|_+$/g, '') || 'file';
}

const stor = multer.diskStorage({
  destination: SHARE,
  filename: (req, file, cb) => cb(null, `${uid()}_${safeFileName(file.originalname)}`)
});

const upload = multer({
  storage: stor,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, true)
});

function getIP() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function liveDevices() {
  const cut = now() - 15000;
  return Object.entries(devices)
    .filter(([, d]) => d.lastSeen > cut)
    .map(([id, d]) => ({ id, name: d.name || 'Unknown' }));
}

function diskUsed() {
  try {
    return fs.readdirSync(SHARE).reduce((sum, name) => {
      try {
        const full = path.join(SHARE, name);
        const stat = fs.statSync(full);
        return stat.isFile() ? sum + stat.size : sum;
      } catch {
        return sum;
      }
    }, 0);
  } catch {
    return 0;
  }
}

function log(type, desc, who) {
  histLog.unshift({ id: uid(), type, desc, who: who || 'Unknown', ts: now() });
  if (histLog.length > 100) histLog.length = 100;
}

function isFileVisibleTo(file, deviceId) {
  return file.targetDevice === 'everyone' ||
    file.uploadedBy === deviceId ||
    (file.targetDevice === deviceId && file.accepted);
}

function isTextVisibleTo(text, deviceId) {
  return text.targetDevice === 'everyone' ||
    text.sentBy === deviceId ||
    text.targetDevice === deviceId;
}

function cleanupPending(deviceId) {
  if (pending[deviceId] && pending[deviceId].length === 0) delete pending[deviceId];
}

function pruneExpiredFiles() {
  const cut = now() - 3_600_000;
  for (let i = fileStore.length - 1; i >= 0; i--) {
    if (fileStore[i].uploadedAt < cut) {
      try {
        fs.unlinkSync(path.join(SHARE, fileStore[i].storedName));
      } catch {}
      fileStore.splice(i, 1);
    }
  }
}

function pruneStaleDevices() {
  const cut = now() - 60_000;
  for (const id of Object.keys(devices)) {
    if (devices[id].lastSeen < cut) delete devices[id];
  }
}

setInterval(pruneExpiredFiles, 60_000);
setInterval(pruneStaleDevices, 15_000);

app.post('/api/heartbeat', (req, res) => {
  const { deviceId, deviceName } = req.body || {};
  if (!deviceId) return res.json({ ok: false });

  devices[deviceId] = {
    name: String(deviceName || 'Unknown').trim() || 'Unknown',
    lastSeen: now()
  };

  res.json({
    ok: true,
    devices: liveDevices(),
    pending: pending[deviceId] || [],
    storage: { used: diskUsed(), limit: 2 * 1024 * 1024 * 1024 }
  });
});

app.get('/api/files', (req, res) => {
  const { deviceId } = req.query || {};
  const id = String(deviceId || '');
  res.json(fileStore.filter((f) => isFileVisibleTo(f, id)));
});

app.post('/api/upload', upload.array('files'), (req, res) => {
  const { deviceId, deviceName, targetDevice } = req.body || {};

  if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files' });

  const target = String(targetDevice || 'everyone');
  const uploaderName = String(deviceName || 'Unknown').trim() || 'Unknown';

  const newFiles = req.files.map((file) => ({
    id: uid(),
    originalName: file.originalname,
    storedName: file.filename,
    size: file.size,
    mimeType: file.mimetype || 'application/octet-stream',
    uploadedBy: deviceId,
    uploadedByName: uploaderName,
    targetDevice: target,
    accepted: target === 'everyone',
    uploadedAt: now()
  }));

  fileStore.push(...newFiles);

  if (target && target !== 'everyone') {
    if (!pending[target]) pending[target] = [];
    pending[target].push({
      transferId: uid(),
      files: newFiles.map((f) => ({ id: f.id, name: f.originalName, size: f.size })),
      fromId: deviceId,
      fromName: uploaderName
    });
  }

  log('upload', `${newFiles.length} file(s) sent`, uploaderName);
  res.json({ ok: true, files: newFiles });
});

app.get('/api/download/:id', (req, res) => {
  const file = fileStore.find((item) => item.id === req.params.id);
  if (!file) return res.status(404).end();

  const { deviceId } = req.query || {};
  const requester = String(deviceId || '');
  if (!isFileVisibleTo(file, requester)) return res.status(403).end();

  const fp = path.join(SHARE, file.storedName);
  if (!fs.existsSync(fp)) return res.status(404).end();

  res.download(fp, file.originalName);
});

app.delete('/api/files/:id', (req, res) => {
  const { deviceId } = req.query || {};
  const requester = String(deviceId || '');
  const index = fileStore.findIndex((f) => f.id === req.params.id);
  if (index === -1) return res.status(404).end();

  const file = fileStore[index];
  if (!isFileVisibleTo(file, requester)) return res.status(403).end();

  try {
    fs.unlinkSync(path.join(SHARE, file.storedName));
  } catch {}

  fileStore.splice(index, 1);
  res.json({ ok: true });
});

app.patch('/api/files/:id', (req, res) => {
  const file = fileStore.find((item) => item.id === req.params.id);
  if (!file) return res.status(404).end();

  const { deviceId } = req.body || {};
  if (!deviceId || !isFileVisibleTo(file, deviceId)) return res.status(403).end();

  if (typeof req.body.name === 'string') {
    const next = req.body.name.trim();
    if (next) file.originalName = next;
  }

  res.json({ ok: true });
});

app.post('/api/accept/:tid', (req, res) => {
  const { deviceId } = req.body || {};
  const list = pending[deviceId] || [];
  const index = list.findIndex((t) => t.transferId === req.params.tid);
  if (index === -1) return res.status(404).end();

  const [transfer] = list.splice(index, 1);
  cleanupPending(deviceId);

  for (const tf of transfer.files) {
    const file = fileStore.find((item) => item.id === tf.id);
    if (file) file.accepted = true;
  }

  log('accept', `Accepted from ${transfer.fromName}`, devices[deviceId]?.name || 'Unknown');
  res.json({ ok: true, fileIds: transfer.files.map((f) => f.id) });
});

app.post('/api/decline/:tid', (req, res) => {
  const { deviceId } = req.body || {};
  const list = pending[deviceId] || [];
  const index = list.findIndex((t) => t.transferId === req.params.tid);
  if (index === -1) return res.status(404).end();

  const [transfer] = list.splice(index, 1);
  cleanupPending(deviceId);

  for (const tf of transfer.files) {
    const fileIndex = fileStore.findIndex((item) => item.id === tf.id);
    if (fileIndex !== -1) {
      try {
        fs.unlinkSync(path.join(SHARE, fileStore[fileIndex].storedName));
      } catch {}
      fileStore.splice(fileIndex, 1);
    }
  }

  log('decline', `Declined from ${transfer.fromName}`, devices[deviceId]?.name || 'Unknown');
  res.json({ ok: true });
});

app.get('/api/texts', (req, res) => {
  const { deviceId } = req.query || {};
  const id = String(deviceId || '');
  res.json(textStore.filter((t) => isTextVisibleTo(t, id)));
});

app.post('/api/texts', (req, res) => {
  const { deviceId, deviceName, content, targetDevice } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'Empty' });

  const entry = {
    id: uid(),
    content: String(content).trim(),
    sentBy: deviceId,
    sentByName: String(deviceName || 'Unknown').trim() || 'Unknown',
    targetDevice: String(targetDevice || 'everyone'),
    sentAt: now()
  };

  textStore.unshift(entry);
  if (textStore.length > 50) textStore.length = 50;
  log('text', 'Text shared', entry.sentByName);
  res.json({ ok: true, text: entry });
});

app.delete('/api/texts/:id', (req, res) => {
  const { deviceId } = req.query || {};
  const requester = String(deviceId || '');
  const index = textStore.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).end();

  const text = textStore[index];
  if (!isTextVisibleTo(text, requester)) return res.status(403).end();
  textStore.splice(index, 1);
  res.json({ ok: true });
});

app.get('/api/history', (req, res) => res.json(histLog));

const LOCAL_IP = getIP();
const BASE_URL = `http://${LOCAL_IP}:${PORT}`;
let _html = null;

async function buildHTML() {
  const qrDataURL = await qrcode.toDataURL(BASE_URL, {
    type: 'image/png',
    width: 180,
    margin: 1,
    color: { dark: '#7c3aed', light: '#ffffff' }
  });

  return `<!DOCTYPE html>
<html data-theme="dark" lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <title>Orbit</title>
  <style>
    :root {
      --bg:#080812; --surface:#0f0f1c; --card:#161626; --card2:#1c1c30; --border:rgba(124,58,237,.18);
      --accent:#7c3aed; --accent2:#06b6d4; --green:#10b981; --red:#ef4444; --yellow:#f59e0b; --text:#e2e8f0; --muted:#64748b;
    }
    html[data-theme="light"] {
      --bg:#f1f5f9; --surface:#ffffff; --card:#f8fafc; --card2:#e2e8f0; --border:rgba(124,58,237,.2);
      --text:#1e293b; --muted:#94a3b8;
    }
    * { box-sizing:border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
    button, input, textarea, select { font:inherit; }
    button { cursor:pointer; }
    .hidden { display:none !important; }
    header { display:flex; align-items:center; gap:12px; height:56px; padding:0 20px; border-bottom:1px solid var(--border); background:rgba(8,8,18,.9); position:sticky; top:0; z-index:10; }
    .brand { display:flex; align-items:center; gap:8px; font-weight:700; }
    .brand .icon { font-size:20px; }
    .brand .name { color:var(--accent); }
    .header-name { margin-left:4px; color:var(--muted); font-size:13px; }
    .header-right { margin-left:auto; display:flex; align-items:center; gap:8px; }
    .icon-btn { width:36px; height:36px; border:1px solid var(--border); border-radius:10px; background:var(--card); color:var(--text); }
    .layout { display:flex; height:calc(100vh - 56px); }
    .sidebar { width:280px; border-right:1px solid var(--border); background:var(--surface); overflow-y:auto; }
    .sidebar .panel { padding:20px; border-bottom:1px solid var(--border); }
    .panel-label { color:var(--accent); font-size:10px; letter-spacing:2px; text-transform:uppercase; font-weight:700; margin-bottom:14px; }
    .qr-wrap { display:flex; flex-direction:column; align-items:center; gap:12px; }
    .qr-img { width:168px; height:168px; border-radius:12px; border:3px solid var(--accent); padding:4px; background:#fff; }
    .qr-url { font-family:SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace; font-size:11px; color:var(--accent2); background:rgba(6,182,212,.1); padding:6px 10px; border-radius:999px; word-break:break-all; text-align:center; }
    .storage-wrap { width:100%; }
    .storage-head { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:6px; }
    .storage-bar { height:5px; background:var(--card2); border-radius:999px; overflow:hidden; }
    .storage-fill { height:100%; width:0; background:linear-gradient(90deg,var(--accent),var(--accent2)); border-radius:999px; }
    .device-item { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:10px; margin-top:6px; }
    .device-item:hover { background:var(--card); }
    .device-dot { width:8px; height:8px; border-radius:50%; background:var(--green); flex-shrink:0; box-shadow:0 0 6px var(--green); }
    .device-name { font-size:13px; font-weight:500; }
    .you-tag { margin-left:auto; font-size:10px; background:rgba(124,58,237,.15); color:var(--accent); padding:2px 6px; border-radius:999px; }
    .main { flex:1; display:flex; flex-direction:column; overflow:hidden; }
    .tabs { display:flex; gap:2px; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--surface); flex-shrink:0; }
    .tab-btn { padding:8px 16px; border-radius:10px; background:transparent; color:var(--muted); border:0; }
    .tab-btn.active { background:rgba(124,58,237,.15); color:var(--accent); }
    .tab-pane { display:none; flex:1; overflow-y:auto; padding:16px; flex-direction:column; gap:14px; }
    .tab-pane.active { display:flex; }
    .upload-zone { border:2px dashed var(--border); border-radius:16px; padding:28px 20px; text-align:center; cursor:pointer; background:rgba(124,58,237,.02); transition:.25s; }
    .upload-zone.drag { border-color:var(--accent); background:rgba(124,58,237,.06); }
    .upload-zone .icon { font-size:32px; margin-bottom:8px; }
    .upload-zone h3 { margin:0; font-size:14px; }
    .upload-zone p { margin:6px 0 0; font-size:12px; color:var(--muted); }
    .upload-controls { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
    .send-to-wrap { display:flex; align-items:center; gap:8px; }
    .send-to-wrap label { font-size:12px; color:var(--muted); }
    select { background:var(--card); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:6px 10px; }
    .btn-primary, .btn-upload, .btn-sm { border:1px solid var(--border); border-radius:10px; padding:8px 16px; background:var(--card); color:var(--text); }
    .btn-primary, .btn-upload { background:linear-gradient(135deg,var(--accent),#5b21b6); color:#fff; border:0; }
    .btn-danger { background:rgba(239,68,68,.12); color:var(--red); border:1px solid rgba(239,68,68,.2); }
    .btn-success { background:rgba(16,185,129,.12); color:var(--green); border:1px solid rgba(16,185,129,.2); }
    .progress-wrap { display:none; }
    .progress-wrap.show { display:block; }
    .progress-bar { height:6px; background:var(--card2); border-radius:999px; overflow:hidden; }
    .progress-fill { height:100%; width:0; background:linear-gradient(90deg,var(--accent),var(--accent2)); border-radius:999px; }
    .progress-label { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin-top:6px; }
    .file-list, .text-list, .hist-list { display:flex; flex-direction:column; gap:8px; }
    .file-item, .text-item, .hist-item { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px 14px; }
    .file-item { display:flex; align-items:center; gap:12px; }
    .file-icon { width:40px; height:40px; border-radius:10px; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg,rgba(124,58,237,.16),rgba(6,182,212,.16)); }
    .file-info { flex:1; min-width:0; }
    .file-name { font-size:14px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .file-meta { font-size:11px; color:var(--muted); margin-top:2px; }
    .file-actions { display:flex; gap:6px; }
    .rename-input { background:var(--surface); border:1px solid var(--accent); border-radius:6px; padding:2px 8px; color:var(--text); width:150px; }
    .empty-state { text-align:center; padding:48px 24px; color:var(--muted); }
    .empty-state .emoji { font-size:40px; margin-bottom:12px; }
    .gallery-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; }
    .gallery-thumb { aspect-ratio:1; border-radius:10px; overflow:hidden; border:2px solid var(--border); background:var(--card); }
    .gallery-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
    .text-compose { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:14px; display:flex; flex-direction:column; gap:10px; }
    .text-compose textarea { width:100%; min-height:100px; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:10px; padding:10px 12px; resize:vertical; }
    .text-compose-footer { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
    .text-header { display:flex; justify-content:space-between; margin-bottom:6px; }
    .text-from { font-weight:700; color:var(--accent); }
    .text-time { font-size:11px; color:var(--muted); }
    .text-content { white-space:pre-wrap; word-break:break-word; margin:8px 0; }
    .text-footer { display:flex; gap:6px; }
    .hist-item { display:flex; align-items:center; gap:12px; }
    .hist-icon { width:32px; text-align:center; font-size:18px; }
    .hist-info { flex:1; }
    .hist-desc { font-weight:500; }
    .hist-who { font-size:11px; color:var(--muted); margin-top:2px; }
    .hist-ts { font-size:11px; color:var(--muted); flex-shrink:0; }
    #acceptModal { position:fixed; inset:0; background:rgba(0,0,0,.75); display:none; align-items:center; justify-content:center; z-index:30; }
    #acceptModal.open { display:flex; }
    .accept-box { background:var(--card); border:1px solid var(--border); border-radius:20px; padding:28px; width:min(420px,92vw); }
    .accept-box h2 { margin:0 0 4px; }
    .accept-from { margin-bottom:18px; color:var(--muted); font-size:13px; }
    .accept-files { list-style:none; padding:0; margin:0 0 20px; display:flex; flex-direction:column; gap:6px; }
    .accept-files li { display:flex; justify-content:space-between; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:8px 12px; font-size:13px; }
    .accept-actions { display:flex; gap:10px; }
    .accept-actions .btn-primary, .accept-actions .btn-danger { flex:1; }
    #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(20px); opacity:0; transition:all .3s; background:var(--card2); border:1px solid var(--border); border-radius:999px; padding:10px 20px; white-space:nowrap; z-index:40; }
    #toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
    #toast.ok { border-color:rgba(16,185,129,.4); color:var(--green); }
    #toast.err { border-color:rgba(239,68,68,.4); color:var(--red); }
    #lightbox { position:fixed; inset:0; background:rgba(0,0,0,.92); display:none; align-items:center; justify-content:center; z-index:50; }
    #lightbox.open { display:flex; }
    #lightbox img { max-width:95vw; max-height:90vh; object-fit:contain; border-radius:8px; }
    .lb-close { position:absolute; top:16px; right:16px; width:36px; height:36px; border-radius:50%; background:rgba(255,255,255,.12); color:#fff; border:0; }
    .lb-nav { position:absolute; top:50%; transform:translateY(-50%); width:44px; height:44px; border-radius:50%; background:rgba(255,255,255,.12); color:#fff; border:0; font-size:20px; }
    #lb-prev { left:16px; }
    #lb-next { right:16px; }
    @media (max-width: 700px) {
      .sidebar { display:none; position:fixed; inset:56px 0 0 0; width:100%; z-index:12; }
      .sidebar.open { display:block; }
      .layout { height:calc(100vh - 56px); }
    }
  </style>
</head>
<body>
  <div id="nameModal">
    <div style="background:var(--card); border:1px solid var(--border); border-radius:20px; padding:32px 28px; width:min(360px,90vw); text-align:center;">
      <div style="font-size:40px; margin-bottom:12px;">🪐</div>
      <h2 style="margin:0 0 8px;">Welcome to Orbit</h2>
      <p style="margin:0 0 24px; color:var(--muted);">What should other devices call you?</p>
      <input id="nameInput" placeholder="My iPhone / My Laptop" maxlength="30" autocomplete="off" style="width:100%; padding:12px 16px; border:1px solid var(--border); border-radius:12px; background:var(--surface); color:var(--text); margin-bottom:16px;" />
      <button class="btn-primary" data-action="set-name" style="width:100%;">Join Orbit</button>
    </div>
  </div>

  <header>
    <div class="brand"><span class="icon">🪐</span><span class="name">Orbit</span></div>
    <div class="header-name" id="headerName"></div>
    <div class="header-right">
      <button class="icon-btn" data-action="toggle-qr" id="qrToggle" title="QR / Devices">📡</button>
      <button class="icon-btn" data-action="toggle-theme" id="themeBtn">☀️</button>
    </div>
  </header>

  <div class="layout">
    <aside id="sidebar" class="sidebar">
      <div class="panel">
        <div class="panel-label">📱 Connect</div>
        <div class="qr-wrap">
          <img class="qr-img" src="${qrDataURL}" alt="QR code" />
          <div class="qr-url">${BASE_URL}</div>
          <div class="storage-wrap">
            <div class="storage-head"><span id="storUsed">0 MB used</span><span id="storLimit">2 GB</span></div>
            <div class="storage-bar"><div class="storage-fill" id="storFill"></div></div>
          </div>
        </div>
      </div>
      <div class="panel" style="flex:1;">
        <div class="panel-label">📶 Online</div>
        <div id="deviceList"></div>
      </div>
    </aside>

    <main class="main">
      <div class="tabs">
        <button class="tab-btn active" data-action="switch-tab" data-tab="files">📁 Files</button>
        <button class="tab-btn" data-action="switch-tab" data-tab="gallery">🖼 Gallery</button>
        <button class="tab-btn" data-action="switch-tab" data-tab="clipboard">📋 Clipboard</button>
        <button class="tab-btn" data-action="switch-tab" data-tab="history">📜 History</button>
      </div>

      <div id="pane-files" class="tab-pane active">
        <div id="dropZone" class="upload-zone">
          <div class="icon">📂</div>
          <h3>Drop files here</h3>
          <p>or tap to choose files</p>
        </div>
        <input id="fileInput" type="file" multiple class="hidden" />
        <div class="upload-controls">
          <div class="send-to-wrap">
            <label>To:</label>
            <select id="sendTo"><option value="everyone">Everyone</option></select>
          </div>
          <button class="btn-upload" data-action="trigger-upload">Choose & Send</button>
          <button class="btn-danger" id="cancelUploadBtn" data-action="cancel-upload" style="display:none;">✕ Cancel</button>
        </div>
        <div id="progressWrap" class="progress-wrap">
          <div class="progress-bar"><div id="progressBar" class="progress-fill"></div></div>
          <div class="progress-label"><span id="progressText">Uploading…</span><span id="progressPct">0%</span></div>
        </div>
        <div id="fileList" class="file-list"></div>
      </div>

      <div id="pane-gallery" class="tab-pane">
        <div id="galleryGrid" class="gallery-grid"></div>
      </div>

      <div id="pane-clipboard" class="tab-pane">
        <div class="text-compose">
          <div class="panel-label" style="margin:0;">✏️ Send Text</div>
          <textarea id="textInput" placeholder="Type something to share…"></textarea>
          <div class="text-compose-footer">
            <div class="send-to-wrap">
              <label>To:</label>
              <select id="textSendTo"><option value="everyone">Everyone</option></select>
            </div>
            <button class="btn-upload" data-action="send-text">Send →</button>
          </div>
        </div>
        <div id="textList" class="text-list"></div>
      </div>

      <div id="pane-history" class="tab-pane">
        <div id="histList" class="hist-list"></div>
      </div>
    </main>
  </div>

  <div id="acceptModal">
    <div class="accept-box">
      <h2>📨 Incoming Files</h2>
      <div id="acceptFrom" class="accept-from"></div>
      <ul id="acceptFiles" class="accept-files"></ul>
      <div class="accept-actions">
        <button id="acceptBtn" class="btn-primary">✓ Accept</button>
        <button id="declineBtn" class="btn-danger">✕ Decline</button>
      </div>
    </div>
  </div>

  <div id="lightbox">
    <button id="lb-close" class="lb-close">✕</button>
    <button id="lb-prev" class="lb-nav">‹</button>
    <img id="lb-img" src="" alt="" />
    <button id="lb-next" class="lb-nav">›</button>
  </div>

  <div id="toast"></div>

  <script>
    function genId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
    function esc(v) {
      return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
    }
    function fmtSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(2) + ' GB';
    }
    function fmtTime(ts) {
      const diff = Date.now() - ts;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return Math.floor(diff / 86400000) + 'd ago';
    }
    function fileIcon(mime, name) {
      if (mime && mime.startsWith('image/')) return '🖼';
      if (mime && mime.startsWith('video/')) return '🎬';
      if (mime && mime.startsWith('audio/')) return '🎵';
      if (mime && mime.includes('pdf')) return '📄';
      if ((mime && mime.includes('zip')) || /\.(zip|rar|7z)$/i.test(name)) return '📦';
      if ((mime && mime.includes('word')) || /\.(docx|doc)$/i.test(name)) return '📝';
      if ((mime && mime.includes('sheet')) || /\.(xlsx|csv)$/i.test(name)) return '📊';
      return '📁';
    }
    function histIcon(type) {
      return { upload: '⬆', accept: '✅', decline: '❌', text: '💬' }[type] || '•';
    }

    async function api(method, url, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const r = await fetch(url, opts);
      return r.json().catch(() => ({}));
    }

    function toast(msg, type = 'ok') {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'show ' + type;
      clearTimeout(toast._t);
      toast._t = setTimeout(() => el.className = '', 2500);
    }

    const DID = localStorage.getItem('orbit_did') || genId();
    localStorage.setItem('orbit_did', DID);
    let NAME = localStorage.getItem('orbit_name') || '';
    let currentTab = 'files';
    let allFiles = [];
    let allTexts = [];
    let uploadXHR = null;
    let galleryImages = [];
    let lbIndex = 0;
    let pendingQueue = [];
    let processingModal = false;
    const _textStore = {};

    function initTheme() {
      const theme = localStorage.getItem('orbit_theme') || 'dark';
      document.documentElement.dataset.theme = theme;
      document.getElementById('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
    }
    initTheme();

    function initName() {
      if (NAME) return startApp();
      const ua = navigator.userAgent;
      const guess = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'My Device';
      document.getElementById('nameInput').value = guess;
      document.getElementById('nameInput').focus();
      document.getElementById('nameInput').select();
    }

    function startApp() {
      document.getElementById('nameModal').style.display = 'none';
      document.getElementById('headerName').textContent = NAME;
      startPolling();
      dropZoneInit();
      loadFiles();
      loadTexts();
      loadHistory();
    }

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
      document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.toggle('active', pane.id === 'pane-' + tab));
      if (tab === 'gallery') renderGallery();
      if (tab === 'history') loadHistory();
    }

    function startPolling() {
      beat();
      setInterval(beat, 2500);
    }

    async function beat() {
      try {
        const data = await api('POST', '/api/heartbeat', { deviceId: DID, deviceName: NAME });
        if (!data.ok) return;
        renderDevices(data.devices);
        updateStorage(data.storage);
        if (data.pending && data.pending.length > 0) {
          for (const tr of data.pending) {
            if (!pendingQueue.find((p) => p.transferId === tr.transferId)) pendingQueue.push(tr);
          }
          if (!processingModal) showNextModal();
        }
        loadFiles();
      } catch {}
    }

    function updateStorage(s) {
      if (!s) return;
      document.getElementById('storUsed').textContent = fmtSize(s.used) + ' used';
      document.getElementById('storLimit').textContent = fmtSize(s.limit);
      const pct = Math.min(100, (s.used / s.limit) * 100 || 0);
      document.getElementById('storFill').style.width = pct + '%';
    }

    function renderDevices(devs) {
      const el = document.getElementById('deviceList');
      if (!devs || !devs.length) {
        el.innerHTML = '<div style="padding:8px 0; color:var(--muted); font-size:13px;">No devices online</div>';
        return;
      }
      updateSendTo(devs);
      el.innerHTML = devs.map((d) => {
        const me = d.id === DID;
        return '<div class="device-item">'
          + '<div class="device-dot"></div>'
          + '<div class="device-name">' + esc(d.name) + '</div>'
          + (me ? '<div class="you-tag">You</div>' : '')
          + '</div>';
      }).join('');
    }

    function updateSendTo(devs) {
      ['sendTo', 'textSendTo'].forEach((selId) => {
        const sel = document.getElementById(selId);
        if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = '<option value="everyone">Everyone</option>' + devs.filter((d) => d.id !== DID).map((d) => '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>').join('');
        if (cur) sel.value = cur;
      });
    }

    function dropZoneInit() {
      const dz = document.getElementById('dropZone');
      const fileInput = document.getElementById('fileInput');
      dz.addEventListener('click', () => fileInput.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
      dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); doUpload(e.dataTransfer.files); });
      fileInput.addEventListener('change', (e) => doUpload(e.target.files));
    }

    function doUpload(files) {
      if (!files || !files.length) return;
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      fd.append('deviceId', DID);
      fd.append('deviceName', NAME);
      fd.append('targetDevice', document.getElementById('sendTo').value);

      const xhr = new XMLHttpRequest();
      uploadXHR = xhr;
      document.getElementById('cancelUploadBtn').style.display = 'inline-block';
      showProgress();

      xhr.upload.addEventListener('progress', (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        document.getElementById('progressBar').style.width = pct + '%';
        document.getElementById('progressPct').textContent = pct + '%';
        document.getElementById('progressText').textContent = 'Uploading ' + files.length + ' file(s)…';
      });

      xhr.addEventListener('load', () => {
        uploadXHR = null;
        document.getElementById('cancelUploadBtn').style.display = 'none';
        hideProgress();
        document.getElementById('fileInput').value = '';
        toast('Uploaded ' + files.length + ' file(s)!');
        loadFiles();
      });

      xhr.addEventListener('error', () => { hideProgress(); toast('Upload failed', 'err'); });
      xhr.addEventListener('abort', () => { hideProgress(); toast('Cancelled'); });

      xhr.open('POST', '/api/upload');
      xhr.send(fd);
    }

    function showProgress() {
      document.getElementById('progressWrap').classList.add('show');
      document.getElementById('progressBar').style.width = '0%';
    }

    function hideProgress() {
      document.getElementById('progressWrap').classList.remove('show');
    }

    async function loadFiles() {
      try {
        allFiles = await fetch('/api/files?deviceId=' + encodeURIComponent(DID)).then((r) => r.json());
        renderFiles();
        if (currentTab === 'gallery') renderGallery();
      } catch {}
    }

    function renderFiles() {
      const el = document.getElementById('fileList');
      if (!allFiles.length) {
        el.innerHTML = '<div class="empty-state"><div class="emoji">📭</div><p>No files yet. Upload something!</p></div>';
        return;
      }

      el.innerHTML = allFiles.map((f) => {
        const id = esc(f.id);
        return '<div class="file-item">'
          + '<div class="file-icon">' + fileIcon(f.mimeType, f.originalName) + '</div>'
          + '<div class="file-info">'
          + '<div class="file-name" data-action="rename-file" data-id="' + id + '" data-file-name="' + id + '" title="Click to rename">' + esc(f.originalName) + '</div>'
          + '<div class="file-meta">' + fmtSize(f.size) + ' · ' + esc(f.uploadedByName) + ' · ' + fmtTime(f.uploadedAt) + '</div>'
          + '</div>'
          + '<div class="file-actions">'
          + '<button class="btn-success" data-action="download-file" data-id="' + id + '">⬇</button>'
          + '<button class="btn-danger" data-action="delete-file" data-id="' + id + '">✕</button>'
          + '</div>'
          + '</div>';
      }).join('');
    }

    async function deleteFile(id) {
      await api('DELETE', '/api/files/' + id + '?deviceId=' + encodeURIComponent(DID));
      toast('File deleted');
      loadFiles();
    }

    function startRename(id) {
      const nameEl = document.querySelector('[data-file-name="' + id + '"]');
      if (!nameEl) return;
      const old = nameEl.textContent;
      const input = document.createElement('input');
      input.value = old;
      input.className = 'rename-input';
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      async function save() {
        const v = input.value.trim();
        if (v && v !== old) await api('PATCH', '/api/files/' + id, { deviceId: DID, name: v });
        loadFiles();
      }

      input.addEventListener('blur', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.replaceWith(nameEl); }
      });
    }

    function renderGallery() {
      galleryImages = allFiles.filter((f) => f.mimeType && f.mimeType.startsWith('image/'));
      const el = document.getElementById('galleryGrid');
      if (!galleryImages.length) {
        el.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="emoji">🖼</div><p>No images yet</p></div>';
        return;
      }

      el.innerHTML = galleryImages.map((f, i) =>
        '<div class="gallery-thumb" data-action="open-image" data-id="' + esc(f.id) + '" data-idx="' + i + '">'
        + '<img src="/api/download/' + esc(f.id) + '?deviceId=' + encodeURIComponent(DID) + '" alt="' + esc(f.originalName) + '" loading="lazy" />'
        + '</div>'
      ).join('');
    }

    function openLightbox(idx) {
      if (!galleryImages.length) return;
      lbIndex = idx;
      document.getElementById('lb-img').src = '/api/download/' + galleryImages[idx].id + '?deviceId=' + encodeURIComponent(DID);
      document.getElementById('lightbox').classList.add('open');
    }

    async function loadTexts() {
      try {
        allTexts = await fetch('/api/texts?deviceId=' + encodeURIComponent(DID)).then((r) => r.json());
        renderTexts();
      } catch {}
    }

    function renderTexts() {
      const el = document.getElementById('textList');
      if (!allTexts.length) {
        el.innerHTML = '<div class="empty-state"><div class="emoji">💬</div><p>No messages yet</p></div>';
        return;
      }

      el.innerHTML = allTexts.map((t) => {
        _textStore[t.id] = t.content;
        return '<div class="text-item">'
          + '<div class="text-header">'
          + '<div class="text-from">' + esc(t.sentByName) + (t.sentBy === DID ? ' (You)' : '') + '</div>'
          + '<div class="text-time">' + fmtTime(t.sentAt) + '</div>'
          + '</div>'
          + '<div class="text-content">' + esc(t.content) + '</div>'
          + '<div class="text-footer">'
          + '<button class="btn-sm" data-action="copy-text" data-id="' + esc(t.id) + '">📋 Copy</button>'
          + '<button class="btn-danger" data-action="delete-text" data-id="' + esc(t.id) + '">✕ Delete</button>'
          + '</div>'
          + '</div>';
      }).join('');
    }

    async function sendText() {
      const input = document.getElementById('textInput');
      const content = input.value.trim();
      if (!content) return;
      const targetDevice = document.getElementById('textSendTo').value;
      await api('POST', '/api/texts', { deviceId: DID, deviceName: NAME, content, targetDevice });
      input.value = '';
      toast('Sent!');
      loadTexts();
    }

    async function deleteText(id) {
      await api('DELETE', '/api/texts/' + id + '?deviceId=' + encodeURIComponent(DID));
      loadTexts();
    }

    async function loadHistory() {
      try {
        const h = await fetch('/api/history').then((r) => r.json());
        const el = document.getElementById('histList');
        if (!h.length) {
          el.innerHTML = '<div class="empty-state"><div class="emoji">📜</div><p>No history yet</p></div>';
          return;
        }
        el.innerHTML = h.map((e) =>
          '<div class="hist-item">'
          + '<div class="hist-icon">' + histIcon(e.type) + '</div>'
          + '<div class="hist-info">'
          + '<div class="hist-desc">' + esc(e.desc) + '</div>'
          + '<div class="hist-who">by ' + esc(e.who) + '</div>'
          + '</div>'
          + '<div class="hist-ts">' + fmtTime(e.ts) + '</div>'
          + '</div>'
        ).join('');
      } catch {}
    }

    function showNextModal() {
      if (!pendingQueue.length) {
        processingModal = false;
        return;
      }
      processingModal = true;
      const tr = pendingQueue[0];
      document.getElementById('acceptFrom').textContent = 'From: ' + tr.fromName;
      document.getElementById('acceptFiles').innerHTML = tr.files.map((f) => '<li><span>' + esc(f.name) + '</span><span>' + fmtSize(f.size) + '</span></li>').join('');
      document.getElementById('acceptModal').classList.add('open');

      document.getElementById('acceptBtn').onclick = async () => {
        document.getElementById('acceptModal').classList.remove('open');
        pendingQueue.shift();
        const res = await api('POST', '/api/accept/' + tr.transferId, { deviceId: DID });
        if (res.ok && res.fileIds) {
          toast('Accepted ' + res.fileIds.length + ' file(s)!');
          for (let i = 0; i < res.fileIds.length; i++) {
            await new Promise((resolve) => setTimeout(resolve, i === 0 ? 100 : 300));
            window.location.href = '/api/download/' + res.fileIds[i] + '?deviceId=' + encodeURIComponent(DID);
          }
          loadFiles();
        }
        setTimeout(showNextModal, 400);
      };

      document.getElementById('declineBtn').onclick = async () => {
        document.getElementById('acceptModal').classList.remove('open');
        pendingQueue.shift();
        await api('POST', '/api/decline/' + tr.transferId, { deviceId: DID });
        toast('Declined');
        setTimeout(showNextModal, 400);
      };
    }

    document.body.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      const id = target.dataset.id;

      switch (action) {
        case 'set-name':
          const v = document.getElementById('nameInput').value.trim();
          if (!v) return;
          NAME = v;
          localStorage.setItem('orbit_name', NAME);
          startApp();
          break;
        case 'toggle-theme':
          const dark = document.documentElement.dataset.theme === 'dark';
          document.documentElement.dataset.theme = dark ? 'light' : 'dark';
          localStorage.setItem('orbit_theme', dark ? 'light' : 'dark');
          document.getElementById('themeBtn').textContent = dark ? '🌙' : '☀️';
          break;
        case 'toggle-qr':
          const sidebar = document.getElementById('sidebar');
          sidebar.classList.toggle('open');
          break;
        case 'switch-tab':
          switchTab(target.dataset.tab);
          break;
        case 'trigger-upload':
          document.getElementById('fileInput').click();
          break;
        case 'cancel-upload':
          if (uploadXHR) uploadXHR.abort();
          uploadXHR = null;
          hideProgress();
          break;
        case 'delete-file':
          deleteFile(id);
          break;
        case 'download-file':
          window.location.href = '/api/download/' + id + '?deviceId=' + encodeURIComponent(DID);
          break;
        case 'rename-file':
          startRename(id);
          break;
        case 'open-image':
          openLightbox(parseInt(target.dataset.idx));
          break;
        case 'delete-text':
          deleteText(id);
          break;
        case 'copy-text':
          navigator.clipboard.writeText(_textStore[id] || '').then(() => toast('Copied!')).catch(() => toast('Copy failed', 'err'));
          break;
        case 'send-text':
          sendText();
          break;
      }
    });

    document.getElementById('nameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.querySelector('[data-action="set-name"]').click();
    });

    document.getElementById('lb-close').addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('lightbox').classList.remove('open'); });
    document.getElementById('lightbox').addEventListener('click', () => document.getElementById('lightbox').classList.remove('open'));
    document.getElementById('lb-prev').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!galleryImages.length) return;
      lbIndex = (lbIndex - 1 + galleryImages.length) % galleryImages.length;
      document.getElementById('lb-img').src = '/api/download/' + galleryImages[lbIndex].id + '?deviceId=' + encodeURIComponent(DID);
    });
    document.getElementById('lb-next').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!galleryImages.length) return;
      lbIndex = (lbIndex + 1) % galleryImages.length;
      document.getElementById('lb-img').src = '/api/download/' + galleryImages[lbIndex].id + '?deviceId=' + encodeURIComponent(DID);
    });

    document.addEventListener('keydown', (e) => {
      if (!document.getElementById('lightbox').classList.contains('open')) return;
      if (e.key === 'Escape') document.getElementById('lightbox').classList.remove('open');
      if (e.key === 'ArrowLeft') document.getElementById('lb-prev').click();
      if (e.key === 'ArrowRight') document.getElementById('lb-next').click();
    });

    initName();
  </script>
</body>
</html>`;
}

app.get('/', async (req, res) => {
  if (!_html) _html = await buildHTML();
  res.send(_html);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🪐  Orbit is live!');
  console.log('   PC:     http://localhost:' + PORT);
  console.log('   LAN:    http://' + LOCAL_IP + ':' + PORT + '\n');
});
