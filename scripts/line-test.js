#!/usr/bin/env node
'use strict';

// Acoustic line diagnostic — the setup equivalent of listening to a phone line
// before you dial. It plays each Bell 103 tone through the speaker while the
// microphone measures how strongly that tone (and the background noise) comes
// back, then reports a per-band signal-to-noise ratio and plain-language advice
// ("volume too low", "answer band SNR 7 dB — move devices closer"). Run it on
// the same machine that will dial or answer; point the mic at the speaker.
//
// Run: node scripts/line-test.js [--seconds 0.8]

const { Correlator } = require('../shared/fsk');
const audioIO = require('../shared/audio-io');

const SR = 48000;

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(
    [
      'NodeBBS acoustic line test — measure per-band SNR at the mic.',
      '',
      'Usage: node scripts/line-test.js [--seconds <n>]',
      '',
      '  --seconds <n>  Seconds to hold each test tone (default 0.8).',
      '',
      'Turn the volume to ~70%, put the mic ~30 cm from the speaker, and keep',
      'the room quiet while it runs (~5 s).',
      '',
    ].join('\n') + '\n'
  );
  process.exit(0);
}
const TONE_SECONDS = Number(argv[argv.indexOf('--seconds') + 1]) || 0.8;
const SETTLE_SECONDS = 0.3; // skip acoustic latency + correlator settling

// The four FSK tones, grouped into the two duplex bands.
const TONES = [
  { key: 'o_space', freq: 1070, band: 'originate' },
  { key: 'o_mark', freq: 1270, band: 'originate' },
  { key: 'a_space', freq: 2025, band: 'answer' },
  { key: 'a_mark', freq: 2225, band: 'answer' },
];

// Phase schedule: a quiet window (noise floor), then each tone in turn.
const phases = [{ name: 'noise', freq: 0, dur: 0.9 }];
for (const t of TONES) phases.push({ name: t.key, freq: t.freq, dur: TONE_SECONDS });

// One correlator per tone, always running on the incoming mic signal.
const correlators = {};
for (const t of TONES) correlators[t.key] = new Correlator(t.freq, SR, 120);

// Accumulators: floor[key] from the noise phase, sig[key] from that tone's phase.
const floorAcc = {};
const sigAcc = {};
for (const t of TONES) {
  floorAcc[t.key] = { sum: 0, n: 0 };
  sigAcc[t.key] = { sum: 0, n: 0 };
}

let phaseIdx = 0;
let phaseSample = 0; // samples elapsed within the current phase
const settleN = Math.round(SETTLE_SECONDS * SR);

// TX oscillator (phase-continuous across phase boundaries to avoid clicks).
let txPhase = 0;
function txBlock(n, freq) {
  const out = new Float32Array(n);
  if (!freq) return out; // silence
  const step = (2 * Math.PI * freq) / SR;
  for (let i = 0; i < n; i++) {
    out[i] = 0.5 * Math.sin(txPhase);
    txPhase += step;
    if (txPhase > Math.PI * 2) txPhase -= Math.PI * 2;
  }
  return out;
}

function dbSafe(ratio) {
  if (!(ratio > 0) || !isFinite(ratio)) return -Infinity;
  return 10 * Math.log10(ratio);
}

function bar(db) {
  // 0..30 dB mapped to a 20-char bar.
  const filled = Math.max(0, Math.min(20, Math.round((db / 30) * 20)));
  return '[' + '#'.repeat(filled) + '-'.repeat(20 - filled) + ']';
}

let mic = null;
let speaker = null;
let done = false;

function finish() {
  if (done) return;
  done = true;
  if (mic) mic.close();
  if (speaker) speaker.close();
  report();
  setTimeout(() => process.exit(0), 100);
}

