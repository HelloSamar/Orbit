'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');

const uid = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const pubOf = (secret) =>
  crypto.createHash('sha256').update('orbit:' + secret).digest('hex').slice(0, 12);

function cleanName(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .trim()
    .slice(0, 200);
}

function cleanLabel(v, fallback = 'Unknown') {
  return cleanName(v || '').slice(0, 30) || fallback;
}

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

function freeDisk() {
  try {
    const st = fs.statfsSync(cfg.SHARE); // Node 18.15+
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Infinity;
  }
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

module.exports = { uid, now, sha, pubOf, cleanName, cleanLabel, safeFileName, displayName, freeDisk, lanAddresses };
