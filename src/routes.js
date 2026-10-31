'use strict';

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cfg = require('./config');
const S = require('./store');
const thumbs = require('./thumbs');
const { needDevice, who } = require('./security');
const { uid, now, pubOf, cleanName, cleanLabel, safeFileName, displayName, freeDisk } = require('./utils');

const upload = multer({
  storage: multer.diskStorage({
    destination: cfg.SHARE,
    filename: (req, file, cb) => cb(null, `${uid()}_${safeFileName(file.originalname)}`)
  }),
  limits: { ...(cfg.MAX_FILE ? { fileSize: cfg.MAX_FILE } : {}), files: 20 }
});

function uploadGate(req, res, next) {
  const id = who(req);
  if (!id || !S.devices[id]) return res.status(401).json({ error: 'Unknown device — reload the page' });
  const len = Number(req.headers['content-length']) || 0;
  if (cfg.STORAGE_LIMIT && S.storageUsed() + len > cfg.STORAGE_LIMIT) {
    return res.status(507).json({ error: 'Orbit storage limit reached' });
  }
  if (len > freeDisk() - 200 * 1024 * 1024) {
    return res.status(507).json({ error: 'Not enough free disk space on the host computer' });
  }
  req.devId = id;
  req.me = pubOf(id);
  next();
}

