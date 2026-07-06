'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Simple JSON-file user store. Passwords are never stored in the clear: we keep
// a random salt + scrypt hash per user. Fine for a hobby BBS; swap for a real DB
// if this ever grows up.

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'users.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '{}\n', 'utf8');
}

function load() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8') || '{}');
  } catch (_) {
    return {};
  }
}

function save(db) {
  ensureStore();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n', 'utf8');
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(derived.toString('hex'));
    });
  });
}

// Constant-time comparison of two hex strings of equal length.
function safeEqual(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const HANDLE_RE = /^[A-Za-z0-9 _.-]{2,20}$/;

const users = {
  validateHandle(handle) {
    if (!handle || !HANDLE_RE.test(handle)) {
      return 'Handle must be 2-20 chars: letters, numbers, space, _ . -';
    }
    return null;
  },

  exists(handle) {
    const db = load();
    return Boolean(db[String(handle).toLowerCase()]);
  },

  async create(handle, password) {
    const err = users.validateHandle(handle);
    if (err) throw new Error(err);
    if (!password || password.length < 3) {
      throw new Error('Password must be at least 3 characters.');
    }
    const db = load();
    const key = handle.toLowerCase();
    if (db[key]) throw new Error('That handle is already taken.');

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPassword(password, salt);
    db[key] = {
      handle,
      salt,
      hash,
      createdAt: Date.now(),
      lastCall: Date.now(),
      calls: 1,
    };
    save(db);
    return { handle };
  },

  async authenticate(handle, password) {
    const db = load();
    const rec = db[String(handle).toLowerCase()];
    if (!rec) return null;
    const hash = await hashPassword(password, rec.salt);
    if (!safeEqual(hash, rec.hash)) return null;
    rec.lastCall = Date.now();
    rec.calls = (rec.calls || 0) + 1;
    save(db);
    return { handle: rec.handle, calls: rec.calls, createdAt: rec.createdAt };
  },

  count() {
    return Object.keys(load()).length;
  },
};

module.exports = users;
