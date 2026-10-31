'use strict';

const express = require('express');
const multer = require('multer');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

/* ───────────── Config (env overridable) ───────────── */
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PIN = process.env.ORBIT_PIN ? String(process.env.ORBIT_PIN) : '';
// 0 = unlimited. By default there is no per-file or total cap; Orbit only refuses an upload
// when the disk itself does not have enough free space.
const MAX_FILE = (Number(process.env.ORBIT_MAX_FILE_MB) || 0) * 1024 * 1024;
const STORAGE_LIMIT = (Number(process.env.ORBIT_STORAGE_GB) || 0) * 1024 * 1024 * 1024;
const FILE_TTL = (Number(process.env.ORBIT_TTL_MIN) || 60) * 60_000;
const SHARE = path.join(__dirname, 'shared');
const STORED_RE = /^[0-9a-f]{12}_/;
const VALID_ID = /^[A-Za-z0-9_-]{8,64}$/;

fs.mkdirSync(SHARE, { recursive: true });
// Files from a previous run are orphans (the file index lives in memory): remove them.
for (const f of fs.readdirSync(SHARE)) {
  if (STORED_RE.test(f)) fs.rmSync(path.join(SHARE, f), { force: true });
}

const app = express();
app.disable('x-powered-by');

/* ───────────── State ───────────── */
const devices = Object.create(null); // secretId -> { name, pub, lastSeen }
const pending = Object.create(null); // pubId -> [transfer]
const fileStore = [];
const textStore = [];
const histLog = [];

const uid = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();
const pubOf = (secret) => crypto.createHash('sha256').update('orbit:' + secret).digest('hex').slice(0, 12);

/* ───────────── Helpers ───────────── */
function safeFileName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return base.replace(/^[_.]+|_+$/g, '').slice(0, 120) || 'file';
}

function displayName(name) {
  let s = String(name || 'file');
  try {
    // busboy decodes multipart filenames as latin1; recover UTF-8 names when possible
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    if (!fixed.includes('\uFFFD')) s = fixed;
  } catch {}
  return cleanName(s) || 'file';
}

function cleanName(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .trim()
    .slice(0, 200);
}

function cleanLabel(v, fallback = 'Unknown') {
  return cleanName(v || '').slice(0, 30) || fallback;
}

function freeDisk() {
  try {
    const st = fs.statfsSync(SHARE); // Node 18.15+
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Infinity;
  }
}

function storageUsed() {
  return fileStore.reduce((sum, f) => sum + f.size, 0);
}

