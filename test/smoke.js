'use strict';
// Starts Orbit on random ports and exercises the main flows. Requires Node 18+.
const { spawn } = require('child_process');
const assert = require('assert');
const https = require('https');
const path = require('path');

const A = 'deviceAAAA1111aaaa';
const B = 'deviceBBBB2222bbbb';
const C = 'deviceCCCC3333cccc';
// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const H = (id) => ({ 'Content-Type': 'application/json', 'X-Device-Id': id });

function startServer(env) {
  const port = 4000 + Math.floor(Math.random() * 3000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), ORBIT_PIN: '0', ...env },
    stdio: ['ignore', 'pipe', 'ignore']
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  return { port, child, out: () => out };
}

async function waitFor(fn) {
  for (let i = 0; i < 80; i++) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function testPlain() {
  const { port, child } = startServer({});
  const BASE = `http://127.0.0.1:${port}`;
  const post = (u, id, body) => fetch(BASE + u, { method: 'POST', headers: H(id), body: JSON.stringify(body || {}) });
  const get = (u, id) => fetch(BASE + u, { headers: { 'X-Device-Id': id } });
  async function upload(id, name, content, target, type) {
    const fd = new FormData();
    fd.append('targetDevice', target || 'everyone');
    fd.append('files', new Blob([content], { type: type || 'application/octet-stream' }), name);
    return fetch(BASE + '/api/upload', { method: 'POST', headers: { 'X-Device-Id': id }, body: fd });
  }

  try {
    await waitFor(async () => (await fetch(BASE + '/')).ok);

    // page + static assets + CSP
    const page = await fetch(BASE + '/');
    assert((await page.text()).includes('/static/app.js'), 'index references app.js');
    assert(page.headers.get('content-security-policy').includes("script-src 'self'"), 'CSP set');
    assert.strictEqual((await fetch(BASE + '/static/app.js')).status, 200);
    assert.strictEqual((await fetch(BASE + '/static/style.css')).status, 200);

    const hbA = await (await post('/api/heartbeat', A, { deviceName: 'A' })).json();
    const hbB = await (await post('/api/heartbeat', B, { deviceName: 'B' })).json();
    await post('/api/heartbeat', C, { deviceName: 'C' });
    assert(hbA.ok && hbA.me && hbB.me && hbA.me !== A, 'public id differs from secret');
    assert(!JSON.stringify(hbB.devices).includes(A), 'secret id never leaked');

    // public upload, name sanitised, download
    let r = await upload(A, '../evil name.txt', 'hello');
    assert.strictEqual(r.status, 200);
    let files = await (await get('/api/files', B)).json();
    assert.strictEqual(files.length, 1);
    assert(!files[0].originalName.includes('/'), 'name sanitized');
    r = await get('/api/download/' + files[0].id + '?deviceId=' + B, B);
    assert.strictEqual(await r.text(), 'hello');

    // only uploader may delete
    assert.strictEqual((await fetch(BASE + '/api/files/' + files[0].id, { method: 'DELETE', headers: H(B) })).status, 403);
    assert.strictEqual((await fetch(BASE + '/api/files/' + files[0].id, { method: 'DELETE', headers: H(A) })).status, 200);

    // private transfer: A -> B, C cannot see or hijack
    r = await upload(A, 'secret.txt', 'top secret', hbB.me);
    assert.strictEqual(r.status, 200);
    const fid = (await r.json()).files[0].id;
    assert.strictEqual((await (await get('/api/files', C)).json()).length, 0);
    assert.strictEqual((await get('/api/download/' + fid + '?deviceId=' + C, C)).status, 403);
    assert.strictEqual((await get('/api/download/' + fid + '?deviceId=' + B, B)).status, 403, 'blocked until accepted');
    const pend = (await (await post('/api/heartbeat', B, { deviceName: 'B' })).json()).pending;
    assert.strictEqual(pend.length, 1);
    assert.strictEqual((await post('/api/accept/' + pend[0].transferId, C)).status, 404, 'C cannot accept B transfer');
    assert.strictEqual((await post('/api/accept/' + pend[0].transferId, B)).status, 200);
    assert.strictEqual(await (await get('/api/download/' + fid + '?deviceId=' + B, B)).text(), 'top secret');

    // thumbnails: 200 webp when sharp is installed, 501 when it is not; never leaks to others
    r = await upload(A, 'pixel.png', PNG, 'everyone', 'image/png');
    const img = (await r.json()).files[0];
    const t = await get('/api/thumb/' + img.id + '?deviceId=' + B, B);
    assert([200, 501].includes(t.status), 'thumb status ' + t.status);
    if (t.status === 200) assert.strictEqual(t.headers.get('content-type'), 'image/webp');
    const priv = (await (await upload(A, 'p2.png', PNG, hbB.me, 'image/png')).json()).files[0];
    assert.strictEqual((await get('/api/thumb/' + priv.id + '?deviceId=' + C, C)).status, 403);
    console.log('   thumbnails:', t.status === 200 ? 'sharp ON' : 'sharp not installed (fallback)');

    // texts
    r = await post('/api/texts', A, { content: 'hi', targetDevice: 'everyone' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await (await get('/api/texts', B)).json()).length, 1);
    assert.strictEqual((await post('/api/texts', A, { content: 'x', targetDevice: 'nope' })).status, 400);

    // bad / unknown device
    assert.strictEqual((await get('/api/files', 'x')).status, 400);
    assert.strictEqual((await upload('unknownDevice123', 'a.txt', 'a')).status, 401);

    // cross-origin write blocked
    r = await fetch(BASE + '/api/texts', { method: 'POST', headers: { ...H(A), Origin: 'http://evil.example' }, body: '{"content":"x"}' });
    assert.strictEqual(r.status, 403);
  } finally {
    child.kill();
  }
}

async function testRandomPin() {
  const { port, child, out } = startServer({ ORBIT_PIN: 'random' });
  const BASE = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await fetch(BASE + '/')).ok);
    const pin = (out().match(/PIN:\s+(\d{6})/) || [])[1];
    assert(pin, 'random 6-digit PIN printed');
    assert.strictEqual((await fetch(BASE + '/api/files', { headers: { 'X-Device-Id': A } })).status, 401);
    assert((await (await fetch(BASE + '/')).text()).includes('login.js'), 'login page shown');
    const bad = await fetch(BASE + '/login', { method: 'POST', headers: H(A), body: JSON.stringify({ pin: '000000' === pin ? '111111' : '000000' }) });
    assert.strictEqual(bad.status, 401);
    const ok = await fetch(BASE + '/login', { method: 'POST', headers: H(A), body: JSON.stringify({ pin }) });
    assert.strictEqual(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const r = await fetch(BASE + '/api/files', { headers: { 'X-Device-Id': A, Cookie: cookie } });
    assert.strictEqual(r.status, 200);
  } finally {
    child.kill();
  }
}

async function testHttps() {
  const { port, child } = startServer({ ORBIT_HTTPS: '1' });
  try {
    const get = () =>
      new Promise((resolve, reject) => {
        https
          .get({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, (res) => {
            res.resume();
            resolve(res);
          })
          .on('error', reject);
      });
    let res;
    await waitFor(async () => (res = await get()));
    assert.strictEqual(res.statusCode, 200);
    assert(res.headers['strict-transport-security'], 'HSTS set');
  } finally {
    child.kill();
  }
}

(async () => {
  try {
    await testPlain();
    await testRandomPin();
    await testHttps();
    console.log('✅ smoke tests passed');
  } catch (e) {
    console.error('❌', e);
    process.exitCode = 1;
  }
})();
