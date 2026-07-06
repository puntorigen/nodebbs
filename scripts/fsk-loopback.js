#!/usr/bin/env node
'use strict';

// Loopback + room simulator for the FSK modem. Modulates a byte stream on one
// band, drags it through a synthetic room (attenuation, reverb, band-limited
// noise, keyboard-clack bursts, plus crosstalk from the opposite band), then
// demodulates and reports the byte error rate across a sweep of SNRs.
//
// Run: node scripts/fsk-loopback.js

const {
  PROFILES,
  FskModulator,
  FskDemodulator,
} = require('../shared/fsk');

const SR = 48000;
const profile = PROFILES.bell103;

// Deterministic PRNG so runs are comparable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Synthetic room impulse response: direct path + a few decaying early
// reflections + a short noisy tail. `reflections` is [timeSec, gain] pairs;
// callers pick a severity from ROOMS below.
function makeRoomIR(rng, reflections, tailGain) {
  const n = Math.round(0.08 * SR);
  const ir = new Float32Array(n);
  ir[0] = 1;
  for (const [t, g] of reflections) {
    const idx = Math.round(t * SR);
    if (idx < n) ir[idx] += g * (rng() > 0.5 ? 1 : -1);
  }
  for (let i = Math.round(0.035 * SR); i < n; i++) {
    ir[i] += (rng() * 2 - 1) * tailGain * Math.exp(-i / (0.02 * SR));
  }
  return ir;
}

// Speaker ~30 cm from mic on a desk: a strong-ish desk bounce plus weaker wall
// reflections (mild/medium). "harsh" is a hard-surfaced room, closer to a
// tiled bathroom than a study — deliberately beyond what raw FSK should have
// to survive.
const ROOMS = {
  desk: { reflections: [[0.0008, 0.35], [0.0025, 0.2], [0.006, 0.12]], tail: 0.04 },
  medium: { reflections: [[0.004, 0.3], [0.011, 0.2], [0.019, 0.12]], tail: 0.05 },
  harsh: { reflections: [[0.004, 0.5], [0.011, 0.35], [0.019, 0.28], [0.031, 0.2]], tail: 0.15 },
};

function convolve(sig, ir) {
  const out = new Float32Array(sig.length + ir.length - 1);
  for (let i = 0; i < sig.length; i++) {
    const s = sig[i];
    if (s === 0) continue;
    for (let j = 0; j < ir.length; j++) out[i + j] += s * ir[j];
  }
  return out;
}

// Modulate `bytes` on `band`, returning a padded Float32Array (leading +
// trailing idle carrier so the demod can settle and drain).
function modulateBytes(band, bytes) {
  const mod = new FskModulator(band, { sampleRate: SR, bitRate: profile.bitRate, amplitude: 0.5 });
  mod.raiseCarrier();
  const lead = mod.generate(Math.round(0.3 * SR)); // idle carrier
  mod.pushBytes(bytes);
  const bitSamples = (bytes.length * 10 + 4) * mod.spb;
  const data = mod.generate(bitSamples);
  const tail = mod.generate(Math.round(0.1 * SR));
  const out = new Float32Array(lead.length + data.length + tail.length);
  out.set(lead, 0);
  out.set(data, lead.length);
  out.set(tail, lead.length + data.length);
  return out;
}

function demodToBytes(band, signal) {
  const dem = new FskDemodulator(band, { sampleRate: SR, bitRate: profile.bitRate });
  const got = [];
  dem.onbyte = (b) => got.push(b);
  dem.process(signal);
  return { bytes: got, stats: dem.stats };
}

function addNoise(sig, rng, amp) {
  for (let i = 0; i < sig.length; i++) sig[i] += (rng() * 2 - 1) * amp;
}

// Occasional sharp transients, like typing on a mechanical keyboard.
function addClacks(sig, rng, count, amp) {
  for (let c = 0; c < count; c++) {
    const at = Math.floor(rng() * (sig.length - 500));
    const len = 60 + Math.floor(rng() * 200);
    for (let i = 0; i < len; i++) sig[at + i] += (rng() * 2 - 1) * amp * Math.exp(-i / 40);
  }
}

