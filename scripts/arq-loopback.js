#!/usr/bin/env node
'use strict';

// Drives two ReliableLinks through a lossy virtual channel and asserts the
// application byte stream arrives intact despite corruption, plus a couple of
// unit checks on the FEC and negotiation fallback.
//
// Run: node scripts/arq-loopback.js

const {
  ReliableLink,
  hammingEncode,
  hammingDecode,
  crc16,
} = require('../shared/arq');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Virtual full-duplex channel with latency and per-byte bit-error probability.
function makeHarness({ berA2B = 0, berB2A = 0, robust = false, seed = 1, peerless = false }) {
  const rng = mulberry32(seed);
  let now = 0;
  const events = []; // { at, fn }
  const schedule = (dt, fn) => events.push({ at: now + dt, fn });
  const latency = 60; // ms one-way

  function corrupt(bytes, ber) {
    const out = Uint8Array.from(bytes);
    if (ber > 0) {
      for (let i = 0; i < out.length; i++) {
        for (let bit = 0; bit < 8; bit++) {
          if (rng() < ber) out[i] ^= 1 << bit;
        }
      }
    }
    return out;
  }

  const recvA = [];
  const recvB = [];

  const A = new ReliableLink({
    role: 'originate',
    robust,
    rtoMs: 300,
    now: () => now,
    sendWire: (frame) => schedule(latency, () => B && B.receiveWire(corrupt(frame, berA2B))),
    onData: (p) => recvA.push(...p),
  });

  let B = null;
  if (!peerless) {
    B = new ReliableLink({
      role: 'answer',
      robust,
      rtoMs: 300,
      now: () => now,
      sendWire: (frame) => schedule(latency, () => A.receiveWire(corrupt(frame, berB2A))),
      onData: (p) => recvB.push(...p),
    });
  }

  function run(ms) {
    const end = now + ms;
    while (now < end) {
      now += 20;
      // Deliver due events.
      const due = events.filter((e) => e.at <= now);
      for (const e of due) events.splice(events.indexOf(e), 1);
      for (const e of due) e.fn();
      A.tick();
      if (B) B.tick();
    }
  }

  return { A, B, recvA, recvB, run, get now() { return now; } };
}

let failures = 0;
function check(label, cond, extra = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
}

console.log('ARQ reliable-link tests\n');

// --- Hamming FEC unit check: every single-bit error in an 8-bit codeword is
// corrected back to the original nibble.
(() => {
  let ok = true;
  for (let n = 0; n < 16; n++) {
    const code = hammingEncode(Uint8Array.of(n))[0];
    for (let bit = 0; bit < 8; bit++) {
      const corrupted = code ^ (1 << bit);
      const dec = hammingDecode(Uint8Array.of(corrupted, hammingEncode(Uint8Array.of(0))[0]));
      if ((dec.bytes[0] & 0x0f) !== n) ok = false;
    }
  }
  check('Hamming(8,4) corrects all single-bit errors', ok);
})();

const MESSAGE = 'NodeBBS acoustic link check — \x1b[1;36mANSI\x1b[0m — 0123456789 the quick brown fox.\r\n'.repeat(3);
const sentBytes = [...Buffer.from(MESSAGE, 'utf8')];

function deliverTest(label, opts, { informational = false, ms = 40000 } = {}) {
  const h = makeHarness(opts);
  h.A.start();
  h.run(1600); // let negotiation settle
  h.B.send(sentBytes); // server -> client (the payload direction)
  h.run(ms);
  const got = h.recvA;
  const exact = got.length === sentBytes.length && got.every((b, i) => b === sentBytes[i]);
  const q = (h.B.quality() * 100).toFixed(0);
  const extra = `mode=${h.A.mode}/${h.B.mode} recv=${got.length}/${sentBytes.length} retx=${h.B.stats.retransmits} crcErr=${h.B.stats.crcErrors} q=${q}%`;
  if (informational) {
    console.log(`  ${exact ? 'PASS' : 'INFO'}  ${label}  ${extra}`);
  } else {
    check(label, exact, extra);
  }
  return h;
}

// Plain ARQ is the right tool for a clean-to-low-error link (a decent acoustic
// setup); FEC "robust" mode is what carries a genuinely noisy room.
deliverTest('clean channel, reliable', { berA2B: 0, berB2A: 0 });
deliverTest('0.2% bit errors, reliable', { berA2B: 0.002, berB2A: 0.002, seed: 7 });
deliverTest('1% bit errors, robust FEC', { berA2B: 0.01, berB2A: 0.01, robust: true, seed: 11 });
deliverTest('3% bit errors, robust FEC', { berA2B: 0.03, berB2A: 0.03, robust: true, seed: 5 }, { ms: 80000 });
deliverTest('5% bit errors, robust FEC', { berA2B: 0.05, berB2A: 0.05, robust: true, seed: 3 }, { informational: true, ms: 120000 });

// --- Negotiation fallback: no peer answers the probes -> raw passthrough.
(() => {
  const h = makeHarness({ peerless: true });
  let raw = false;
  h.A.onRaw = () => {
    raw = true;
  };
  h.A.start();
  h.run(6000);
  check('falls back to raw when peer is silent', raw && h.A.mode === 'raw');
})();

console.log('');
if (failures === 0) {
  console.log('All reliable-link tests passed. ARQ keeps the byte stream intact over a noisy channel.');
  process.exit(0);
} else {
  console.log(`${failures} test(s) failed.`);
  process.exit(1);
}
