'use strict';

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const cfg = require('./config');

const read = (name) => fs.readFileSync(path.join(cfg.PUBLIC, name), 'utf8');

const loginHTML = () => read('login.html');

let cached = null;
async function indexHTML(baseUrl) {
  if (cached) return cached;
  const qr = await qrcode.toDataURL(baseUrl, {
    type: 'image/png',
    width: 180,
    margin: 1,
    color: { dark: '#7c3aed', light: '#ffffff' }
  });
  cached = read('index.html').replace('{{QR}}', qr).replace('{{BASE_URL}}', baseUrl);
  return cached;
}

module.exports = { loginHTML, indexHTML };
