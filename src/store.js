'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const thumbs = require('./thumbs');
const { uid, now } = require('./utils');

// All state lives in memory only. Nothing here is ever written to a log or database.
const devices = Object.create(null); // secretId -> { name, pub, lastSeen }
const pending = Object.create(null); // pubId -> [transfer]
const fileStore = [];
const textStore = [];
const histLog = [];

const storageUsed = () => fileStore.reduce((sum, f) => sum + f.size, 0);

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
    fs.unlinkSync(path.join(cfg.SHARE, name));
  } catch {}
}

// Remove a file from the store, disk, thumbnail cache, and any pending transfer using it.
function dropFile(index) {
  const [file] = fileStore.splice(index, 1);
  removeStored(file.storedName);
  thumbs.drop(file.id);
  for (const key of Object.keys(pending)) {
    for (const tr of pending[key]) tr.files = tr.files.filter((f) => f.id !== file.id);
    pending[key] = pending[key].filter((tr) => tr.files.length > 0);
    if (!pending[key].length) delete pending[key];
  }
}

function pruneExpiredFiles() {
  const cut = now() - cfg.FILE_TTL;
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

// Remove every file Orbit stored (scans the folder, so nothing is missed).
function wipeShared() {
  try {
    for (const f of fs.readdirSync(cfg.SHARE)) {
      if (cfg.STORED_RE.test(f)) fs.rmSync(path.join(cfg.SHARE, f), { force: true });
    }
  } catch {}
  thumbs.clear();
}

let timers = [];
function startTimers() {
  timers = [setInterval(pruneExpiredFiles, 60_000), setInterval(pruneStaleDevices, 15_000)];
  timers.forEach((t) => t.unref());
}
const stopTimers = () => timers.forEach(clearInterval);

module.exports = {
  devices, pending, fileStore, textStore, histLog,
  storageUsed, liveDevices, isKnownPub, log,
  canSeeFile, canManageFile, canSeeText, canManageText, publicFile,
  removeStored, dropFile, wipeShared, startTimers, stopTimers
};