function register(app) {
  app.post('/api/heartbeat', needDevice, (req, res) => {
    S.devices[req.devId] = { name: cleanLabel(req.body && req.body.deviceName), pub: req.me, lastSeen: now() };
    const free = freeDisk();
    res.json({
      ok: true,
      me: req.me,
      devices: S.liveDevices(),
      pending: S.pending[req.me] || [],
      thumbs: thumbs.available(),
      storage: { used: S.storageUsed(), limit: cfg.STORAGE_LIMIT, free: free === Infinity ? 0 : free }
    });
  });

  app.get('/api/files', needDevice, (req, res) => {
    res.json(S.fileStore.filter((f) => S.canSeeFile(f, req.me)).map(S.publicFile));
  });

  app.post('/api/upload', uploadGate, upload.array('files', 20), (req, res) => {
    const files = req.files || [];
    const fail = (code, error) => {
      files.forEach((f) => S.removeStored(f.filename));
      return res.status(code).json({ error });
    };

    if (!files.length) return fail(400, 'No files');

    const target = String((req.body && req.body.targetDevice) || 'everyone');
    if (target !== 'everyone') {
      if (target === req.me) return fail(400, 'You cannot send files to yourself');
      if (!S.isKnownPub(target)) return fail(400, 'Target device is not online');
    }

    const uploaderName = S.devices[req.devId].name;
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

    S.fileStore.push(...newFiles);

    if (target !== 'everyone') {
      (S.pending[target] = S.pending[target] || []).push({
        transferId: uid(),
        files: newFiles.map((f) => ({ id: f.id, name: f.originalName, size: f.size })),
        fromId: req.me,
        fromName: uploaderName
      });
    }

    S.log('upload', `${newFiles.length} file(s) sent`, uploaderName, target === 'everyone' ? [] : [req.me, target]);
    res.json({ ok: true, files: newFiles.map(S.publicFile) });
  });

  app.get('/api/download/:id', needDevice, (req, res) => {
    const file = S.fileStore.find((item) => item.id === req.params.id);
    if (!file) return res.status(404).end();
    if (!S.canSeeFile(file, req.me)) return res.status(403).end();

    const fp = path.join(cfg.SHARE, file.storedName);
    if (!fs.existsSync(fp)) return res.status(404).end();

    res.setHeader('Cache-Control', 'no-store');
    res.download(fp, file.originalName);
  });

  // Small preview image for the gallery (generated in memory, never stored on disk).
  app.get('/api/thumb/:id', needDevice, async (req, res) => {
    const file = S.fileStore.find((item) => item.id === req.params.id);
    if (!file) return res.status(404).end();
    if (!S.canSeeFile(file, req.me)) return res.status(403).end();
    if (!thumbs.available()) return res.status(501).end();
    if (!thumbs.supports(file.mimeType)) return res.status(415).end();

    const fp = path.join(cfg.SHARE, file.storedName);
    if (!fs.existsSync(fp)) return res.status(404).end();
    try {
      const buf = await thumbs.make(file.id, fp);
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch {
      res.status(415).end();
    }
  });

  app.delete('/api/files/:id', needDevice, (req, res) => {
    const index = S.fileStore.findIndex((f) => f.id === req.params.id);
    if (index === -1) return res.status(404).end();
    if (!S.canManageFile(S.fileStore[index], req.me)) return res.status(403).end();
    S.dropFile(index);
    res.json({ ok: true });
  });

  app.patch('/api/files/:id', needDevice, (req, res) => {
    const file = S.fileStore.find((item) => item.id === req.params.id);
    if (!file) return res.status(404).end();
    if (!S.canManageFile(file, req.me)) return res.status(403).end();

    const next = cleanName((req.body && req.body.name) || '');
    if (!next) return res.status(400).json({ error: 'Invalid name' });
    file.originalName = next;
    res.json({ ok: true });
  });

  function takeTransfer(req, res) {
    const list = S.pending[req.me] || [];
    const index = list.findIndex((t) => t.transferId === req.params.tid);
    if (index === -1) {
      res.status(404).end();
      return null;
    }
    const [transfer] = list.splice(index, 1);
    if (!list.length) delete S.pending[req.me];
    return transfer;
  }

  const nameOf = (req) => (S.devices[req.devId] && S.devices[req.devId].name) || 'Unknown';

  app.post('/api/accept/:tid', needDevice, (req, res) => {
    const transfer = takeTransfer(req, res);
    if (!transfer) return;

    const ids = [];
    for (const tf of transfer.files) {
      const file = S.fileStore.find((item) => item.id === tf.id);
      if (file) {
        file.accepted = true;
        ids.push(file.id);
      }
    }
    S.log('accept', `Accepted from ${transfer.fromName}`, nameOf(req), [req.me, transfer.fromId]);
    res.json({ ok: true, fileIds: ids });
  });

  app.post('/api/decline/:tid', needDevice, (req, res) => {
    const transfer = takeTransfer(req, res);
    if (!transfer) return;

    for (const tf of transfer.files) {
      const i = S.fileStore.findIndex((item) => item.id === tf.id);
      if (i !== -1) S.dropFile(i);
    }
    S.log('decline', `Declined from ${transfer.fromName}`, nameOf(req), [req.me, transfer.fromId]);
    res.json({ ok: true });
  });

  app.get('/api/texts', needDevice, (req, res) => {
    res.json(S.textStore.filter((t) => S.canSeeText(t, req.me)));
  });

  app.post('/api/texts', needDevice, (req, res) => {
    const { content, targetDevice, deviceName } = req.body || {};
    const text = String(content || '').trim();
    if (!text) return res.status(400).json({ error: 'Empty' });
    if (text.length > 20_000) return res.status(413).json({ error: 'Text too long (max 20,000 characters)' });

    const target = String(targetDevice || 'everyone');
    if (target !== 'everyone' && (target === req.me || !S.isKnownPub(target))) {
      return res.status(400).json({ error: 'Invalid target device' });
    }

    const entry = {
      id: uid(),
      content: text,
      sentBy: req.me,
      sentByName: (S.devices[req.devId] && S.devices[req.devId].name) || cleanLabel(deviceName),
      targetDevice: target,
      sentAt: now()
    };

    S.textStore.unshift(entry);
    if (S.textStore.length > 50) S.textStore.length = 50;
    S.log('text', 'Text shared', entry.sentByName, target === 'everyone' ? [] : [req.me, target]);
    res.json({ ok: true, text: entry });
  });

  app.delete('/api/texts/:id', needDevice, (req, res) => {
    const index = S.textStore.findIndex((t) => t.id === req.params.id);
    if (index === -1) return res.status(404).end();
    if (!S.canManageText(S.textStore[index], req.me)) return res.status(403).end();
    S.textStore.splice(index, 1);
    res.json({ ok: true });
  });

  app.get('/api/history', needDevice, (req, res) => {
    res.json(
      S.histLog
        .filter((h) => !h.parties.length || h.parties.includes(req.me))
        .map(({ id, type, desc, who: w, ts }) => ({ id, type, desc, who: w, ts }))
    );
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Errors (multer limits, bad JSON, ...)
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? `File too large (max ${Math.round(cfg.MAX_FILE / 1048576)} MB)`
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
}

module.exports = { register };
