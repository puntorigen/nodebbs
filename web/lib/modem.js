// Baud-dependent dial-up modem handshake synthesizer (browser copy).
//
// NOTE: mirrored from client/lib/modem.js (canonical, CommonJS). The two
// packages deploy separately, so the synthesis code is duplicated. If you
// change the sound, change both.
//
// synthHandshake(baud) renders the whole call as raw PCM samples plus a
// phase timeline so the dialer UI can print status lines in sync with the
// audio. Every speed shares the same prologue (off-hook click, dial tone,
// DTMF digits, ringback, answer tone) and then diverges into a negotiation
// section modeled loosely on the real standards:
//
//   300    Bell 103   clean mark tones, no training
//   1200   Bell 212A  scrambled-data warble
//   2400   V.22bis    S1 training warble + scramble
//   9600   V.32       echo-probe clicks + training noise
//   0/full V.34/V.90  bong, dual-tone probing, long hiss

export const SAMPLE_RATE = 44100;

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
  if (b === 0 || b > 9600) return 'v34';
  if (b <= 300) return 'bell103';
  if (b <= 1200) return 'bell212';
  if (b <= 2400) return 'v22bis';
  return 'v32';
}

export function synthHandshake(baud = 2400) {
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
  const add = (dur, gen, fadeIn = 0.004, fadeOut = 0.012) => {
    segs.push({ start: t, dur, gen, fadeIn, fadeOut });
    t += dur;
  };

  const tone = (freqs, amp = 0.22) => (k) => {
    let v = 0;
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * k) / sr);
    return (v / freqs.length) * amp;
  };

  const warble = (f0, f1, rate, amp = 0.2) => {
    let ph = 0;
    const period = Math.max(1, Math.floor(sr / rate));
    return (k) => {
      const f = Math.floor(k / period) % 2 === 0 ? f0 : f1;
      ph += (2 * Math.PI * f) / sr;
      return Math.sin(ph) * amp;
    };
  };

  const hiss = (amp = 0.16, cutoff = 4500) => {
    let y = 0;
    const a = Math.exp((-2 * Math.PI * cutoff) / sr);
    return () => {
      y = a * y + (1 - a) * (rng() * 2 - 1);
      return y * amp * 6;
    };
  };

  const click = (amp = 0.3) => (k) => {
    const env = Math.exp(-k / (sr * 0.004));
    return (rng() * 2 - 1) * amp * env;
  };

  phase('offhook');
  add(0.05, click(0.22));
  silence(0.08);
  add(0.75, tone([350, 440], 0.16));

  phase('dialing', null);
  const digits = String(1000000 + Math.floor(rng() * 8999999));
  for (const d of digits) {
    add(0.085, tone(DTMF[d], 0.24));
    silence(0.055);
  }
  silence(0.25);

  phase('ringing', 'RINGING');
  add(1.25, tone([440, 480], 0.15));
  silence(0.45);

  phase('carrier', 'CARRIER DETECT');
  add(0.85, tone([tier === 'bell103' || tier === 'bell212' ? 2225 : 2100], 0.2));
  silence(0.12);

  if (tier === 'bell103') {
    phase('training', 'HANDSHAKING');
    add(0.55, tone([2225], 0.18));
    add(0.8, tone([2225, 1270], 0.18));
  } else if (tier === 'bell212') {
    phase('training', 'HANDSHAKING');
    add(0.5, tone([2225, 1200], 0.18));
    add(1.3, warble(1200, 2200, 22, 0.18));
  } else if (tier === 'v22bis') {
    phase('training', 'TRAINING');
    add(0.55, warble(600, 3000, 8, 0.17));
    add(0.75, warble(1200, 2400, 24, 0.18));
    add(0.7, hiss(0.05, 3200));
  } else if (tier === 'v32') {
    phase('training', 'TRAINING');
    add(0.4, tone([1800], 0.16));
    for (let i = 0; i < 3; i++) {
      add(0.06, click(0.35));
      silence(0.14);
    }
    add(0.8, warble(650, 2900, 12, 0.17));
    add(1.5, hiss(0.06, 4200));
  } else {
    phase('training', 'NEGOTIATING');
    add(0.5, (k) => Math.sin((2 * Math.PI * 2130 * k) / sr) * 0.24 * Math.exp(-k / (sr * 0.35)));
    add(0.7, warble(1375, 2002, 4, 0.18));
    add(0.55, warble(750, 2250, 16, 0.18));
    for (let i = 0; i < 2; i++) {
      add(0.05, click(0.3));
      silence(0.1);
    }
    phase('training2', 'TRAINING');
    add(1.4, hiss(0.075, 5200));
    add(1.6, hiss(0.05, 3600));
    add(0.9, hiss(0.028, 2400));
  }

  silence(0.15);
  phase('done');

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
