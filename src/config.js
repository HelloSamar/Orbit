'use strict';

const path = require('path');

const IS_PKG = !!process.pkg; // running as a packaged .exe / binary
const APP_DIR = path.join(__dirname, '..'); // read-only assets (also valid inside a pkg snapshot)
const DATA_ROOT = IS_PKG ? path.dirname(process.execPath) : APP_DIR; // writable location

const flag = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

const cfg = {
  IS_PKG,
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  // 0 = unlimited. By default there is no per-file or total cap; Orbit only refuses an
  // upload when the disk itself does not have enough free space.
  MAX_FILE: (Number(process.env.ORBIT_MAX_FILE_MB) || 0) * 1024 * 1024,
  STORAGE_LIMIT: (Number(process.env.ORBIT_STORAGE_GB) || 0) * 1024 * 1024 * 1024,
  FILE_TTL: (Number(process.env.ORBIT_TTL_MIN) || 60) * 60_000,
  HTTPS: flag(process.env.ORBIT_HTTPS) || !!(process.env.ORBIT_CERT && process.env.ORBIT_KEY),
  CERT: process.env.ORBIT_CERT || '',
  KEY: process.env.ORBIT_KEY || '',
  OPEN: flag(process.env.ORBIT_OPEN) || IS_PKG,
  PUBLIC_HOST: process.env.ORBIT_HOST || '',
  PIN: '', // resolved at startup (see src/pin.js)
  SHARE: path.join(DATA_ROOT, 'shared'),
  CERT_DIR: path.join(DATA_ROOT, 'certs'),
  PUBLIC: path.join(APP_DIR, 'public'),
  STORED_RE: /^[0-9a-f]{12}_/,
  VALID_ID: /^[A-Za-z0-9_-]{8,64}$/
};

cfg.SCHEME = cfg.HTTPS ? 'https' : 'http';

module.exports = cfg;
