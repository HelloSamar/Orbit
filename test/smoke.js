'use strict';
// Starts Orbit on a random port and exercises the main flows. Requires Node 18+.
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');

const PORT = 4000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const A = 'deviceAAAA1111aaaa';
const B = 'deviceBBBB2222bbbb';
const C = 'deviceCCCC3333cccc';

const H = (id) => ({ 'Content-Type': 'application/json', 'X-Device-Id': id });
const post = (u, id, body) => fetch(BASE + u, { method: 'POST', headers: H(id), body: JSON.stringify(body || {}) });
const get = (u, id) => fetch(BASE + u, { headers: { 'X-Device-Id': id } });

async function upload(id, name, content, target) {
  const fd = new FormData();
  fd.append('targetDevice', target || 'everyone');
  fd.append('files', new Blob([content]), name);
  return fetch(BASE + '/api/upload', { method: 'POST', headers: { 'X-Device-Id': id }, body: fd });
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
  });
  try {
    await waitUp();
    const hbA = await (await post('/api/heartbeat', A, { deviceName: 'A' })).json();
    const hbB = await (await post('/api/heartbeat', B, { deviceName: 'B' })).json();
    await post('/api/heartbeat', C, { deviceName: 'C' });
    assert(hbA.ok && hbA.me && hbB.me && hbA.me !== A, 'public id differs from secret');
    assert(!JSON.stringify(hbB.devices).includes(A), 'secret id never leaked');

    // public upload
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

    console.log('✅ smoke tests passed');
  } catch (e) {
    console.error('❌', e);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
})();
