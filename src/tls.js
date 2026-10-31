'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { lanAddresses } = require('./utils');

/**
 * TLS options for HTTPS mode.
 *  - ORBIT_CERT + ORBIT_KEY: use your own certificate files.
 *  - otherwise: generate a self-signed certificate (kept in ./certs and reused while valid).
 */
async function getTlsOptions() {
  if (cfg.CERT && cfg.KEY) {
    return { cert: fs.readFileSync(cfg.CERT), key: fs.readFileSync(cfg.KEY) };
  }

  const ips = lanAddresses().map((a) => a.address);
  if (cfg.PUBLIC_HOST && /^\d+\.\d+\.\d+\.\d+$/.test(cfg.PUBLIC_HOST)) ips.push(cfg.PUBLIC_HOST);
  const want = [...new Set(ips)].sort();

  const certFile = path.join(cfg.CERT_DIR, 'orbit-cert.pem');
  const keyFile = path.join(cfg.CERT_DIR, 'orbit-key.pem');
  const metaFile = path.join(cfg.CERT_DIR, 'orbit-meta.json');

  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const covers = want.every((ip) => meta.ips.includes(ip));
    if (covers && meta.expires - Date.now() > 30 * 86_400_000) {
      return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    }
  } catch {}

  const selfsigned = require('selfsigned');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...want.map((ip) => ({ type: 7, ip }))
  ];
  const days = 365;
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Orbit' }], {
    days,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }]
  });

  fs.mkdirSync(cfg.CERT_DIR, { recursive: true });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  fs.writeFileSync(metaFile, JSON.stringify({ ips: want, expires: Date.now() + days * 86_400_000 }));
  return { cert: pems.cert, key: pems.private };
}

module.exports = { getTlsOptions };
