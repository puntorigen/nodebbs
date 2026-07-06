'use strict';

// Baud-dependent dial-up modem handshake synthesizer.
//
// NOTE: the synthesis half of this file is mirrored in web/lib/modem.js
// (browser copy, ESM). If you change the sound, change both.
//
// synthHandshake(baud) renders the whole call as raw PCM samples plus a
// phase timeline so the dialer UI can print status lines in sync with the
// audio. Every speed shares the same prologue (off-hook click, dial tone,
// DTMF digits, ringback, 2100 Hz answer tone) and then diverges into a
// negotiation section modeled loosely on the real standards:
//
//   300    Bell 103   clean mark tones, no training       (~5s)
//   1200   Bell 212A  scrambled-data warble               (~6s)
//   2400   V.22bis    S1 training warble + scramble       (~6.5s)
//   9600   V.32       echo-probe clicks + training noise  (~7.5s)
//   14400  V.32bis    echo probe + iconic fast dual-tone
//                     trill + long scrambled training     (~9.5s)
//   0/full V.34/V.90  the full drama: bong, dual-tone
//                     probing, long hiss fading out       (~9.5s)

const SAMPLE_RATE = 44100;

// Seeded PRNG so a given baud always produces the same noise (and the CLI
// and web copies sound identical).
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DTMF = {
  0: [941, 1336],
  1: [697, 1209],
  2: [697, 1336],
  3: [697, 1477],
  4: [770, 1209],
  5: [770, 1336],
  6: [770, 1477],
  7: [852, 1209],
  8: [852, 1336],
  9: [852, 1477],
};

function tierFor(baud) {
  const b = Number(baud) || 0;
  if (b === 0 || b > 14400) return 'v34';
  if (b <= 300) return 'bell103';
  if (b <= 1200) return 'bell212';
  if (b <= 2400) return 'v22bis';
  if (b <= 9600) return 'v32';
  return 'v32bis';
}

