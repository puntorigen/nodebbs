'use strict';

// Node audio I/O for the acoustic modem, via the `sox` toolkit (`rec`/`play`).
// The mic yields Float32Array blocks; the speaker accepts Float32Array blocks.
// A small speaker buffer keeps keystroke-echo latency down. If sox is missing,
// callers get a friendly, actionable error instead of a spawn ENOENT.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { floatToPcm16, pcm16ToFloat } = require('./fsk');

const SAMPLE_RATE = 48000;

function soxMissingError(err) {
  const e = new Error(
    'acoustic mode needs "sox" (its rec/play tools) on your PATH.\n' +
      '  macOS:  brew install sox\n' +
      '  Debian: sudo apt-get install sox'
  );
  e.code = 'SOX_MISSING';
  e.cause = err;
  return e;
}

// Resolves true if `sox --version` runs. Handy for a pre-flight check.
function checkSox() {
  return new Promise((resolve) => {
    const p = spawn('sox', ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

// Open the microphone. Returns an EventEmitter emitting:
//   'block' (Float32Array)  — mono PCM at sampleRate
//   'error' (Error)         — SOX_MISSING or a spawn/runtime error
//   'close' (code)
function openMic({ sampleRate = SAMPLE_RATE, extraArgs = [] } = {}) {
  const args = ['-q', '-t', 'raw', '-r', String(sampleRate), '-e', 'signed', '-b', '16', '-c', '1', '-', ...extraArgs];
  const proc = spawn('rec', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const mic = new EventEmitter();
  let leftover = Buffer.alloc(0);

  proc.on('error', (err) => mic.emit('error', err.code === 'ENOENT' ? soxMissingError(err) : err));
  proc.stdout.on('data', (chunk) => {
    const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2); // whole int16 samples only
    if (usable > 0) mic.emit('block', pcm16ToFloat(buf.subarray(0, usable)));
    leftover = usable < buf.length ? Buffer.from(buf.subarray(usable)) : Buffer.alloc(0);
  });
  proc.stderr.on('data', () => {}); // swallow sox's console chatter
  proc.on('close', (code) => mic.emit('close', code));

  mic.proc = proc;
  mic.close = () => {
    try {
      proc.kill('SIGTERM');
    } catch (_) {
      /* already gone */
    }
  };
  return mic;
}

// Open the speaker. Returns an EventEmitter with a write(Float32Array) method.
function openSpeaker({ sampleRate = SAMPLE_RATE, bufferBytes = 2048, extraArgs = [] } = {}) {
  const args = [
    '-q', '-t', 'raw', '-r', String(sampleRate), '-e', 'signed', '-b', '16', '-c', '1',
    '--buffer', String(bufferBytes), '-', ...extraArgs,
  ];
  const proc = spawn('play', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const spk = new EventEmitter();

  proc.on('error', (err) => spk.emit('error', err.code === 'ENOENT' ? soxMissingError(err) : err));
  proc.stderr.on('data', () => {});
  proc.on('close', (code) => spk.emit('close', code));

  spk.proc = proc;
  spk.write = (float32) => {
    if (!proc.stdin.writable) return false;
    try {
      return proc.stdin.write(floatToPcm16(float32));
    } catch (_) {
      return false;
    }
  };
  spk.close = () => {
    try {
      proc.stdin.end();
    } catch (_) {
      /* ignore */
    }
    try {
      proc.kill('SIGTERM');
    } catch (_) {
      /* already gone */
    }
  };
  return spk;
}

module.exports = { SAMPLE_RATE, checkSox, openMic, openSpeaker, soxMissingError };