function report() {
  process.stdout.write('\n\n  Results (higher SNR is better):\n\n');

  const bandSnr = { originate: [], answer: [] };
  let maxSig = 0;

  for (const t of TONES) {
    const floor = floorAcc[t.key].n ? floorAcc[t.key].sum / floorAcc[t.key].n : 0;
    const sig = sigAcc[t.key].n ? sigAcc[t.key].sum / sigAcc[t.key].n : 0;
    maxSig = Math.max(maxSig, sig);
    const snr = dbSafe(sig / (floor || 1e-12));
    bandSnr[t.band].push(snr);
    const snrStr = snr === -Infinity ? '  -inf' : (snr >= 0 ? ' ' : '') + snr.toFixed(1).padStart(5);
    process.stdout.write(`    ${String(t.freq).padStart(4)} Hz  ${bar(snr)}  ${snrStr} dB\n`);
  }

  const bandMin = (arr) => (arr.length ? Math.min(...arr) : -Infinity);
  const oSnr = bandMin(bandSnr.originate);
  const aSnr = bandMin(bandSnr.answer);

  process.stdout.write('\n');
  process.stdout.write(`    Originate band (1070/1270):  ${oSnr === -Infinity ? '-inf' : oSnr.toFixed(1)} dB\n`);
  process.stdout.write(`    Answer band    (2025/2225):  ${aSnr === -Infinity ? '-inf' : aSnr.toFixed(1)} dB\n`);
  process.stdout.write('\n  Advice:\n');

  const advice = [];
  // Almost no signal came back at all.
  if (maxSig < 1e-6) {
    advice.push('No tone reached the mic. Turn the output volume up, make sure the');
    advice.push('right speaker/mic are selected, and that the mic is not muted.');
  } else {
    for (const [label, snr] of [
      ['Originate', oSnr],
      ['Answer', aSnr],
    ]) {
      if (snr === -Infinity || snr < 6) {
        advice.push(`${label} band SNR is very low — raise the volume, move the devices`);
        advice.push('closer (~30 cm), and reduce background noise (fans, music, typing).');
      } else if (snr < 12) {
        advice.push(`${label} band SNR is marginal (~${snr.toFixed(0)} dB) — it may work, but`);
        advice.push('nudge the volume up or the devices closer, and try --robust.');
      }
    }
  }
  if (advice.length === 0) {
    advice.push('Both bands look strong. You are clear to dial — good luck, caller.');
  }
  for (const line of advice) process.stdout.write(`    ${line}\n`);
  process.stdout.write('\n');
}

async function main() {
  const soxOk = await audioIO.checkSox();
  if (!soxOk) {
    process.stderr.write(audioIO.soxMissingError().message + '\n');
    process.exit(1);
  }

  process.stdout.write('NodeBBS acoustic line test\n');
  process.stdout.write(`  sample rate ${SR} Hz · ${TONE_SECONDS.toFixed(1)} s per tone\n`);
  process.stdout.write('  measuring');

  mic = audioIO.openMic({ sampleRate: SR });
  speaker = audioIO.openSpeaker({ sampleRate: SR });

  const onErr = (err) => {
    process.stderr.write(`\n${err.message}\n`);
    process.exit(1);
  };
  mic.on('error', onErr);
  speaker.on('error', onErr);

  mic.on('block', (block) => {
    if (done) return;
    const phase = phases[phaseIdx];

    // Run every correlator; accumulate into the phase's target(s) past settle.
    for (let i = 0; i < block.length; i++) {
      const x = block[i];
      for (const t of TONES) {
        const power = correlators[t.key].process(x);
        if (phaseSample + i < settleN) continue;
        if (phase.name === 'noise') {
          floorAcc[t.key].sum += power;
          floorAcc[t.key].n++;
        } else if (phase.name === t.key) {
          sigAcc[t.key].sum += power;
          sigAcc[t.key].n++;
        }
      }
    }

    // Drive the speaker with this phase's tone, equal length to capture.
    speaker.write(txBlock(block.length, phase.freq));

    phaseSample += block.length;
    if (phaseSample >= Math.round(phase.dur * SR)) {
      phaseIdx++;
      phaseSample = 0;
      process.stdout.write('.');
      if (phaseIdx >= phases.length) finish();
    }
  });
}

main().catch((err) => {
  process.stderr.write(`\nline-test failed: ${err.message}\n`);
  process.exit(1);
});
