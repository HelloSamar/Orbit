'use strict';
async function go() {
  var r = await fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: document.getElementById('pin').value })
  });
  if (r.ok) location.reload();
  else document.getElementById('err').textContent = r.status === 429 ? 'Too many attempts, wait a minute' : 'Wrong PIN';
}
document.getElementById('go').onclick = go;
document.getElementById('pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
document.getElementById('pin').focus();
