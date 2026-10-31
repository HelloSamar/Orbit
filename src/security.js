'use strict';

const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const { now, sha } = require('./utils');

const AUTH_TOKEN = crypto.randomBytes(24).toString('hex');

// Small in-memory rate limiter (per IP).
function rateLimit(limit, windowMs) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
  }, windowMs);
  sweep.unref();
  return (req, res, next) => {
    const t = now();
    let e = hits.get(req.ip);
    if (!e || e.reset < t) e = { count: 0, reset: t + windowMs };
    e.count++;
    hits.set(req.ip, e);
    if (e.count > limit) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}

function isAuthed(req) {
  if (!cfg.PIN) return true;
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('orbit_auth='));
  if (!cookie) return false;
  return crypto.timingSafeEqual(sha(cookie.slice(11)), sha(AUTH_TOKEN));
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

function applySecurity(app) {
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cache-Control', 'no-store');
    if (cfg.HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
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

  app.use('/api', rateLimit(1500, 60_000));
  app.use(express.json({ limit: '1mb' }));

  app.post('/login', rateLimit(10, 60_000), (req, res) => {
    const pin = String((req.body && req.body.pin) || '');
    if (!cfg.PIN || !crypto.timingSafeEqual(sha(pin), sha(cfg.PIN))) return res.status(401).json({ ok: false });
    const secure = cfg.HTTPS ? '; Secure' : '';
    res.setHeader('Set-Cookie', `orbit_auth=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure}`);
    res.json({ ok: true });
  });

  app.use('/api', (req, res, next) => {
    if (isAuthed(req)) return next();
    res.status(401).json({ error: 'PIN required' });
  });
}

// Resolve the calling device's secret id (header preferred; query for downloads).
function who(req) {
  const id = String(req.get('x-device-id') || req.query.deviceId || '');
  return cfg.VALID_ID.test(id) ? id : null;
}

function needDevice(req, res, next) {
  const id = who(req);
  if (!id) return res.status(400).json({ error: 'Missing or invalid device id' });
  req.devId = id;
  req.me = require('./utils').pubOf(id);
  next();
}

module.exports = { applySecurity, isAuthed, who, needDevice };