function mix(a, b) {
  const n = Math.max(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < a.length; i++) out[i] += a[i];
  for (let i = 0; i < b.length; i++) out[i] += b[i];
  return out;
}

function byteErrors(sent, got) {
  let errors = 0;
  const n = Math.max(sent.length, got.length);
  for (let i = 0; i < n; i++) {
    if (sent[i] !== got[i]) errors++;
  }
  return errors;
}

function runCase(label, { noiseAmp, clackAmp, crosstalk, room }) {
  const rng = mulberry32(0x1234);
  const msg = 'The quick brown fox jumps over the lazy dog. 0123456789 \x1b[1;32mANSI\x1b[0m\r\n';
  const sent = Buffer.from(msg, 'utf8');

  // Answer band carries the payload; originate band carries crosstalk.
  let sig = modulateBytes(profile.answer, sent);

  if (room) {
    const spec = ROOMS[room];
    const ir = makeRoomIR(rng, spec.reflections, spec.tail);
    sig = convolve(sig, ir);
    // Normalize back to roughly unit level after reverb gain.
    let peak = 0;
    for (const v of sig) peak = Math.max(peak, Math.abs(v));
    if (peak > 0) for (let i = 0; i < sig.length; i++) sig[i] /= peak / 0.6;
  }

  if (crosstalk > 0) {
    const other = modulateBytes(profile.originate, Buffer.from('keystrokes leaking across the bands....'));
    for (let i = 0; i < sig.length && i < other.length; i++) sig[i] += other[i] * crosstalk;
  }

  if (noiseAmp > 0) addNoise(sig, rng, noiseAmp);
  if (clackAmp > 0) addClacks(sig, rng, 20, clackAmp);

  const { bytes: got, stats } = demodToBytes(profile.answer, sig);
  const errors = byteErrors([...sent], got);
  const rate = ((errors / sent.length) * 100).toFixed(1);
  const ok = errors === 0;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} sent=${sent.length} got=${got.length} ` +
      `byteErr=${errors} (${rate}%) framing=${stats.framingErrors}`
  );
  return ok;
}

console.log('FSK loopback + room simulator (Bell 103, 300 bps)\n');

let allPass = true;
const INFORMATIONAL = new Set(['harsh room (needs ARQ)']);
const cases = [
  ['clean wire', { noiseAmp: 0, clackAmp: 0, crosstalk: 0, room: null }],
  ['crosstalk only', { noiseAmp: 0, clackAmp: 0, crosstalk: 0.4, room: null }],
  ['desk reverb (quiet)', { noiseAmp: 0.005, clackAmp: 0, crosstalk: 0.3, room: 'desk' }],
  ['desk reverb + noise', { noiseAmp: 0.03, clackAmp: 0, crosstalk: 0.3, room: 'desk' }],
  ['desk reverb + clacks', { noiseAmp: 0.02, clackAmp: 0.12, crosstalk: 0.3, room: 'desk' }],
  ['medium room + noise', { noiseAmp: 0.03, clackAmp: 0, crosstalk: 0.3, room: 'medium' }],
  ['harsh room (needs ARQ)', { noiseAmp: 0.06, clackAmp: 0.2, crosstalk: 0.4, room: 'harsh' }],
];

for (const [label, opts] of cases) {
  const ok = runCase(label, opts);
  if (!ok && !INFORMATIONAL.has(label)) allPass = false;
}

console.log('');
if (allPass) {
  console.log('Core cases passed. Raw 300 bps FSK survives a reverberant desk/room with noise.');
  console.log('(The "harsh room" case is where the ARQ/robust layer earns its keep.)');
  process.exit(0);
} else {
  console.log('Regression: a core case failed. The demodulator needs attention.');
  process.exit(1);
}
