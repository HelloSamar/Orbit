'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { spawn } = require('child_process');

const cfg = require('./src/config');
const S = require('./src/store');
const { applySecurity, isAuthed } = require('./src/security');
const routes = require('./src/routes');
const pages = require('./src/pages');
const { resolvePin } = require('./src/pin');
const { lanAddresses } = require('./src/utils');

function openBrowser(url) {
  try {
    const [cmd, args] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {}
}

async function main() {
  fs.mkdirSync(cfg.SHARE, { recursive: true });
  S.wipeShared(); // leftovers from a previous run are orphans (the file index lives in memory)

  await resolvePin();

  const LAN = lanAddresses();
  const LOCAL_IP = cfg.PUBLIC_HOST || (LAN[0] && LAN[0].address) || 'localhost';
  const BASE_URL = `${cfg.SCHEME}://${LOCAL_IP}:${cfg.PORT}`;

  const app = express();
  app.disable('x-powered-by');
  applySecurity(app);

  app.use('/static', express.static(cfg.PUBLIC, { index: false, maxAge: 0 }));

  app.get('/', async (req, res, next) => {
    try {
      if (!isAuthed(req)) return res.type('html').send(pages.loginHTML());
      res.type('html').send(await pages.indexHTML(BASE_URL));
    } catch (err) {
      next(err);
    }
  });

  routes.register(app);
  S.startTimers();

  const server = cfg.HTTPS
    ? https.createServer(await require('./src/tls').getTlsOptions(), app)
    : http.createServer(app);

  // Node's default 5-minute request timeout would kill large uploads on slow Wi-Fi.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 60_000;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${cfg.PORT} is already in use. Close the other app or run with PORT=<another port>.\n`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  server.listen(cfg.PORT, cfg.HOST, () => {
    console.log('\n🪐  Orbit is live!  (v' + require('./package.json').version + ')');
    console.log(`   PC:     ${cfg.SCHEME}://localhost:${cfg.PORT}`);
    console.log('   LAN:    ' + BASE_URL);
    if (LAN.length > 1) {
      console.log('   Other addresses (use if the QR does not work):');
      LAN.slice(1).forEach((i) => console.log(`     ${cfg.SCHEME}://${i.address}:${cfg.PORT}  (${i.name})`));
    }
    if (cfg.HTTPS && !(cfg.CERT && cfg.KEY)) {
      console.log('   🔐 HTTPS: ON (self-signed) — accept the browser warning once on each device');
    }
    if (cfg.PIN) console.log(`   🔒 PIN:  ${cfg.PIN}\n`);
    else console.log('   ⚠️  No PIN set — anyone on this network can use Orbit (set ORBIT_PIN)\n');
    if (cfg.OPEN) openBrowser(`${cfg.SCHEME}://localhost:${cfg.PORT}`);
  });

  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    console.log('\nShutting down Orbit…');
    S.stopTimers();
    S.wipeShared();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach((sig) => {
    try {
      process.on(sig, shutdown); // SIGHUP/SIGBREAK fire when a Windows console window is closed
    } catch {}
  });
  process.on('exit', S.wipeShared); // last-resort cleanup on any normal exit path
  process.on('uncaughtException', (err) => {
    console.error(err);
    S.wipeShared();
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
