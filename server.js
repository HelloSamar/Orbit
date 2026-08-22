'use strict';
const express = require('express');
const multer  = require('multer');
const qrcode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');

const app      = express();
const PORT     = 3000;
const SHARE    = path.join(__dirname, 'shared');
if (!fs.existsSync(SHARE)) fs.mkdirSync(SHARE);
app.use(express.json());

// ── State ─────────────────────────────────────────────────────────────────────
const devices  = {};  // id → { name, lastSeen }
const fileStore= [];  // { id, originalName, storedName, size, mimeType, uploadedBy, uploadedByName, targetDevice, accepted, uploadedAt }
const textStore= [];  // { id, content, sentBy, sentByName, targetDevice, sentAt }
const histLog  = [];  // { id, type, desc, who, ts }
const pending  = {};  // deviceId → [{ transferId, files:[{id,name,size}], fromId, fromName }]

const uid = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();

// ── Multer ────────────────────────────────────────────────────────────────────
const stor = multer.diskStorage({
  destination: SHARE,
  filename: (req, file, cb) => cb(null, uid() + '_' + file.originalname.replace(/[^\w.\-]/g, '_'))
});
const upload = multer({ storage: stor, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Helpers ───────────────────────────────────────────────────────────────────
function getIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
function liveDevices() {
  const cut = now() - 15000;
  return Object.entries(devices).filter(([,d]) => d.lastSeen > cut).map(([id,d]) => ({ id, name: d.name }));
}
function diskUsed() {
  try {
    return fs.readdirSync(SHARE).reduce((a,f) => {
      try { return a + fs.statSync(path.join(SHARE,f)).size; } catch { return a; }
    }, 0);
  } catch { return 0; }
}
function log(type, desc, who) {
  histLog.unshift({ id: uid(), type, desc, who, ts: now() });
  if (histLog.length > 100) histLog.length = 100;
}

// ── Auto-expire files after 60 min ────────────────────────────────────────────
setInterval(() => {
  const cut = now() - 3_600_000;
  for (let i = fileStore.length - 1; i >= 0; i--) {
    if (fileStore[i].uploadedAt < cut) {
      try { fs.unlinkSync(path.join(SHARE, fileStore[i].storedName)); } catch {}
      fileStore.splice(i, 1);
    }
  }
}, 60_000);

// ── API Routes ────────────────────────────────────────────────────────────────
app.post('/api/heartbeat', (req, res) => {
  const { deviceId, deviceName } = req.body || {};
  if (!deviceId) return res.json({ ok: false });
  devices[deviceId] = { name: deviceName || 'Unknown', lastSeen: now() };
  res.json({ ok: true, devices: liveDevices(), pending: pending[deviceId] || [], storage: { used: diskUsed(), limit: 2 * 1024 * 1024 * 1024 } });
});

app.get('/api/files', (req, res) => {
  const { deviceId } = req.query;
  res.json(fileStore.filter(f =>
    f.targetDevice === 'everyone' ||
    f.uploadedBy === deviceId ||
    (f.targetDevice === deviceId && f.accepted)
  ));
});

app.post('/api/upload', upload.array('files'), (req, res) => {
  const { deviceId, deviceName, targetDevice } = req.body;
  if (!req.files?.length) return res.status(400).json({ error: 'No files' });
  const newFiles = req.files.map(f => ({
    id: uid(), originalName: f.originalname, storedName: f.filename,
    size: f.size, mimeType: f.mimetype,
    uploadedBy: deviceId, uploadedByName: deviceName || 'Unknown',
    targetDevice: targetDevice || 'everyone',
    accepted: !targetDevice || targetDevice === 'everyone',
    uploadedAt: now()
  }));
  fileStore.push(...newFiles);
  if (targetDevice && targetDevice !== 'everyone') {
    if (!pending[targetDevice]) pending[targetDevice] = [];
    pending[targetDevice].push({
      transferId: uid(),
      files: newFiles.map(f => ({ id: f.id, name: f.originalName, size: f.size })),
      fromId: deviceId, fromName: deviceName || 'Unknown'
    });
  }
  log('upload', newFiles.length + ' file(s) sent', deviceName || 'Unknown');
  res.json({ ok: true, files: newFiles });
});

app.get('/api/download/:id', (req, res) => {
  const f = fileStore.find(f => f.id === req.params.id);
  if (!f) return res.status(404).end();
  // Enforce the same visibility rule as GET /api/files, so a file that's
  // still pending accept/decline (or targeted at a different device)
  // can't be fetched directly by ID alone.
  const { deviceId } = req.query;
  const visible = f.targetDevice === 'everyone' ||
    f.uploadedBy === deviceId ||
    (f.targetDevice === deviceId && f.accepted);
  if (!visible) return res.status(403).end();
  const fp = path.join(SHARE, f.storedName);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.download(fp, f.originalName);
});

app.delete('/api/files/:id', (req, res) => {
  const i = fileStore.findIndex(f => f.id === req.params.id);
  if (i === -1) return res.status(404).end();
  try { fs.unlinkSync(path.join(SHARE, fileStore[i].storedName)); } catch {}
  fileStore.splice(i, 1);
  res.json({ ok: true });
});

app.patch('/api/files/:id', (req, res) => {
  const f = fileStore.find(f => f.id === req.params.id);
  if (!f) return res.status(404).end();
  if (req.body.name) f.originalName = req.body.name;
  res.json({ ok: true });
});

app.post('/api/accept/:tid', (req, res) => {
  const { deviceId } = req.body;
  const list = pending[deviceId] || [];
  const i = list.findIndex(t => t.transferId === req.params.tid);
  if (i === -1) return res.status(404).end();
  const [tr] = list.splice(i, 1);
  for (const tf of tr.files) {
    const f = fileStore.find(f => f.id === tf.id);
    if (f) f.accepted = true;
  }
  log('accept', 'Accepted from ' + tr.fromName, devices[deviceId]?.name || 'Unknown');
  res.json({ ok: true, fileIds: tr.files.map(f => f.id) });
});

app.post('/api/decline/:tid', (req, res) => {
  const { deviceId } = req.body;
  const list = pending[deviceId] || [];
  const i = list.findIndex(t => t.transferId === req.params.tid);
  if (i === -1) return res.status(404).end();
  const [tr] = list.splice(i, 1);
  for (const tf of tr.files) {
    const fi = fileStore.findIndex(f => f.id === tf.id);
    if (fi !== -1) { try { fs.unlinkSync(path.join(SHARE, fileStore[fi].storedName)); } catch {} fileStore.splice(fi, 1); }
  }
  log('decline', 'Declined from ' + tr.fromName, devices[deviceId]?.name || 'Unknown');
  res.json({ ok: true });
});

app.get('/api/texts', (req, res) => {
  const { deviceId } = req.query;
  res.json(textStore.filter(t => t.targetDevice === 'everyone' || t.sentBy === deviceId || t.targetDevice === deviceId));
});

app.post('/api/texts', (req, res) => {
  const { deviceId, deviceName, content, targetDevice } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Empty' });
  const t = { id: uid(), content: content.trim(), sentBy: deviceId, sentByName: deviceName || 'Unknown', targetDevice: targetDevice || 'everyone', sentAt: now() };
  textStore.unshift(t);
  if (textStore.length > 50) textStore.length = 50;
  log('text', 'Text shared', deviceName || 'Unknown');
  res.json({ ok: true, text: t });
});

app.delete('/api/texts/:id', (req, res) => {
  const i = textStore.findIndex(t => t.id === req.params.id);
  if (i !== -1) textStore.splice(i, 1);
  res.json({ ok: true });
});

app.get('/api/history', (req, res) => res.json(histLog));

// ── HTML ──────────────────────────────────────────────────────────────────────
const LOCAL_IP = getIP();
const BASE_URL  = 'http://' + LOCAL_IP + ':' + PORT;
let _html = null;

async function buildHTML() {
  const qrDataURL = await qrcode.toDataURL(BASE_URL, {
    type: 'image/png', width: 180, margin: 1,
    color: { dark: '#7c3aed', light: '#ffffff' }
  });

  return `<!DOCTYPE html>
<html data-theme="dark" lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Orbit</title>
<style>
/* ── Variables ── */
:root {
  --bg:       #080812;
  --surface:  #0f0f1c;
  --card:     #161626;
  --card2:    #1c1c30;
  --border:   rgba(124,58,237,.18);
  --accent:   #7c3aed;
  --accent2:  #06b6d4;
  --green:    #10b981;
  --red:      #ef4444;
  --yellow:   #f59e0b;
  --text:     #e2e8f0;
  --muted:    #64748b;
  --mono:     'SF Mono', 'Fira Code', monospace;
}
html[data-theme="light"] {
  --bg:      #f1f5f9;
  --surface: #ffffff;
  --card:    #f8fafc;
  --card2:   #e2e8f0;
  --border:  rgba(124,58,237,.2);
  --text:    #1e293b;
  --muted:   #94a3b8;
}

/* ── Reset ── */
*,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }
body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; overflow-x:hidden; }
button { font-family:inherit; cursor:pointer; border:none; background:none; }
input,textarea { font-family:inherit; }
a { color:inherit; text-decoration:none; }
::-webkit-scrollbar { width:4px; height:4px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:var(--border); border-radius:4px; }

/* ── Layout ── */
#nameModal { position:fixed; inset:0; background:rgba(0,0,0,.7); backdrop-filter:blur(8px); display:flex; align-items:center; justify-content:center; z-index:999; }
#nameModal .nm-box { background:var(--card); border:1px solid var(--border); border-radius:20px; padding:36px; text-align:center; width:min(360px,90vw); }
#nameModal h2 { font-size:22px; margin-bottom:8px; }
#nameModal p  { font-size:14px; color:var(--muted); margin-bottom:24px; }
#nameInput { width:100%; padding:12px 16px; border-radius:12px; border:1px solid var(--border); background:var(--surface); color:var(--text); font-size:16px; outline:none; margin-bottom:16px; }
#nameInput:focus { border-color:var(--accent); }
.btn-primary { background:linear-gradient(135deg,var(--accent),#5b21b6); color:#fff; padding:12px 28px; border-radius:12px; font-size:15px; font-weight:600; width:100%; }
.btn-primary:hover { opacity:.9; }

header { height:56px; display:flex; align-items:center; padding:0 20px; gap:12px; border-bottom:1px solid var(--border); background:rgba(8,8,18,.9); backdrop-filter:blur(12px); position:sticky; top:0; z-index:90; }
.logo { display:flex; align-items:center; gap:8px; font-size:17px; font-weight:700; }
.logo-icon { font-size:20px; }
.logo span { color:var(--accent); }
.header-name { font-size:13px; color:var(--muted); margin-left:4px; }
.header-right { margin-left:auto; display:flex; gap:8px; align-items:center; }
.icon-btn { width:36px; height:36px; border-radius:10px; border:1px solid var(--border); background:var(--card); color:var(--text); font-size:16px; display:flex; align-items:center; justify-content:center; transition:all .2s; }
.icon-btn:hover { border-color:var(--accent); background:var(--card2); }

.layout { display:flex; height:calc(100vh - 56px); overflow:hidden; }

/* ── Sidebar ── */
.sidebar { width:280px; flex-shrink:0; border-right:1px solid var(--border); display:flex; flex-direction:column; gap:0; overflow-y:auto; background:var(--surface); }
@media(max-width:700px) { .sidebar { display:none; } .sidebar.open { display:flex; position:fixed; inset:56px 0 0 0; width:100%; z-index:80; } }

.qr-panel { padding:20px; border-bottom:1px solid var(--border); }
.panel-label { font-size:10px; letter-spacing:2px; text-transform:uppercase; color:var(--accent); font-weight:600; margin-bottom:14px; }
.qr-wrap { display:flex; flex-direction:column; align-items:center; gap:12px; }
.qr-img { border-radius:12px; border:3px solid var(--accent); padding:4px; background:#fff; }
.qr-url { font-family:var(--mono); font-size:11px; color:var(--accent2); background:rgba(6,182,212,.1); padding:4px 10px; border-radius:100px; word-break:break-all; text-align:center; }
.storage-bar-wrap { width:100%; }
.storage-labels { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:4px; }
.storage-bar { height:5px; background:var(--card2); border-radius:100px; overflow:hidden; }
.storage-fill { height:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); border-radius:100px; transition:width .5s; }

.devices-panel { padding:16px 20px; flex:1; }
.device-item { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:10px; margin-bottom:4px; }
.device-item:hover { background:var(--card); }
.device-dot { width:8px; height:8px; border-radius:50%; background:var(--green); flex-shrink:0; box-shadow:0 0 6px var(--green); }
.device-dot.away { background:var(--muted); box-shadow:none; }
.device-name { font-size:13px; font-weight:500; }
.you-tag { font-size:10px; background:rgba(124,58,237,.15); color:var(--accent); padding:2px 6px; border-radius:100px; margin-left:auto; }

/* ── Main ── */
.main { flex:1; display:flex; flex-direction:column; overflow:hidden; }

.tabs { display:flex; gap:2px; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--surface); flex-shrink:0; overflow-x:auto; }
.tab-btn { padding:7px 16px; border-radius:10px; font-size:13px; font-weight:500; color:var(--muted); transition:all .2s; white-space:nowrap; }
.tab-btn.active { background:rgba(124,58,237,.15); color:var(--accent); }
.tab-btn:hover { color:var(--text); background:var(--card); }

.tab-pane { display:none; flex:1; overflow-y:auto; padding:16px; flex-direction:column; gap:14px; }
.tab-pane.active { display:flex; }

/* ── Upload zone ── */
.upload-zone { border:2px dashed var(--border); border-radius:14px; padding:28px 20px; text-align:center; cursor:pointer; transition:all .25s; background:rgba(124,58,237,.02); }
.upload-zone:hover, .upload-zone.drag { border-color:var(--accent); background:rgba(124,58,237,.06); }
.upload-zone .uz-icon { font-size:32px; margin-bottom:8px; }
.upload-zone h3 { font-size:14px; font-weight:600; margin-bottom:4px; }
.upload-zone p  { font-size:12px; color:var(--muted); }
.upload-controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.send-to-wrap { display:flex; align-items:center; gap:8px; }
.send-to-wrap label { font-size:12px; color:var(--muted); }
select { background:var(--card); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:6px 10px; font-size:13px; outline:none; cursor:pointer; }
select:focus { border-color:var(--accent); }
.btn-upload { background:linear-gradient(135deg,var(--accent),#5b21b6); color:#fff; padding:8px 20px; border-radius:10px; font-size:13px; font-weight:600; }
.btn-sm { padding:6px 14px; border-radius:8px; font-size:12px; font-weight:500; border:1px solid var(--border); color:var(--text); background:var(--card); }
.btn-sm:hover { border-color:var(--accent); }
.btn-danger-sm { background:rgba(239,68,68,.1); color:var(--red); border:1px solid rgba(239,68,68,.2); }
.btn-danger-sm:hover { background:rgba(239,68,68,.2); }
.btn-green-sm { background:rgba(16,185,129,.1); color:var(--green); border:1px solid rgba(16,185,129,.2); }
.btn-green-sm:hover { background:rgba(16,185,129,.2); }

.progress-wrap { display:none; }
.progress-wrap.show { display:block; }
.progress-bar-outer { background:var(--card2); border-radius:100px; height:6px; overflow:hidden; }
.progress-bar-inner { height:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); width:0%; transition:width .2s; border-radius:100px; }
.progress-label { font-size:12px; color:var(--muted); margin-top:6px; display:flex; justify-content:space-between; }

/* ── File list ── */
.file-list { display:flex; flex-direction:column; gap:8px; }
.file-item { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px 14px; display:flex; align-items:center; gap:12px; transition:all .2s; }
.file-item:hover { border-color:rgba(124,58,237,.3); }
.file-type-icon { width:40px; height:40px; border-radius:10px; background:linear-gradient(135deg,rgba(124,58,237,.15),rgba(6,182,212,.15)); display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0; }
.file-info { flex:1; min-width:0; }
.file-name { font-size:14px; font-weight:500; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.file-name:hover { color:var(--accent); }
.file-meta { font-size:11px; color:var(--muted); margin-top:2px; }
.file-actions { display:flex; gap:6px; flex-shrink:0; }
.rename-input { background:var(--surface); border:1px solid var(--accent); border-radius:6px; padding:2px 8px; color:var(--text); font-size:14px; font-weight:500; width:140px; outline:none; }
.empty-state { text-align:center; padding:48px 24px; color:var(--muted); }
.empty-state .ei { font-size:40px; margin-bottom:12px; }
.empty-state p { font-size:14px; }

/* ── Gallery ── */
.gallery-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; }
.gallery-thumb { aspect-ratio:1; border-radius:10px; overflow:hidden; cursor:pointer; border:2px solid var(--border); transition:all .2s; background:var(--card); }
.gallery-thumb:hover { border-color:var(--accent); transform:scale(1.02); }
.gallery-thumb img { width:100%; height:100%; object-fit:cover; }

/* ── Lightbox ── */
#lightbox { position:fixed; inset:0; background:rgba(0,0,0,.92); display:none; align-items:center; justify-content:center; z-index:500; cursor:pointer; }
#lightbox.open { display:flex; }
#lightbox img { max-width:95vw; max-height:90vh; object-fit:contain; border-radius:8px; }
.lb-close { position:absolute; top:16px; right:16px; width:36px; height:36px; border-radius:50%; background:rgba(255,255,255,.1); color:#fff; font-size:18px; display:flex; align-items:center; justify-content:center; }
.lb-nav { position:absolute; top:50%; transform:translateY(-50%); width:44px; height:44px; border-radius:50%; background:rgba(255,255,255,.1); color:#fff; font-size:20px; display:flex; align-items:center; justify-content:center; }
#lb-prev { left:16px; }
#lb-next { right:16px; }

/* ── Clipboard ── */
.text-compose { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:14px; display:flex; flex-direction:column; gap:10px; }
.text-compose textarea { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:10px 12px; color:var(--text); font-size:14px; resize:none; outline:none; min-height:80px; }
.text-compose textarea:focus { border-color:var(--accent); }
.text-compose-footer { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
.text-list { display:flex; flex-direction:column; gap:8px; }
.text-item { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px 14px; }
.text-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
.text-from { font-size:11px; color:var(--accent); font-weight:600; }
.text-time { font-size:11px; color:var(--muted); }
.text-content { font-size:14px; white-space:pre-wrap; word-break:break-word; margin-bottom:8px; }
.text-footer { display:flex; gap:6px; }

/* ── History ── */
.hist-list { display:flex; flex-direction:column; gap:6px; }
.hist-item { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:10px 14px; display:flex; align-items:center; gap:12px; }
.hist-icon { font-size:18px; width:32px; text-align:center; }
.hist-info { flex:1; min-width:0; }
.hist-desc { font-size:13px; font-weight:500; }
.hist-who  { font-size:11px; color:var(--muted); margin-top:2px; }
.hist-ts   { font-size:11px; color:var(--muted); flex-shrink:0; }

/* ── Accept Modal ── */
#acceptModal { position:fixed; inset:0; background:rgba(0,0,0,.75); backdrop-filter:blur(10px); display:none; align-items:center; justify-content:center; z-index:600; }
#acceptModal.open { display:flex; }
.accept-box { background:var(--card); border:1px solid var(--border); border-radius:20px; padding:28px; width:min(400px,92vw); }
.accept-box h2 { font-size:18px; font-weight:700; margin-bottom:4px; }
.accept-from { font-size:13px; color:var(--muted); margin-bottom:18px; }
.accept-files { list-style:none; margin-bottom:20px; display:flex; flex-direction:column; gap:6px; }
.accept-files li { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:8px 12px; font-size:13px; display:flex; justify-content:space-between; }
.accept-actions { display:flex; gap:10px; }
.btn-accept  { flex:1; background:linear-gradient(135deg,var(--green),#059669); color:#fff; padding:12px; border-radius:12px; font-size:14px; font-weight:600; }
.btn-decline { flex:1; background:rgba(239,68,68,.12); color:var(--red); border:1px solid rgba(239,68,68,.25); padding:12px; border-radius:12px; font-size:14px; font-weight:600; }

/* ── Toast ── */
#toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(20px); background:var(--card2); border:1px solid var(--border); padding:10px 20px; border-radius:100px; font-size:13px; opacity:0; transition:all .3s; pointer-events:none; z-index:700; white-space:nowrap; }
#toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
#toast.ok  { border-color:rgba(16,185,129,.4); color:var(--green); }
#toast.err { border-color:rgba(239,68,68,.4); color:var(--red); }

/* ── QR sidebar toggle (mobile) ── */
#sidebarOverlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:79; }
@media(max-width:700px) { .layout { height:calc(100vh - 56px); } }
</style>
</head>
<body>

<!-- ── Name Modal ────────────────────────────────────────────────── -->
<div id="nameModal">
  <div class="nm-box">
    <div style="font-size:40px;margin-bottom:12px">🪐</div>
    <h2>Welcome to Orbit</h2>
    <p>What should other devices call you?</p>
    <input id="nameInput" type="text" placeholder="My iPhone / My Laptop" maxlength="30" autocomplete="off">
    <button class="btn-primary" data-action="set-name">Join Orbit</button>
  </div>
</div>

<!-- ── Header ────────────────────────────────────────────────────── -->
<header>
  <div class="logo"><span class="logo-icon">🪐</span><span>Orbit</span></div>
  <div class="header-name" id="headerName"></div>
  <div class="header-right">
    <button class="icon-btn" data-action="toggle-qr" title="QR / Devices" id="qrToggle">📡</button>
    <button class="icon-btn" data-action="toggle-theme" id="themeBtn">☀️</button>
  </div>
</header>

<!-- ── Layout ────────────────────────────────────────────────────── -->
<div id="sidebarOverlay" data-action="close-sidebar"></div>
<div class="layout">
  <aside class="sidebar" id="sidebar">
    <!-- QR Panel -->
    <div class="qr-panel">
      <div class="panel-label">📱 Connect</div>
      <div class="qr-wrap">
        <img class="qr-img" src="${qrDataURL}" width="168" height="168" alt="QR">
        <div class="qr-url">${BASE_URL}</div>
        <div class="storage-bar-wrap">
          <div class="storage-labels">
            <span id="storUsed">0 MB used</span>
            <span id="storLimit">2 GB</span>
          </div>
          <div class="storage-bar"><div class="storage-fill" id="storFill" style="width:0%"></div></div>
        </div>
      </div>
    </div>
    <!-- Devices Panel -->
    <div class="devices-panel">
      <div class="panel-label">📶 Online</div>
      <div id="deviceList"></div>
    </div>
  </aside>

  <div class="main">
    <!-- Tabs -->
    <div class="tabs">
      <button class="tab-btn active" data-action="switch-tab" data-tab="files">📁 Files</button>
      <button class="tab-btn" data-action="switch-tab" data-tab="gallery">🖼 Gallery</button>
      <button class="tab-btn" data-action="switch-tab" data-tab="clipboard">📋 Clipboard</button>
      <button class="tab-btn" data-action="switch-tab" data-tab="history">📜 History</button>
    </div>

    <!-- Files Tab -->
    <div class="tab-pane active" id="pane-files">
      <div class="upload-zone" id="dropZone">
        <div class="uz-icon">📂</div>
        <h3>Drop files here</h3>
        <p>or tap to choose files</p>
      </div>
      <input type="file" id="fileInput" multiple style="display:none">
      <div class="upload-controls">
        <div class="send-to-wrap">
          <label>To:</label>
          <select id="sendTo"><option value="everyone">Everyone</option></select>
        </div>
        <button class="btn-upload" data-action="trigger-upload">Choose &amp; Send</button>
        <button class="btn-sm btn-danger-sm" id="cancelUploadBtn" style="display:none" data-action="cancel-upload">✕ Cancel</button>
      </div>
      <div class="progress-wrap" id="progressWrap">
        <div class="progress-bar-outer"><div class="progress-bar-inner" id="progressBar"></div></div>
        <div class="progress-label"><span id="progressText">Uploading…</span><span id="progressPct">0%</span></div>
      </div>
      <div class="file-list" id="fileList"></div>
    </div>

    <!-- Gallery Tab -->
    <div class="tab-pane" id="pane-gallery">
      <div class="gallery-grid" id="galleryGrid"></div>
    </div>

    <!-- Clipboard Tab -->
    <div class="tab-pane" id="pane-clipboard">
      <div class="text-compose">
        <div class="panel-label">✏️ Send Text</div>
        <textarea id="textInput" placeholder="Type something to share…"></textarea>
        <div class="text-compose-footer">
          <div class="send-to-wrap">
            <label>To:</label>
            <select id="textSendTo"><option value="everyone">Everyone</option></select>
          </div>
          <button class="btn-upload" data-action="send-text">Send →</button>
        </div>
      </div>
      <div class="text-list" id="textList"></div>
    </div>

    <!-- History Tab -->
    <div class="tab-pane" id="pane-history">
      <div class="hist-list" id="histList"></div>
    </div>
  </div>
</div>

<!-- ── Accept Modal ──────────────────────────────────────────────── -->
<div id="acceptModal">
  <div class="accept-box">
    <h2>📨 Incoming Files</h2>
    <div class="accept-from" id="acceptFrom"></div>
    <ul class="accept-files" id="acceptFiles"></ul>
    <div class="accept-actions">
      <button class="btn-accept"  id="acceptBtn">✓ Accept</button>
      <button class="btn-decline" id="declineBtn">✕ Decline</button>
    </div>
  </div>
</div>

<!-- ── Lightbox ──────────────────────────────────────────────────── -->
<div id="lightbox">
  <button class="lb-close" id="lb-close">✕</button>
  <button class="lb-nav" id="lb-prev">‹</button>
  <img id="lb-img" src="" alt="">
  <button class="lb-nav" id="lb-next">›</button>
</div>

<!-- ── Toast ─────────────────────────────────────────────────────── -->
<div id="toast"></div>

<script>
// ── Helpers ──────────────────────────────────────────────────────────────────
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}
function fmtTime(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d/60000) + 'm ago';
  if (d < 86400000) return Math.floor(d/3600000) + 'h ago';
  return Math.floor(d/86400000) + 'd ago';
}
function fileIcon(mime, name) {
  if (mime.startsWith('image/')) return '🖼';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z')) return '📦';
  if (mime.includes('word') || name.endsWith('.docx')) return '📝';
  if (mime.includes('sheet') || name.endsWith('.xlsx')) return '📊';
  return '📁';
}
function histIcon(type) {
  return { upload:'⬆', accept:'✅', decline:'❌', text:'💬' }[type] || '•';
}
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json().catch(() => ({}));
}
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + (type || 'ok');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.className = '', 2500);
}

// ── State ─────────────────────────────────────────────────────────────────────
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

// ── Init / Name ───────────────────────────────────────────────────────────────
function initTheme() {
  const t = localStorage.getItem('orbit_theme') || 'dark';
  document.documentElement.dataset.theme = t;
  document.getElementById('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
}
initTheme();

function initName() {
  if (NAME) { startApp(); return; }
  const ua = navigator.userAgent;
  const guess = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'My Device';
  document.getElementById('nameInput').value = guess;
  document.getElementById('nameInput').select();
}
function startApp() {
  document.getElementById('nameModal').style.display = 'none';
  document.getElementById('headerName').textContent = NAME;
  dropZoneInit();
  startPolling();
  loadFiles();
  loadTexts();
  loadHistory();
}

// ── Event Delegation ──────────────────────────────────────────────────────────
document.body.addEventListener('click', function(e) {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  const id = t.dataset.id;

  if (a === 'set-name') {
    const v = document.getElementById('nameInput').value.trim();
    if (!v) return;
    NAME = v;
    localStorage.setItem('orbit_name', NAME);
    startApp();
  }
  else if (a === 'toggle-theme') {
    const isDark = document.documentElement.dataset.theme === 'dark';
    document.documentElement.dataset.theme = isDark ? 'light' : 'dark';
    t.textContent = isDark ? '🌙' : '☀️';
    localStorage.setItem('orbit_theme', isDark ? 'light' : 'dark');
  }
  else if (a === 'toggle-qr') {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sidebarOverlay');
    sb.classList.toggle('open');
    ov.style.display = sb.classList.contains('open') ? 'block' : 'none';
  }
  else if (a === 'close-sidebar') {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').style.display = 'none';
  }
  else if (a === 'switch-tab') switchTab(t.dataset.tab);
  else if (a === 'trigger-upload') document.getElementById('fileInput').click();
  else if (a === 'cancel-upload') { if (uploadXHR) { uploadXHR.abort(); uploadXHR = null; hideProgress(); } }
  else if (a === 'delete-file') deleteFile(id);
  else if (a === 'download-file') window.location.href = '/api/download/' + id + '?deviceId=' + encodeURIComponent(DID);
  else if (a === 'rename-file') startRename(id);
  else if (a === 'open-image') openLightbox(parseInt(t.dataset.idx));
  else if (a === 'delete-text') deleteText(id);
  else if (a === 'copy-text') {
    const content = _textStore[id] || '';
    navigator.clipboard.writeText(content).then(() => toast('Copied!')).catch(() => toast('Copy failed', 'err'));
  }
  else if (a === 'send-text') sendText();
});

document.getElementById('nameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.querySelector('[data-action="set-name"]').click();
});

// ── Tab Switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + tab));
  if (tab === 'gallery') renderGallery();
  if (tab === 'history') loadHistory();
}

// ── Polling ───────────────────────────────────────────────────────────────────
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
        if (!pendingQueue.find(p => p.transferId === tr.transferId)) pendingQueue.push(tr);
      }
      if (!processingModal) showNextModal();
    }
    loadFiles();
  } catch {}
}

// ── Storage Bar ───────────────────────────────────────────────────────────────
function updateStorage(s) {
  if (!s) return;
  document.getElementById('storUsed').textContent = fmtSize(s.used) + ' used';
  document.getElementById('storLimit').textContent = fmtSize(s.limit);
  const pct = Math.min(100, (s.used / s.limit) * 100);
  document.getElementById('storFill').style.width = pct + '%';
}

// ── Devices ───────────────────────────────────────────────────────────────────
function renderDevices(devs) {
  const el = document.getElementById('deviceList');
  if (!devs || !devs.length) { el.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:8px 0">No devices online</div>'; return; }
  // Update Send To dropdowns
  updateSendTo(devs);
  el.innerHTML = devs.map(d => {
    const isMe = d.id === DID;
    return '<div class="device-item">'
      + '<div class="device-dot"></div>'
      + '<div class="device-name">' + esc(d.name) + '</div>'
      + (isMe ? '<div class="you-tag">You</div>' : '')
      + '</div>';
  }).join('');
}

function updateSendTo(devs) {
  ['sendTo','textSendTo'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="everyone">Everyone</option>'
      + devs.filter(d => d.id !== DID).map(d =>
          '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>'
        ).join('');
    if (cur) sel.value = cur;
  });
}

// ── Upload ────────────────────────────────────────────────────────────────────
function dropZoneInit() {
  const dz = document.getElementById('dropZone');
  dz.addEventListener('click', () => document.getElementById('fileInput').click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); doUpload(e.dataTransfer.files); });
  document.getElementById('fileInput').addEventListener('change', e => doUpload(e.target.files));
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
  document.getElementById('cancelUploadBtn').style.display = '';
  showProgress();

  xhr.upload.addEventListener('progress', e => {
    if (!e.lengthComputable) return;
    const pct = Math.round(e.loaded / e.total * 100);
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

function showProgress() { document.getElementById('progressWrap').classList.add('show'); document.getElementById('progressBar').style.width = '0%'; }
function hideProgress() { document.getElementById('progressWrap').classList.remove('show'); }

// ── Files ─────────────────────────────────────────────────────────────────────
async function loadFiles() {
  try {
    allFiles = await fetch('/api/files?deviceId=' + DID).then(r => r.json());
    renderFiles();
    if (currentTab === 'gallery') renderGallery();
  } catch {}
}

function renderFiles() {
  const el = document.getElementById('fileList');
  if (!allFiles.length) {
    el.innerHTML = '<div class="empty-state"><div class="ei">📭</div><p>No files yet. Upload something!</p></div>';
    return;
  }
  el.innerHTML = allFiles.map(f =>
    '<div class="file-item" data-file-id="' + esc(f.id) + '">'
    + '<div class="file-type-icon">' + fileIcon(f.mimeType, f.originalName) + '</div>'
    + '<div class="file-info">'
    +   '<div class="file-name" data-action="rename-file" data-id="' + esc(f.id) + '" data-file-name="' + esc(f.id) + '" title="Click to rename">' + esc(f.originalName) + '</div>'
    +   '<div class="file-meta">' + fmtSize(f.size) + ' · ' + esc(f.uploadedByName) + ' · ' + fmtTime(f.uploadedAt) + '</div>'
    + '</div>'
    + '<div class="file-actions">'
    +   '<button class="btn-sm btn-green-sm" data-action="download-file" data-id="' + esc(f.id) + '">⬇</button>'
    +   '<button class="btn-sm btn-danger-sm" data-action="delete-file" data-id="' + esc(f.id) + '">✕</button>'
    + '</div>'
    + '</div>'
  ).join('');
}

async function deleteFile(id) {
  await api('DELETE', '/api/files/' + id);
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
  input.focus(); input.select();
  async function save() {
    const v = input.value.trim();
    if (v && v !== old) await api('PATCH', '/api/files/' + id, { name: v });
    loadFiles();
  }
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.replaceWith(nameEl); }
  });
}

// ── Gallery ───────────────────────────────────────────────────────────────────
function renderGallery() {
  galleryImages = allFiles.filter(f => f.mimeType && f.mimeType.startsWith('image/'));
  const el = document.getElementById('galleryGrid');
  if (!galleryImages.length) {
    el.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="ei">🖼</div><p>No images yet</p></div>';
    return;
  }
  el.innerHTML = galleryImages.map((f, i) =>
    '<div class="gallery-thumb" data-action="open-image" data-id="' + esc(f.id) + '" data-idx="' + i + '">'
    + '<img src="/api/download/' + esc(f.id) + '?deviceId=' + esc(DID) + '" alt="' + esc(f.originalName) + '" loading="lazy">'
    + '</div>'
  ).join('');
}

function openLightbox(idx) {
  if (!galleryImages.length) return;
  lbIndex = idx;
  document.getElementById('lb-img').src = '/api/download/' + galleryImages[idx].id + '?deviceId=' + encodeURIComponent(DID);
  document.getElementById('lightbox').classList.add('open');
}
document.getElementById('lb-close').addEventListener('click', e => { e.stopPropagation(); document.getElementById('lightbox').classList.remove('open'); });
document.getElementById('lightbox').addEventListener('click', () => document.getElementById('lightbox').classList.remove('open'));
document.getElementById('lb-prev').addEventListener('click', e => { e.stopPropagation(); lbIndex = (lbIndex - 1 + galleryImages.length) % galleryImages.length; document.getElementById('lb-img').src = '/api/download/' + galleryImages[lbIndex].id + '?deviceId=' + encodeURIComponent(DID); });
document.getElementById('lb-next').addEventListener('click', e => { e.stopPropagation(); lbIndex = (lbIndex + 1) % galleryImages.length; document.getElementById('lb-img').src = '/api/download/' + galleryImages[lbIndex].id + '?deviceId=' + encodeURIComponent(DID); });
document.addEventListener('keydown', e => {
  if (!document.getElementById('lightbox').classList.contains('open')) return;
  if (e.key === 'Escape') document.getElementById('lightbox').classList.remove('open');
  if (e.key === 'ArrowLeft') document.getElementById('lb-prev').click();
  if (e.key === 'ArrowRight') document.getElementById('lb-next').click();
});

// ── Clipboard / Text ──────────────────────────────────────────────────────────
const _textStore = {}; // id → content for clipboard copy

async function loadTexts() {
  try {
    allTexts = await fetch('/api/texts?deviceId=' + DID).then(r => r.json());
    renderTexts();
  } catch {}
}

function renderTexts() {
  const el = document.getElementById('textList');
  if (!allTexts.length) {
    el.innerHTML = '<div class="empty-state"><div class="ei">💬</div><p>No messages yet</p></div>';
    return;
  }
  el.innerHTML = allTexts.map(t => {
    _textStore[t.id] = t.content;
    return '<div class="text-item">'
      + '<div class="text-header">'
      +   '<div class="text-from">' + esc(t.sentByName) + (t.sentBy === DID ? ' (You)' : '') + '</div>'
      +   '<div class="text-time">' + fmtTime(t.sentAt) + '</div>'
      + '</div>'
      + '<div class="text-content">' + esc(t.content) + '</div>'
      + '<div class="text-footer">'
      +   '<button class="btn-sm" data-action="copy-text" data-id="' + esc(t.id) + '">📋 Copy</button>'
      +   '<button class="btn-sm btn-danger-sm" data-action="delete-text" data-id="' + esc(t.id) + '">✕ Delete</button>'
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
  await api('DELETE', '/api/texts/' + id);
  loadTexts();
}

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const h = await fetch('/api/history').then(r => r.json());
    const el = document.getElementById('histList');
    if (!h.length) { el.innerHTML = '<div class="empty-state"><div class="ei">📜</div><p>No history yet</p></div>'; return; }
    el.innerHTML = h.map(e =>
      '<div class="hist-item">'
      + '<div class="hist-icon">' + histIcon(e.type) + '</div>'
      + '<div class="hist-info">'
      +   '<div class="hist-desc">' + esc(e.desc) + '</div>'
      +   '<div class="hist-who">by ' + esc(e.who) + '</div>'
      + '</div>'
      + '<div class="hist-ts">' + fmtTime(e.ts) + '</div>'
      + '</div>'
    ).join('');
  } catch {}
}

// ── Accept / Decline Modal ────────────────────────────────────────────────────
function showNextModal() {
  if (!pendingQueue.length) { processingModal = false; return; }
  processingModal = true;
  const tr = pendingQueue[0];
  document.getElementById('acceptFrom').textContent = 'From: ' + tr.fromName;
  document.getElementById('acceptFiles').innerHTML = tr.files.map(f =>
    '<li><span>' + esc(f.name) + '</span><span>' + fmtSize(f.size) + '</span></li>'
  ).join('');
  document.getElementById('acceptModal').classList.add('open');

  document.getElementById('acceptBtn').onclick = async function() {
    document.getElementById('acceptModal').classList.remove('open');
    pendingQueue.shift();
    const res = await api('POST', '/api/accept/' + tr.transferId, { deviceId: DID });
    if (res.ok && res.fileIds) {
      toast('Accepted ' + res.fileIds.length + ' file(s)!');
      for (let i = 0; i < res.fileIds.length; i++) {
        await new Promise(r => setTimeout(r, i === 0 ? 100 : 300));
        window.location.href = '/api/download/' + res.fileIds[i] + '?deviceId=' + encodeURIComponent(DID);
      }
      loadFiles();
    }
    setTimeout(showNextModal, 400);
  };
  document.getElementById('declineBtn').onclick = async function() {
    document.getElementById('acceptModal').classList.remove('open');
    pendingQueue.shift();
    await api('POST', '/api/decline/' + tr.transferId, { deviceId: DID });
    toast('Declined');
    setTimeout(showNextModal, 400);
  };
}

// ── Kick off ──────────────────────────────────────────────────────────────────
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
  console.log('\n\u{1FA90}  Orbit is live!');
  console.log('   PC:     http://localhost:' + PORT);
  console.log('   iPhone: http://' + LOCAL_IP + ':' + PORT + '\n');
});