function synthHandshake(baud = 2400) {
  const sr = SAMPLE_RATE;
  const tier = tierFor(baud);
  const rng = makeRng(0xbb5 ^ ((Number(baud) || 56000) * 2654435761));

  const segs = [];
  const phases = [];
  let t = 0;

  const phase = (name, label) => phases.push({ name, label: label || null, t: +t.toFixed(3) });
  const silence = (dur) => {
    t += dur;
  };
  // gen(k, sr) returns the sample k samples into the segment.
  const add = (dur, gen, fadeIn = 0.004, fadeOut = 0.012) => {
    segs.push({ start: t, dur, gen, fadeIn, fadeOut });
    t += dur;
  };

  // -- generator factories ---------------------------------------------------

  const tone = (freqs, amp = 0.22) => (k) => {
    let v = 0;
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * k) / sr);
    return (v / freqs.length) * amp;
  };

  // Phase-continuous FSK-style warble alternating between two tones.
  const warble = (f0, f1, rate, amp = 0.2) => {
    let ph = 0;
    const period = Math.max(1, Math.floor(sr / rate));
    return (k) => {
      const f = Math.floor(k / period) % 2 === 0 ? f0 : f1;
      ph += (2 * Math.PI * f) / sr;
      return Math.sin(ph) * amp;
    };
  };

  // Lowpass-shaded white noise (the carrier "hiss").
  const hiss = (amp = 0.16, cutoff = 4500) => {
    let y = 0;
    const a = Math.exp((-2 * Math.PI * cutoff) / sr);
    return () => {
      y = a * y + (1 - a) * (rng() * 2 - 1);
      return y * amp * 6; // one-pole eats energy; compensate
    };
  };

  // Sharp transient click (relay / echo-canceller probe).
  const click = (amp = 0.3) => (k) => {
    const env = Math.exp(-k / (sr * 0.004));
    return (rng() * 2 - 1) * amp * env;
  };

  // -- shared prologue ---------------------------------------------------------

  phase('offhook');
  add(0.05, click(0.22));
  silence(0.08);
  add(0.75, tone([350, 440], 0.16)); // US dial tone

  phase('dialing', null); // dial text is already on screen
  const digits = String(1000000 + Math.floor(rng() * 8999999)); // 7 "digits"
  for (const d of digits) {
    add(0.085, tone(DTMF[d], 0.24));
    silence(0.055);
  }
  silence(0.25);

  phase('ringing', 'RINGING');
  add(1.25, tone([440, 480], 0.15)); // ringback
  silence(0.45);

  phase('carrier', 'CARRIER DETECT');
  // Answer tone: Bell-era modems answered at 2225 Hz, V-series at 2100 Hz.
  add(0.85, tone([tier === 'bell103' || tier === 'bell212' ? 2225 : 2100], 0.2));
  silence(0.12);

  // -- per-tier negotiation ----------------------------------------------------

  if (tier === 'bell103') {
    phase('training', 'HANDSHAKING');
    add(0.55, tone([2225], 0.18));
    add(0.8, tone([2225, 1270], 0.18)); // both ends' mark tones
  } else if (tier === 'bell212') {
    phase('training', 'HANDSHAKING');
    add(0.5, tone([2225, 1200], 0.18));
    add(1.3, warble(1200, 2200, 22, 0.18)); // scrambled ones
  } else if (tier === 'v22bis') {
    phase('training', 'TRAINING');
    add(0.55, warble(600, 3000, 8, 0.17)); // S1 sequence
    add(0.75, warble(1200, 2400, 24, 0.18));
    add(0.7, hiss(0.05, 3200));
  } else if (tier === 'v32') {
    phase('training', 'TRAINING');
    // Echo-canceller probing: clicks over a steady tone.
    add(0.4, tone([1800], 0.16));
    for (let i = 0; i < 3; i++) {
      add(0.06, click(0.35));
      silence(0.14);
    }
    add(0.8, warble(650, 2900, 12, 0.17));
    add(1.5, hiss(0.06, 4200));
  } else if (tier === 'v32bis') {
    phase('training', 'TRAINING');
    // Echo-canceller probing, as V.32…
    add(0.4, tone([1800], 0.16));
    for (let i = 0; i < 3; i++) {
      add(0.05, click(0.35));
      silence(0.12);
    }
    // …then the iconic fast dual-tone "trill" everyone remembers…
    add(1.0, warble(1200, 2400, 30, 0.19));
    add(0.55, warble(1800, 3000, 45, 0.17));
    // …and a longer scrambled-data training hiss.
    add(1.9, hiss(0.065, 4600));
  } else {
    // v34 / "FULL": the famous long sequence.
    phase('training', 'NEGOTIATING');
    // The V.8 "bong".
    add(0.5, (k) => Math.sin((2 * Math.PI * 2130 * k) / sr) * 0.24 * Math.exp(-k / (sr * 0.35)));
    add(0.7, warble(1375, 2002, 4, 0.18)); // dual-tone probing
    add(0.55, warble(750, 2250, 16, 0.18));
    for (let i = 0; i < 2; i++) {
      add(0.05, click(0.3));
      silence(0.1);
    }
    phase('training2', 'TRAINING');
    add(1.4, hiss(0.075, 5200));
    add(1.6, hiss(0.05, 3600)); // level shift: equalizers settling
    add(0.9, hiss(0.028, 2400)); // fading toward "connected" quiet
  }

  silence(0.15);
  phase('done');

  // -- render -------------------------------------------------------------------

  const total = Math.ceil(t * sr);
  const samples = new Float32Array(total);
  for (const s of segs) {
    const n0 = Math.floor(s.start * sr);
    const n = Math.floor(s.dur * sr);
    for (let k = 0; k < n; k++) {
      let v = s.gen(k, sr);
      const tIn = k / sr;
      const tOut = (n - k) / sr;
      if (tIn < s.fadeIn) v *= tIn / s.fadeIn;
      if (tOut < s.fadeOut) v *= tOut / s.fadeOut;
      const idx = n0 + k;
      if (idx < total) samples[idx] += v;
    }
  }
  for (let i = 0; i < total; i++) {
    if (samples[i] > 1) samples[i] = 1;
    else if (samples[i] < -1) samples[i] = -1;
  }

  return { samples, sampleRate: sr, duration: t, phases, tier };
}

// -- Node-only: minimal 16-bit PCM mono WAV encoder ------------------------------

function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
  }
  return buf;
}

module.exports = { synthHandshake, encodeWav, SAMPLE_RATE };