function lanAddresses() {
  const virtual = /vethernet|docker|vbox|virtualbox|vmnet|vmware|wsl|veth|br-|hyper-v|tailscale|zerotier|loopback/i;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family !== 'IPv4' && i.family !== 4) || i.internal) continue;
      let score = 0;
      if (virtual.test(name)) score -= 10;
      if (i.address.startsWith('169.254.')) score -= 5;
      else if (i.address.startsWith('192.168.')) score += 3;
      else if (i.address.startsWith('10.')) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(i.address)) score += 2;
      out.push({ name, address: i.address, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const LAN = lanAddresses();
const LOCAL_IP = process.env.ORBIT_HOST || (LAN[0] && LAN[0].address) || 'localhost';
const BASE_URL = `http://${LOCAL_IP}:${PORT}`;

function liveDevices() {
  const cut = now() - 15_000;
  return Object.values(devices)
    .filter((d) => d.lastSeen > cut)
    .map((d) => ({ id: d.pub, name: d.name }));
}

const isKnownPub = (pub) => Object.values(devices).some((d) => d.pub === pub);

function log(type, desc, who, parties = []) {
  histLog.unshift({ id: uid(), type, desc, who: who || 'Unknown', parties, ts: now() });
  if (histLog.length > 100) histLog.length = 100;
}

const canSeeFile = (f, me) =>
  f.targetDevice === 'everyone' || f.uploadedBy === me || (f.targetDevice === me && f.accepted);
const canManageFile = (f, me) => f.uploadedBy === me || (f.targetDevice === me && f.accepted);
const canSeeText = (t, me) => t.targetDevice === 'everyone' || t.sentBy === me || t.targetDevice === me;
const canManageText = (t, me) => t.sentBy === me || t.targetDevice === me;

function publicFile(f) {
  return {
    id: f.id,
    originalName: f.originalName,
    size: f.size,
    mimeType: f.mimeType,
    uploadedBy: f.uploadedBy,
    uploadedByName: f.uploadedByName,
    targetDevice: f.targetDevice,
    accepted: f.accepted,
    uploadedAt: f.uploadedAt
  };
}

function removeStored(name) {
  if (!name) return;
  try {
    fs.unlinkSync(path.join(SHARE, name));
  } catch {}
}

// Remove a file from the store, disk, and any pending transfer that references it.
function dropFile(index) {
  const [file] = fileStore.splice(index, 1);
  removeStored(file.storedName);
  for (const key of Object.keys(pending)) {
    for (const tr of pending[key]) tr.files = tr.files.filter((f) => f.id !== file.id);
    pending[key] = pending[key].filter((tr) => tr.files.length > 0);
    if (!pending[key].length) delete pending[key];
  }
}

function pruneExpiredFiles() {
  const cut = now() - FILE_TTL;
  for (let i = fileStore.length - 1; i >= 0; i--) {
    if (fileStore[i].uploadedAt < cut) dropFile(i);
  }
}

function pruneStaleDevices() {
  const cut = now() - 60_000;
  for (const id of Object.keys(devices)) {
    if (devices[id].lastSeen < cut) delete devices[id];
  }
}

const timers = [
  setInterval(pruneExpiredFiles, 60_000),
  setInterval(pruneStaleDevices, 15_000)
];
timers.forEach((t) => t.unref());

/* ───────────── Security middleware ───────────── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Block cross-site writes (CSRF / DNS-rebinding style attacks against a LAN server).
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
});

// Small in-memory rate limiter (per IP).
function rateLimit(limit, windowMs) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
  }, windowMs);
  sweep.unref();
  return (req, res, next) => {
    const key = req.ip;
    const t = now();
    let e = hits.get(key);
    if (!e || e.reset < t) e = { count: 0, reset: t + windowMs };
    e.count++;
    hits.set(key, e);
    if (e.count > limit) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}

app.use('/api', rateLimit(1500, 60_000));
app.use(express.json({ limit: '1mb' }));

/* PIN protection (optional: set ORBIT_PIN) */
const AUTH_TOKEN = crypto.randomBytes(24).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function isAuthed(req) {
  if (!PIN) return true;
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('orbit_auth='));
  if (!cookie) return false;
  return crypto.timingSafeEqual(sha(cookie.slice(11)), sha(AUTH_TOKEN));
}

app.post('/login', rateLimit(10, 60_000), (req, res) => {
  const pin = String((req.body && req.body.pin) || '');
  if (!PIN || !crypto.timingSafeEqual(sha(pin), sha(PIN))) return res.status(401).json({ ok: false });
  res.setHeader('Set-Cookie', `orbit_auth=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'PIN required' });
});

// Resolve the calling device's secret id (header preferred; query for downloads).
function who(req) {
  const id = String(req.get('x-device-id') || req.query.deviceId || '');
  return VALID_ID.test(id) ? id : null;
}

function needDevice(req, res, next) {
  const id = who(req);
  if (!id) return res.status(400).json({ error: 'Missing or invalid device id' });
  req.devId = id;
  req.me = pubOf(id);
  next();
}

/* ───────────── Upload (multer) ───────────── */
const upload = multer({
  storage: multer.diskStorage({
    destination: SHARE,
    filename: (req, file, cb) => cb(null, `${uid()}_${safeFileName(file.originalname)}`)
  }),
  limits: { ...(MAX_FILE ? { fileSize: MAX_FILE } : {}), files: 20 }
});

function uploadGate(req, res, next) {
  const id = who(req);
  if (!id || !devices[id]) return res.status(401).json({ error: 'Unknown device — reload the page' });
  const len = Number(req.headers['content-length']) || 0;
  if (STORAGE_LIMIT && storageUsed() + len > STORAGE_LIMIT) {
    return res.status(507).json({ error: 'Orbit storage limit reached' });
  }
  if (len > freeDisk() - 200 * 1024 * 1024) {
    return res.status(507).json({ error: 'Not enough free disk space on the host computer' });
  }
  req.devId = id;
  req.me = pubOf(id);
  next();
}

/* ───────────── API ───────────── */
app.post('/api/heartbeat', needDevice, (req, res) => {
  devices[req.devId] = {
    name: cleanLabel(req.body && req.body.deviceName),
    pub: req.me,
    lastSeen: now()
  };
  res.json({
    ok: true,
    me: req.me,
    devices: liveDevices(),
    pending: pending[req.me] || [],
    storage: { used: storageUsed(), limit: STORAGE_LIMIT, free: freeDisk() === Infinity ? 0 : freeDisk() }
  });
});

app.get('/api/files', needDevice, (req, res) => {
  res.json(fileStore.filter((f) => canSeeFile(f, req.me)).map(publicFile));
});

app.post('/api/upload', uploadGate, upload.array('files', 20), (req, res) => {
  const files = req.files || [];
  const fail = (code, error) => {
    files.forEach((f) => removeStored(f.filename));
    return res.status(code).json({ error });
  };

  if (!files.length) return fail(400, 'No files');

  const target = String((req.body && req.body.targetDevice) || 'everyone');
  if (target !== 'everyone') {
    if (target === req.me) return fail(400, 'You cannot send files to yourself');
    if (!isKnownPub(target)) return fail(400, 'Target device is not online');
  }

  const uploaderName = devices[req.devId].name;
  const newFiles = files.map((file) => ({
    id: uid(),
    originalName: displayName(file.originalname),
    storedName: file.filename,
    size: file.size,
    mimeType: file.mimetype || 'application/octet-stream',
    uploadedBy: req.me,
    uploadedByName: uploaderName,
    targetDevice: target,
    accepted: target === 'everyone',
    uploadedAt: now()
  }));

  fileStore.push(...newFiles);

  if (target !== 'everyone') {
    (pending[target] = pending[target] || []).push({
      transferId: uid(),
      files: newFiles.map((f) => ({ id: f.id, name: f.originalName, size: f.size })),
      fromId: req.me,
      fromName: uploaderName
    });
  }

  log('upload', `${newFiles.length} file(s) sent`, uploaderName, target === 'everyone' ? [] : [req.me, target]);
  res.json({ ok: true, files: newFiles.map(publicFile) });
});

app.get('/api/download/:id', needDevice, (req, res) => {
  const file = fileStore.find((item) => item.id === req.params.id);
  if (!file) return res.status(404).end();
  if (!canSeeFile(file, req.me)) return res.status(403).end();

  const fp = path.join(SHARE, file.storedName);
  if (!fs.existsSync(fp)) return res.status(404).end();

  res.setHeader('Cache-Control', 'no-store');
  res.download(fp, file.originalName);
});

app.delete('/api/files/:id', needDevice, (req, res) => {
  const index = fileStore.findIndex((f) => f.id === req.params.id);
  if (index === -1) return res.status(404).end();
  if (!canManageFile(fileStore[index], req.me)) return res.status(403).end();
  dropFile(index);
  res.json({ ok: true });
});

app.patch('/api/files/:id', needDevice, (req, res) => {
  const file = fileStore.find((item) => item.id === req.params.id);
  if (!file) return res.status(404).end();
  if (!canManageFile(file, req.me)) return res.status(403).end();

  const next = cleanName((req.body && req.body.name) || '');
  if (!next) return res.status(400).json({ error: 'Invalid name' });
  file.originalName = next;
  res.json({ ok: true });
});

function takeTransfer(req, res) {
  const list = pending[req.me] || [];
  const index = list.findIndex((t) => t.transferId === req.params.tid);
  if (index === -1) {
    res.status(404).end();
    return null;
  }
  const [transfer] = list.splice(index, 1);
  if (!list.length) delete pending[req.me];
  return transfer;
}

app.post('/api/accept/:tid', needDevice, (req, res) => {
  const transfer = takeTransfer(req, res);
  if (!transfer) return;

  const ids = [];
  for (const tf of transfer.files) {
    const file = fileStore.find((item) => item.id === tf.id);
    if (file) {
      file.accepted = true;
      ids.push(file.id);
    }
  }

  const name = (devices[req.devId] && devices[req.devId].name) || 'Unknown';
  log('accept', `Accepted from ${transfer.fromName}`, name, [req.me, transfer.fromId]);
  res.json({ ok: true, fileIds: ids });
});

app.post('/api/decline/:tid', needDevice, (req, res) => {
  const transfer = takeTransfer(req, res);
  if (!transfer) return;

  for (const tf of transfer.files) {
    const i = fileStore.findIndex((item) => item.id === tf.id);
    if (i !== -1) dropFile(i);
  }

  const name = (devices[req.devId] && devices[req.devId].name) || 'Unknown';
  log('decline', `Declined from ${transfer.fromName}`, name, [req.me, transfer.fromId]);
  res.json({ ok: true });
});

app.get('/api/texts', needDevice, (req, res) => {
  res.json(textStore.filter((t) => canSeeText(t, req.me)));
});

app.post('/api/texts', needDevice, (req, res) => {
  const { content, targetDevice, deviceName } = req.body || {};
  const text = String(content || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty' });
  if (text.length > 20_000) return res.status(413).json({ error: 'Text too long (max 20,000 characters)' });

  const target = String(targetDevice || 'everyone');
  if (target !== 'everyone' && (target === req.me || !isKnownPub(target))) {
    return res.status(400).json({ error: 'Invalid target device' });
  }

  const entry = {
    id: uid(),
    content: text,
    sentBy: req.me,
    sentByName: (devices[req.devId] && devices[req.devId].name) || cleanLabel(deviceName),
    targetDevice: target,
    sentAt: now()
  };

  textStore.unshift(entry);
  if (textStore.length > 50) textStore.length = 50;
  log('text', 'Text shared', entry.sentByName, target === 'everyone' ? [] : [req.me, target]);
  res.json({ ok: true, text: entry });
});

app.delete('/api/texts/:id', needDevice, (req, res) => {
  const index = textStore.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).end();
  if (!canManageText(textStore[index], req.me)) return res.status(403).end();
  textStore.splice(index, 1);
  res.json({ ok: true });
});

app.get('/api/history', needDevice, (req, res) => {
  res.json(
    histLog
      .filter((h) => !h.parties.length || h.parties.includes(req.me))
      .map(({ id, type, desc, who: w, ts }) => ({ id, type, desc, who: w, ts }))
  );
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ───────────── Pages ───────────── */
function loginHTML() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>Orbit — PIN</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080812;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.box{background:#161626;border:1px solid rgba(124,58,237,.25);border-radius:20px;padding:32px 28px;width:min(340px,90vw);text-align:center}
input{width:100%;box-sizing:border-box;padding:12px 16px;border-radius:12px;border:1px solid rgba(124,58,237,.25);background:#0f0f1c;color:#e2e8f0;margin:16px 0;font:inherit;text-align:center;letter-spacing:4px}
button{width:100%;padding:12px;border:0;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#5b21b6);color:#fff;font:inherit;cursor:pointer}
#err{color:#ef4444;font-size:13px;min-height:18px;margin-top:10px}</style></head>
<body><div class="box"><div style="font-size:40px">🪐</div><h2 style="margin:8px 0 0">Orbit</h2>
<input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN" />
<button id="go">Unlock</button><div id="err"></div></div>
<script>
async function go(){var r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:document.getElementById('pin').value})});
if(r.ok)location.reload();else document.getElementById('err').textContent=r.status===429?'Too many attempts, wait a minute':'Wrong PIN';}
document.getElementById('go').onclick=go;
document.getElementById('pin').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
</script></body></html>`;
}

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
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Orbit</title>
  <style>
    :root {
      --bg:#080812; --surface:#0f0f1c; --card:#161626; --card2:#1c1c30; --border:rgba(124,58,237,.18);
      --accent:#7c3aed; --accent2:#06b6d4; --green:#10b981; --red:#ef4444; --yellow:#f59e0b; --text:#e2e8f0; --muted:#64748b;
      --header-bg:rgba(8,8,18,.9);
    }
    html[data-theme="light"] {
      --bg:#f1f5f9; --surface:#ffffff; --card:#f8fafc; --card2:#e2e8f0; --border:rgba(124,58,237,.2);
      --text:#1e293b; --muted:#64748b; --header-bg:rgba(255,255,255,.92);
    }
    * { box-sizing:border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
    button, input, textarea, select { font:inherit; }
    button { cursor:pointer; }
    .hidden { display:none !important; }
    header { display:flex; align-items:center; gap:12px; height:56px; padding:0 20px; border-bottom:1px solid var(--border); background:var(--header-bg); position:sticky; top:0; z-index:10; }
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
    .tabs { display:flex; gap:2px; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--surface); flex-shrink:0; overflow-x:auto; }
    .tab-btn { padding:8px 16px; border-radius:10px; background:transparent; color:var(--muted); border:0; white-space:nowrap; }
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
    .btn-primary, .btn-upload, .btn-sm, .btn-danger, .btn-success { border:1px solid var(--border); border-radius:10px; padding:8px 16px; background:var(--card); color:var(--text); }
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
    .file-icon { width:40px; height:40px; border-radius:10px; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg,rgba(124,58,237,.16),rgba(6,182,212,.16)); flex-shrink:0; }
    .file-info { flex:1; min-width:0; }
    .file-name { font-size:14px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .file-meta { font-size:11px; color:var(--muted); margin-top:2px; }
    .file-actions { display:flex; gap:6px; }
    .rename-input { background:var(--surface); border:1px solid var(--accent); border-radius:6px; padding:2px 8px; color:var(--text); width:150px; max-width:100%; }
    .empty-state { text-align:center; padding:48px 24px; color:var(--muted); }
    .empty-state .emoji { font-size:40px; margin-bottom:12px; }
    .gallery-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; }
    .gallery-thumb { aspect-ratio:1; border-radius:10px; overflow:hidden; border:2px solid var(--border); background:var(--card); cursor:pointer; }
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
    #nameModal { position:fixed; inset:0; background:var(--bg); display:flex; align-items:center; justify-content:center; z-index:60; }
    #acceptModal { position:fixed; inset:0; background:rgba(0,0,0,.75); display:none; align-items:center; justify-content:center; z-index:30; }
    #acceptModal.open { display:flex; }
    .accept-box { background:var(--card); border:1px solid var(--border); border-radius:20px; padding:28px; width:min(420px,92vw); }
    .accept-box h2 { margin:0 0 4px; }
    .accept-from { margin-bottom:18px; color:var(--muted); font-size:13px; }
    .accept-files { list-style:none; padding:0; margin:0 0 20px; display:flex; flex-direction:column; gap:6px; max-height:40vh; overflow-y:auto; }
    .accept-files li { display:flex; justify-content:space-between; gap:10px; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:8px 12px; font-size:13px; }
    .accept-actions { display:flex; gap:10px; }
    .accept-actions .btn-primary, .accept-actions .btn-danger { flex:1; }
    #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(20px); opacity:0; transition:all .3s; background:var(--card2); border:1px solid var(--border); border-radius:999px; padding:10px 20px; white-space:nowrap; z-index:70; pointer-events:none; }
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
            <div class="storage-head"><span id="storUsed">0 MB used</span><span id="storLimit">No limit</span></div>
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
          <button class="btn-upload" data-action="trigger-upload">Choose &amp; Send</button>
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
          <textarea id="textInput" maxlength="20000" placeholder="Type something to share…"></textarea>
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
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return Array.from(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }
    function esc(v) {
      return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(2) + ' GB';
    }
    function fmtTime(ts) {
      var diff = Date.now() - ts;
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
      if ((mime && mime.includes('zip')) || /\\.(zip|rar|7z)$/i.test(name)) return '📦';
      if ((mime && mime.includes('word')) || /\\.(docx|doc)$/i.test(name)) return '📝';
      if ((mime && mime.includes('sheet')) || /\\.(xlsx|csv)$/i.test(name)) return '📊';
      return '📁';
    }
    function histIcon(type) {
      return { upload: '⬆', accept: '✅', decline: '❌', text: '💬' }[type] || '•';
    }

    var DID = localStorage.getItem('orbit_did');
    if (!DID || !/^[A-Za-z0-9_-]{8,64}$/.test(DID)) { DID = genId(); localStorage.setItem('orbit_did', DID); }
    var ME = '';
    var NAME = localStorage.getItem('orbit_name') || '';
    var currentTab = 'files';
    var allFiles = [];
    var allTexts = [];
    var uploadXHR = null;
    var galleryImages = [];
    var lbIndex = 0;
    var pendingQueue = [];
    var handledTransfers = {};
    var processingModal = false;
    var textStore = {};
    var pollTimer = null;

    function dlUrl(id) { return '/api/download/' + encodeURIComponent(id) + '?deviceId=' + encodeURIComponent(DID); }

    async function api(method, url, body) {
      var opts = { method: method, headers: { 'Content-Type': 'application/json', 'X-Device-Id': DID } };
      if (body) opts.body = JSON.stringify(body);
      var r = await fetch(url, opts);
      if (r.status === 401) { location.reload(); return {}; }
      var data = await r.json().catch(function () { return {}; });
      data._status = r.status;
      return data;
    }

    function getJSON(url) {
      return fetch(url, { headers: { 'X-Device-Id': DID } }).then(function (r) {
        if (r.status === 401) { location.reload(); return []; }
        return r.json();
      });
    }

    function toast(msg, type) {
      var el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'show ' + (type || 'ok');
      clearTimeout(toast._t);
      toast._t = setTimeout(function () { el.className = ''; }, 2500);
    }

    function initTheme() {
      var theme = localStorage.getItem('orbit_theme') || 'dark';
      document.documentElement.dataset.theme = theme;
      document.getElementById('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
    }
    initTheme();

    function initName() {
      if (NAME) return startApp();
      var ua = navigator.userAgent;
      var guess = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'My Device';
      document.getElementById('nameInput').value = guess;
      document.getElementById('nameInput').focus();
      document.getElementById('nameInput').select();
    }

    function startApp() {
      document.getElementById('nameModal').style.display = 'none';
      document.getElementById('headerName').textContent = NAME;
      dropZoneInit();
      beat();
      pollTimer = setInterval(beat, 2500);
      loadHistory();
    }

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach(function (btn) { btn.classList.toggle('active', btn.dataset.tab === tab); });
      document.querySelectorAll('.tab-pane').forEach(function (pane) { pane.classList.toggle('active', pane.id === 'pane-' + tab); });
      if (tab === 'gallery') renderGallery();
      if (tab === 'history') loadHistory();
    }

    var beating = false;
    async function beat() {
      if (beating) return;
      beating = true;
      try {
        var data = await api('POST', '/api/heartbeat', { deviceName: NAME });
        if (!data.ok) return;
        ME = data.me;
        renderDevices(data.devices);
        updateStorage(data.storage);
        if (data.pending && data.pending.length > 0) {
          data.pending.forEach(function (tr) {
            if (handledTransfers[tr.transferId]) return;
            if (!pendingQueue.find(function (p) { return p.transferId === tr.transferId; })) pendingQueue.push(tr);
          });
          if (!processingModal) showNextModal();
        }
        await Promise.all([loadFiles(), loadTexts()]);
        if (currentTab === 'history') loadHistory();
      } catch (e) {} finally { beating = false; }
    }

    function updateStorage(s) {
      if (!s) return;
      document.getElementById('storUsed').textContent = fmtSize(s.used) + ' used';
      document.getElementById('storLimit').textContent = s.limit ? fmtSize(s.limit) : (s.free ? fmtSize(s.free) + ' free' : 'No limit');
      var cap = s.limit || (s.free ? s.used + s.free : 0);
      var pct = cap ? Math.min(100, (s.used / cap) * 100) : 0;
      document.getElementById('storFill').style.width = pct + '%';
    }

    function renderDevices(devs) {
      var el = document.getElementById('deviceList');
      updateSendTo(devs || []);
      if (!devs || !devs.length) {
        el.innerHTML = '<div style="padding:8px 0; color:var(--muted); font-size:13px;">No devices online</div>';
        return;
      }
      el.innerHTML = devs.map(function (d) {
        return '<div class="device-item">'
          + '<div class="device-dot"></div>'
          + '<div class="device-name">' + esc(d.name) + '</div>'
          + (d.id === ME ? '<div class="you-tag">You</div>' : '')
          + '</div>';
      }).join('');
    }

    function updateSendTo(devs) {
      ['sendTo', 'textSendTo'].forEach(function (selId) {
        var sel = document.getElementById(selId);
        if (!sel) return;
        var cur = sel.value;
        sel.innerHTML = '<option value="everyone">Everyone</option>' + devs.filter(function (d) { return d.id !== ME; }).map(function (d) {
          return '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>';
        }).join('');
        if (cur && sel.querySelector('option[value="' + cur + '"]')) sel.value = cur;
      });
    }

    function dropZoneInit() {
      var dz = document.getElementById('dropZone');
      var fileInput = document.getElementById('fileInput');
      dz.addEventListener('click', function () { fileInput.click(); });
      dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', function () { dz.classList.remove('drag'); });
      dz.addEventListener('drop', function (e) { e.preventDefault(); dz.classList.remove('drag'); doUpload(e.dataTransfer.files); });
      fileInput.addEventListener('change', function (e) { doUpload(e.target.files); });
    }

    function finishUpload() {
      uploadXHR = null;
      document.getElementById('cancelUploadBtn').style.display = 'none';
      document.getElementById('fileInput').value = '';
      hideProgress();
    }

    function doUpload(files) {
      if (!files || !files.length) return;
      if (uploadXHR) { toast('An upload is already running', 'err'); return; }
      var fd = new FormData();
      fd.append('targetDevice', document.getElementById('sendTo').value);
      fd.append('deviceName', NAME);
      for (var i = 0; i < files.length; i++) fd.append('files', files[i]);
      var count = files.length;

      var xhr = new XMLHttpRequest();
      uploadXHR = xhr;
      document.getElementById('cancelUploadBtn').style.display = 'inline-block';
      showProgress();

      xhr.upload.addEventListener('progress', function (e) {
        if (!e.lengthComputable) return;
        var pct = Math.round((e.loaded / e.total) * 100);
        document.getElementById('progressBar').style.width = pct + '%';
        document.getElementById('progressPct').textContent = pct + '%';
        document.getElementById('progressText').textContent = 'Uploading ' + count + ' file(s)…';
      });

      xhr.addEventListener('load', function () {
        var ok = xhr.status >= 200 && xhr.status < 300;
        var msg = '';
        if (!ok) { try { msg = JSON.parse(xhr.responseText).error; } catch (e) {} }
        if (xhr.status === 401) { location.reload(); return; }
        finishUpload();
        if (ok) toast('Uploaded ' + count + ' file(s)!');
        else toast(msg || (xhr.status === 413 ? 'File too large' : 'Upload failed'), 'err');
        loadFiles();
      });
      xhr.addEventListener('error', function () { finishUpload(); toast('Upload failed', 'err'); });
      xhr.addEventListener('abort', function () { finishUpload(); toast('Cancelled'); });

      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-Device-Id', DID);
      xhr.send(fd);
    }

    function showProgress() {
      document.getElementById('progressWrap').classList.add('show');
      document.getElementById('progressBar').style.width = '0%';
      document.getElementById('progressPct').textContent = '0%';
    }
    function hideProgress() { document.getElementById('progressWrap').classList.remove('show'); }

    async function loadFiles() {
      try {
        var res = await getJSON('/api/files');
        if (!Array.isArray(res)) return;
        var changed = JSON.stringify(res) !== JSON.stringify(allFiles);
        allFiles = res;
        if (changed && !document.querySelector('.rename-input')) {
          renderFiles();
          if (currentTab === 'gallery') renderGallery();
        }
      } catch (e) {}
    }

    function renderFiles() {
      var el = document.getElementById('fileList');
      if (!allFiles.length) {
        el.innerHTML = '<div class="empty-state"><div class="emoji">📭</div><p>No files yet. Upload something!</p></div>';
        return;
      }
      el.innerHTML = allFiles.map(function (f) {
        var id = esc(f.id);
        var manage = f.uploadedBy === ME || (f.targetDevice === ME && f.accepted);
        return '<div class="file-item">'
          + '<div class="file-icon">' + fileIcon(f.mimeType, f.originalName) + '</div>'
          + '<div class="file-info">'
          + '<div class="file-name"' + (manage ? ' data-action="rename-file" data-id="' + id + '" data-file-name="' + id + '" title="Click to rename"' : '') + '>' + esc(f.originalName) + '</div>'
          + '<div class="file-meta">' + fmtSize(f.size) + ' · ' + esc(f.uploadedByName) + ' · ' + fmtTime(f.uploadedAt) + (f.targetDevice !== 'everyone' && !f.accepted ? ' · awaiting accept' : '') + '</div>'
          + '</div>'
          + '<div class="file-actions">'
          + '<button class="btn-success" data-action="download-file" data-id="' + id + '">⬇</button>'
          + (manage ? '<button class="btn-danger" data-action="delete-file" data-id="' + id + '">✕</button>' : '')
          + '</div>'
          + '</div>';
      }).join('');
    }

    async function deleteFile(id) {
      var r = await api('DELETE', '/api/files/' + encodeURIComponent(id));
      if (r._status === 403) toast('Not allowed', 'err'); else toast('File deleted');
      loadFiles();
    }

    function startRename(id) {
      var nameEl = document.querySelector('[data-file-name="' + id + '"]');
      if (!nameEl) return;
      var old = nameEl.textContent;
      var input = document.createElement('input');
      input.value = old;
      input.maxLength = 200;
      input.className = 'rename-input';
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      var cancelled = false;

      async function save() {
        var v = input.value.trim();
        if (!cancelled && v && v !== old) await api('PATCH', '/api/files/' + encodeURIComponent(id), { name: v });
        allFiles = [];
        loadFiles();
      }

      input.addEventListener('blur', save);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { cancelled = true; input.blur(); }
      });
    }

    function renderGallery() {
      galleryImages = allFiles.filter(function (f) { return f.mimeType && f.mimeType.startsWith('image/'); });
      var el = document.getElementById('galleryGrid');
      if (!galleryImages.length) {
        el.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="emoji">🖼</div><p>No images yet</p></div>';
        return;
      }
      el.innerHTML = galleryImages.map(function (f, i) {
        return '<div class="gallery-thumb" data-action="open-image" data-idx="' + i + '">'
          + '<img src="' + dlUrl(f.id) + '" alt="' + esc(f.originalName) + '" loading="lazy" decoding="async" />'
          + '</div>';
      }).join('');
    }

    function openLightbox(idx) {
      if (!galleryImages.length) return;
      lbIndex = idx;
      document.getElementById('lb-img').src = dlUrl(galleryImages[idx].id);
      document.getElementById('lightbox').classList.add('open');
    }

    async function loadTexts() {
      try {
        var res = await getJSON('/api/texts');
        if (!Array.isArray(res)) return;
        var changed = JSON.stringify(res) !== JSON.stringify(allTexts);
        allTexts = res;
        if (changed) renderTexts();
      } catch (e) {}
    }

    function renderTexts() {
      var el = document.getElementById('textList');
      if (!allTexts.length) {
        el.innerHTML = '<div class="empty-state"><div class="emoji">💬</div><p>No messages yet</p></div>';
        return;
      }
      textStore = {};
      el.innerHTML = allTexts.map(function (t) {
        textStore[t.id] = t.content;
        return '<div class="text-item">'
          + '<div class="text-header">'
          + '<div class="text-from">' + esc(t.sentByName) + (t.sentBy === ME ? ' (You)' : '') + '</div>'
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
      var input = document.getElementById('textInput');
      var content = input.value.trim();
      if (!content) return;
      var targetDevice = document.getElementById('textSendTo').value;
      var r = await api('POST', '/api/texts', { deviceName: NAME, content: content, targetDevice: targetDevice });
      if (!r.ok) { toast(r.error || 'Could not send', 'err'); return; }
      input.value = '';
      toast('Sent!');
      allTexts = [];
      loadTexts();
    }

    async function deleteText(id) {
      await api('DELETE', '/api/texts/' + encodeURIComponent(id));
      allTexts = [];
      loadTexts();
    }

    async function loadHistory() {
      try {
        var h = await getJSON('/api/history');
        var el = document.getElementById('histList');
        if (!Array.isArray(h) || !h.length) {
          el.innerHTML = '<div class="empty-state"><div class="emoji">📜</div><p>No history yet</p></div>';
          return;
        }
        el.innerHTML = h.map(function (e) {
          return '<div class="hist-item">'
            + '<div class="hist-icon">' + histIcon(e.type) + '</div>'
            + '<div class="hist-info">'
            + '<div class="hist-desc">' + esc(e.desc) + '</div>'
            + '<div class="hist-who">by ' + esc(e.who) + '</div>'
            + '</div>'
            + '<div class="hist-ts">' + fmtTime(e.ts) + '</div>'
            + '</div>';
        }).join('');
      } catch (e) {}
    }

    function triggerDownload(id) {
      var a = document.createElement('a');
      a.href = dlUrl(id);
      a.download = '';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); }, 1000);
    }

    function closeAcceptModal() { document.getElementById('acceptModal').classList.remove('open'); }

    function showNextModal() {
      if (!pendingQueue.length) { processingModal = false; return; }
      processingModal = true;
      var tr = pendingQueue[0];
      document.getElementById('acceptFrom').textContent = 'From: ' + tr.fromName;
      document.getElementById('acceptFiles').innerHTML = tr.files.map(function (f) {
        return '<li><span>' + esc(f.name) + '</span><span>' + fmtSize(f.size) + '</span></li>';
      }).join('');
      document.getElementById('acceptModal').classList.add('open');

      document.getElementById('acceptBtn').onclick = async function () {
        closeAcceptModal();
        pendingQueue.shift();
        handledTransfers[tr.transferId] = true;
        var res = await api('POST', '/api/accept/' + encodeURIComponent(tr.transferId));
        if (res.ok && res.fileIds && res.fileIds.length) {
          toast('Accepted ' + res.fileIds.length + ' file(s)!');
          for (var i = 0; i < res.fileIds.length; i++) {
            await new Promise(function (resolve) { setTimeout(resolve, i === 0 ? 100 : 500); });
            triggerDownload(res.fileIds[i]);
          }
          loadFiles();
        } else {
          toast('Those files are no longer available', 'err');
        }
        setTimeout(showNextModal, 400);
      };

      document.getElementById('declineBtn').onclick = async function () {
        closeAcceptModal();
        pendingQueue.shift();
        handledTransfers[tr.transferId] = true;
        await api('POST', '/api/decline/' + encodeURIComponent(tr.transferId));
        toast('Declined');
        setTimeout(showNextModal, 400);
      };
    }

    document.body.addEventListener('click', function (e) {
      var target = e.target.closest('[data-action]');
      if (!target) return;
      var action = target.dataset.action;
      var id = target.dataset.id;

      switch (action) {
        case 'set-name': {
          var v = document.getElementById('nameInput').value.trim();
          if (!v) return;
          NAME = v.slice(0, 30);
          localStorage.setItem('orbit_name', NAME);
          startApp();
          break;
        }
        case 'toggle-theme': {
          var dark = document.documentElement.dataset.theme === 'dark';
          document.documentElement.dataset.theme = dark ? 'light' : 'dark';
          localStorage.setItem('orbit_theme', dark ? 'light' : 'dark');
          document.getElementById('themeBtn').textContent = dark ? '🌙' : '☀️';
          break;
        }
        case 'toggle-qr':
          document.getElementById('sidebar').classList.toggle('open');
          break;
        case 'switch-tab':
          switchTab(target.dataset.tab);
          break;
        case 'trigger-upload':
          document.getElementById('fileInput').click();
          break;
        case 'cancel-upload':
          if (uploadXHR) uploadXHR.abort();
          break;
        case 'delete-file':
          deleteFile(id);
          break;
        case 'download-file':
          triggerDownload(id);
          break;
        case 'rename-file':
          startRename(id);
          break;
        case 'open-image':
          openLightbox(parseInt(target.dataset.idx, 10));
          break;
        case 'delete-text':
          deleteText(id);
          break;
        case 'copy-text': {
          var txt = textStore[id] || '';
          var done = function () { toast('Copied!'); };
          var fallback = function () {
            try {
              var ta = document.createElement('textarea');
              ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
              document.body.appendChild(ta); ta.select();
              var ok = document.execCommand('copy');
              ta.remove();
              if (ok) done(); else toast('Copy failed', 'err');
            } catch (err) { toast('Copy failed', 'err'); }
          };
          // navigator.clipboard is unavailable on plain http:// LAN pages, so fall back.
          if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done).catch(fallback);
          else fallback();
          break;
        }
        case 'send-text':
          sendText();
          break;
      }
    });

    document.getElementById('nameInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') document.querySelector('[data-action="set-name"]').click();
    });

    function lbShow() { document.getElementById('lb-img').src = dlUrl(galleryImages[lbIndex].id); }
    document.getElementById('lb-close').addEventListener('click', function (e) { e.stopPropagation(); document.getElementById('lightbox').classList.remove('open'); });
    document.getElementById('lightbox').addEventListener('click', function () { document.getElementById('lightbox').classList.remove('open'); });
    document.getElementById('lb-prev').addEventListener('click', function (e) {
      e.stopPropagation();
      if (!galleryImages.length) return;
      lbIndex = (lbIndex - 1 + galleryImages.length) % galleryImages.length;
      lbShow();
    });
    document.getElementById('lb-next').addEventListener('click', function (e) {
      e.stopPropagation();
      if (!galleryImages.length) return;
      lbIndex = (lbIndex + 1) % galleryImages.length;
      lbShow();
    });

    document.addEventListener('keydown', function (e) {
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

app.get('/', async (req, res, next) => {
  try {
    if (!isAuthed(req)) return res.type('html').send(loginHTML());
    if (!_html) _html = await buildHTML();
    res.type('html').send(_html);
  } catch (err) {
    next(err);
  }
});

/* ───────────── Errors ───────────── */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File too large (max ${Math.round(MAX_FILE / 1048576)} MB)`
        : err.code === 'LIMIT_FILE_COUNT'
        ? 'Too many files (max 20 at once)'
        : err.message;
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
  }
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Request too large' });
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

/* ───────────── Start / shutdown ───────────── */
const server = app.listen(PORT, HOST, () => {
  console.log('\n🪐  Orbit is live!');
  console.log('   PC:     http://localhost:' + PORT);
  console.log('   LAN:    ' + BASE_URL);
  if (LAN.length > 1) {
    console.log('   Other addresses (use if the QR does not work):');
    LAN.slice(1).forEach((i) => console.log(`     http://${i.address}:${PORT}  (${i.name})`));
  }
  console.log(PIN ? '   🔒 PIN protection: ON\n' : '   ⚠️  No PIN set — anyone on this network can use Orbit (set ORBIT_PIN)\n');
});

// Node's default 5-minute request timeout would kill large uploads on slow Wi-Fi.
server.requestTimeout = 0;
server.timeout = 0;
server.headersTimeout = 60_000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use. Close the other app or run with PORT=<another port>.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

// Remove every file Orbit stored (scans the folder, so nothing is missed).
function wipeShared() {
  try {
    for (const f of fs.readdirSync(SHARE)) {
      if (STORED_RE.test(f)) fs.rmSync(path.join(SHARE, f), { force: true });
    }
  } catch {}
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\nShutting down Orbit…');
  timers.forEach(clearInterval);
  wipeShared();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach((sig) => {
  try {
    process.on(sig, shutdown); // SIGHUP/SIGBREAK fire when a Windows console window is closed
  } catch {}
});
process.on('exit', wipeShared); // last-resort cleanup on any normal exit path
process.on('uncaughtException', (err) => {
  console.error(err);
  wipeShared();
  process.exit(1);
});
