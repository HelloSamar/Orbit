'use strict';

// Optional server-side thumbnails. Uses `sharp` when it is installed; otherwise the gallery
// quietly falls back to the original image. Thumbnails live in memory only (nothing is
// written to disk), so they disappear when Orbit stops.

let sharp = null;
try {
  // Built from parts so single-file packagers (pkg) do not try to bundle the native module.
  sharp = require(['sh', 'arp'].join(''));
  sharp.concurrency(1);
} catch {
  sharp = null;
}

const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_JOBS = 2;
const OK_TYPES = /^image\/(jpeg|png|webp|gif|avif|tiff)$/i;

const cache = new Map(); // fileId -> Buffer (insertion order = age)
let cacheBytes = 0;
let running = 0;
const waiting = [];

const available = () => !!sharp;
const supports = (mime) => OK_TYPES.test(String(mime || ''));

function drop(id) {
  const buf = cache.get(id);
  if (buf) {
    cacheBytes -= buf.length;
    cache.delete(id);
  }
}

function remember(id, buf) {
  cache.set(id, buf);
  cacheBytes += buf.length;
  for (const [k] of cache) {
    if (cacheBytes <= MAX_CACHE_BYTES) break;
    drop(k);
  }
}

function slot() {
  return new Promise((resolve) => {
    if (running < MAX_JOBS) {
      running++;
      resolve();
    } else waiting.push(resolve);
  });
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

async function make(id, filePath, size = 240) {
  const hit = cache.get(id);
  if (hit) return hit;
  await slot();
  try {
    const buf = await sharp(filePath, { sequentialRead: true })
      .rotate()
      .resize(size, size, { fit: 'cover' })
      .webp({ quality: 70 })
      .toBuffer();
    remember(id, buf);
    return buf;
  } finally {
    release();
  }
}

function clear() {
  cache.clear();
  cacheBytes = 0;
}

module.exports = { available, supports, make, drop, clear };
