'use strict';

const crypto = require('crypto');
const readline = require('readline');
const cfg = require('./config');

const randomPin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const OFF = /^(0|none|off|no|false)$/i;
const RANDOM = /^(random|auto)$/i;

function fromValue(v) {
  const s = String(v).trim();
  if (!s || OFF.test(s)) return '';
  if (RANDOM.test(s)) return randomPin();
  return s;
}

function ask() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  PIN protection — Enter = random 6-digit PIN, type your own, or 0 = no PIN: ', (a) => {
      rl.close();
      resolve(a.trim() === '' ? randomPin() : fromValue(a));
    });
  });
}

/** Decide the PIN: env var wins; otherwise ask when running in a terminal; otherwise no PIN. */
async function resolvePin() {
  if (process.env.ORBIT_PIN !== undefined) cfg.PIN = fromValue(process.env.ORBIT_PIN);
  else if (process.stdin.isTTY && process.stdout.isTTY) cfg.PIN = await ask();
  else cfg.PIN = '';
  return cfg.PIN;
}

module.exports = { resolvePin, randomPin };
