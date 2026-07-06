'use strict';

// Bell 103-style software modem: pure-JS binary FSK with frequency-division
// duplexing. Two bands let both ends transmit at once; each side demodulates
// only the other band, so speaker-to-mic leakage of your own carrier is
// rejected by the input bandpass.
//
// This is the canonical CommonJS copy. web/lib/fsk.js is an ESM mirror — keep
// them in sync (the DSP is identical; only the module syntax differs).
//
// Everything operates on Float32Array blocks of mono PCM at 48 kHz. No deps.

const DEFAULT_SR = 48000;

// Async serial framing: 1 start bit (space), 8 data bits LSB-first, 1 stop bit
// (mark). Idle line = continuous mark. 300 bps => 30 bytes/sec.
const PROFILES = {
  bell103: {
    bitRate: 300,
    // Originate end (the caller) transmits here…
    originate: { space: 1070, mark: 1270 },
    // …and the answer end (the BBS) transmits here.
    answer: { space: 2025, mark: 2225 },
  },
};

// V.25-ish calling tone the caller emits so an idle answering modem knows a
// human is dialing in (cadenced, so a steady tone in the room can't fake it).
const CALLING_TONE = {
  freq: 1300,
  onMs: 400,
  offMs: 600,
};

// ---- primitive DSP blocks --------------------------------------------------

class OnePole {
  // First-order lowpass. cut in Hz.
  constructor(cut, sampleRate) {
    this.a = 1 - Math.exp((-2 * Math.PI * cut) / sampleRate);
    this.y = 0;
  }
  process(x) {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

class Biquad {
  // RBJ "0 dB peak" bandpass. f0 center Hz, bw bandwidth Hz.
  constructor(f0, bw, sampleRate) {
    const w0 = (2 * Math.PI * f0) / sampleRate;
    const Q = f0 / bw;
    const alpha = Math.sin(w0) / (2 * Q);
    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * Math.cos(w0);
    const a2 = 1 - alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// Non-coherent tone power estimator: multiply the input by a recursively
// rotated reference phasor, lowpass I and Q, return I^2 + Q^2.
class Correlator {
  constructor(freq, sampleRate, lpCut = 140) {
    this.cosD = Math.cos((2 * Math.PI * freq) / sampleRate);
    this.sinD = Math.sin((2 * Math.PI * freq) / sampleRate);
    this.c = 1;
    this.s = 0;
    this.lpI = new OnePole(lpCut, sampleRate);
    this.lpQ = new OnePole(lpCut, sampleRate);
    this._n = 0;
  }
  process(x) {
    // Advance the reference oscillator.
    const nc = this.c * this.cosD - this.s * this.sinD;
    const ns = this.s * this.cosD + this.c * this.sinD;
    this.c = nc;
    this.s = ns;
    if ((this._n = (this._n + 1) & 1023) === 0) {
      // Periodic renormalization so the phasor doesn't drift in magnitude.
      const m = Math.hypot(this.c, this.s) || 1;
      this.c /= m;
      this.s /= m;
    }
    const i = this.lpI.process(x * this.c);
    const q = this.lpQ.process(x * this.s);
    return i * i + q * q;
  }
}

// ---- modulator -------------------------------------------------------------

class FskModulator {
  // band = { space, mark }
  constructor(band, opts = {}) {
    this.sampleRate = opts.sampleRate || DEFAULT_SR;
    this.bitRate = opts.bitRate || 300;
    this.amplitude = opts.amplitude != null ? opts.amplitude : 0.5;
    this.band = band;
    this.spb = Math.round(this.sampleRate / this.bitRate);

    this._bits = []; // queued bit frequencies (drained via a head index)
    this._bitHead = 0;
    this._phase = 0;
    this._curFreq = band.mark;
    this._bitLeft = 0;

    this._carrierOn = false;
    this._env = 0; // amplitude envelope 0..1
    this._rampStep = 1 / (0.005 * this.sampleRate); // ~5 ms ramp
  }

  raiseCarrier() {
    this._carrierOn = true;
  }

  dropCarrier() {
    this._carrierOn = false;
    this._bits.length = 0; // abandon any queued data
    this._bitHead = 0;
  }

  get carrierUp() {
    return this._carrierOn || this._env > 0.001;
  }

  pushByte(b) {
    b &= 0xff;
    const { space, mark } = this.band;
    this._bits.push(space); // start bit
    for (let k = 0; k < 8; k++) this._bits.push((b >> k) & 1 ? mark : space);
    this._bits.push(mark); // stop bit
  }

  pushBytes(data) {
    for (let i = 0; i < data.length; i++) this.pushByte(data[i]);
  }

  get queuedBits() {
    return this._bits.length - this._bitHead + (this._bitLeft > 0 ? 1 : 0);
  }

  // Render n samples into a Float32Array.
  generate(n) {
    const out = new Float32Array(n);
    const twoPiOverSr = (2 * Math.PI) / this.sampleRate;
    for (let i = 0; i < n; i++) {
      // Envelope toward carrier state.
      const target = this._carrierOn ? 1 : 0;
      if (this._env < target) this._env = Math.min(target, this._env + this._rampStep);
      else if (this._env > target) this._env = Math.max(target, this._env - this._rampStep);

      if (this._env <= 0.0001 && !this._carrierOn) {
        out[i] = 0;
        continue;
      }

      if (this._bitLeft <= 0) {
        if (this._bitHead < this._bits.length) {
          this._curFreq = this._bits[this._bitHead++];
          // Compact the queue occasionally so it doesn't grow without bound
          // while a multi-KB screen drains at 30 bytes/sec.
          if (this._bitHead > 8192) {
            this._bits = this._bits.slice(this._bitHead);
            this._bitHead = 0;
          }
        } else {
          this._curFreq = this.band.mark; // idle = mark
        }
        this._bitLeft = this.spb;
      }
      out[i] = this.amplitude * this._env * Math.sin(this._phase);
      this._phase += twoPiOverSr * this._curFreq;
      if (this._phase > Math.PI * 2) this._phase -= Math.PI * 2;
      this._bitLeft--;
    }
    return out;
  }
}

// ---- demodulator -----------------------------------------------------------

const RX_IDLE = 0;
const RX_RECEIVING = 1;

class FskDemodulator {
  constructor(band, opts = {}) {
    this.sampleRate = opts.sampleRate || DEFAULT_SR;
    this.bitRate = opts.bitRate || 300;
    this.band = band;
    this.spb = Math.round(this.sampleRate / this.bitRate);

    const f0 = (band.space + band.mark) / 2;
    this._bp = new Biquad(f0, opts.bandwidth || 420, this.sampleRate);
    this._mark = new Correlator(band.mark, this.sampleRate, opts.lpCut || 150);
    this._space = new Correlator(band.space, this.sampleRate, opts.lpCut || 150);

    // Carrier detect (SNR-relative). The absolute floor minimum stops a dead-
    // quiet band from asserting a carrier on nothing but faint out-of-band
    // leakage through the bandpass (~0.02 full-scale carrier still passes).
    this._magFast = new OnePole(200, this.sampleRate);
    this._floor = 1e-9;
    this._cdRatio = opts.cdRatio || 6; // ~8 dB in power
    this._cdFloorMin = opts.cdFloorMin != null ? opts.cdFloorMin : 1e-4;
    this._cdHi = 0;
    this._cdLo = 0;
    this._cdHiNeed = Math.round((opts.cdOnMs || 150) * this.sampleRate / 1000);
    this._cdLoNeed = Math.round((opts.cdOffMs || 600) * this.sampleRate / 1000);
    this.carrierDetected = false;

    // Bit-decision hysteresis on the normalized discriminator.
    this._level = 1; // start assuming idle mark
    this._prevLevel = 1;
    this._hyst = 0.15;

    // The correlator lowpass adds group delay, so the mark->space threshold
    // crossing that flags a start bit lands well after the true edge. Starting
    // the bit clock partway into the first bit re-centers the sampling windows
    // on the (delayed) bit content. ~0.22 bit is the middle of the empirically
    // measured zero-error window and is independent of sample rate.
    this._syncOffset = opts.syncOffset != null ? opts.syncOffset : Math.round(0.22 * this.spb);

    // UART state.
    this._state = RX_IDLE;
    this._rxCount = 0;
    this._bitIndex = 0;
    this._byte = 0;
    this._bitSamples = []; // discriminator values collected in current bit window

    // Sub-window boundaries inside a bit: middle 60%, split in three.
    this._w0 = Math.round(0.2 * this.spb);
    this._sub = Math.round(0.2 * this.spb);

    this.stats = { bytes: 0, framingErrors: 0 };

    // Assignable callbacks.
    this.onbyte = null;
    this.oncarrier = null;
    this.oncarrierloss = null;
  }

  reset() {
    this._state = RX_IDLE;
    this._bitSamples.length = 0;
    this._level = 1;
  }

  process(samples) {
    for (let i = 0; i < samples.length; i++) this._sample(samples[i]);
  }

  _updateCarrier(mag) {
    const m = this._magFast.process(mag);
    // Track the noise floor as a slow min-follower: fall fast toward quiet, and
    // creep up only very slowly (tau ~ seconds) and only while no carrier is
    // asserted, so a sustained carrier never drags the floor up to meet it.
    if (m < this._floor) this._floor += (m - this._floor) * 0.02;
    else if (!this.carrierDetected) this._floor += (m - this._floor) * 0.000003;

    const present = m > this._floor * this._cdRatio + 1e-9 && m > this._cdFloorMin;
    if (present) {
      this._cdHi++;
      this._cdLo = 0;
      if (!this.carrierDetected && this._cdHi >= this._cdHiNeed) {
        this.carrierDetected = true;
        if (this.oncarrier) this.oncarrier();
      }
    } else {
      this._cdLo++;
      this._cdHi = 0;
      if (this.carrierDetected && this._cdLo >= this._cdLoNeed) {
        this.carrierDetected = false;
        this.reset();
        if (this.oncarrierloss) this.oncarrierloss();
      }
    }
  }

  _decideBit() {
    // Majority vote across three sub-windows of the discriminator, each vote
    // being the sign of that sub-window's integral. Rejects transient spikes.
    const arr = this._bitSamples;
    const n = arr.length;
    if (n === 0) return 1;
    const third = Math.max(1, Math.floor(n / 3));
    let votes = 0;
    for (let s = 0; s < 3; s++) {
      let sum = 0;
      const start = s * third;
      const end = s === 2 ? n : start + third;
      for (let k = start; k < end; k++) sum += arr[k];
      votes += sum >= 0 ? 1 : -1;
    }
    return votes >= 0 ? 1 : 0; // 1 = mark, 0 = space
  }

  _sample(x) {
    const f = this._bp.process(x);
    const pm = this._mark.process(f);
    const ps = this._space.process(f);
    const total = pm + ps;
    this._updateCarrier(total);

    const d = (pm - ps) / (total + 1e-9); // normalized discriminator in [-1, 1]

    // Level with hysteresis (used for start-bit edge detection).
    if (d > this._hyst) this._level = 1;
    else if (d < -this._hyst) this._level = 0;

    if (this._state === RX_IDLE) {
      // Only look for a start bit while a carrier is actually present.
      if (this.carrierDetected && this._level === 0 && this._prevLevel === 1) {
        this._state = RX_RECEIVING;
        this._rxCount = this._syncOffset;
        this._bitIndex = 0;
        this._byte = 0;
        this._bitSamples.length = 0;
      }
      this._prevLevel = this._level;
      return;
    }

    // RX_RECEIVING
    this._rxCount++;
    const posInBit = this._rxCount - this._bitIndex * this.spb;
    if (posInBit >= this._w0 && posInBit < this._w0 + 3 * this._sub) {
      this._bitSamples.push(d);
    }
    if (this._rxCount >= (this._bitIndex + 1) * this.spb) {
      const bit = this._decideBit();
      this._bitSamples.length = 0;

      if (this._bitIndex === 0) {
        // Start bit must be space (0); otherwise a false edge.
        if (bit !== 0) {
          this.stats.framingErrors++;
          this._state = RX_IDLE;
          this._prevLevel = this._level;
          return;
        }
      } else if (this._bitIndex <= 8) {
        if (bit) this._byte |= 1 << (this._bitIndex - 1);
      } else {
        // Stop bit should be mark (1). Emit the byte regardless, but count
        // framing errors so link-quality stats reflect a noisy line.
        if (bit !== 1) this.stats.framingErrors++;
        this.stats.bytes++;
        if (this.onbyte) this.onbyte(this._byte & 0xff);
        this._state = RX_IDLE;
        this._prevLevel = this._level;
        return;
      }
      this._bitIndex++;
    }
  }
}

// ---- handshake tones -------------------------------------------------------

// Emits the cadenced calling tone (caller side). generate(n) returns samples.
class CallingToneGenerator {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || DEFAULT_SR;
    this.freq = opts.freq || CALLING_TONE.freq;
    this.amplitude = opts.amplitude != null ? opts.amplitude : 0.5;
    this._onN = Math.round((opts.onMs || CALLING_TONE.onMs) * this.sampleRate / 1000);
    this._offN = Math.round((opts.offMs || CALLING_TONE.offMs) * this.sampleRate / 1000);
    this._phase = 0;
    this._count = 0;
    this._on = true;
  }
  generate(n) {
    const out = new Float32Array(n);
    const step = (2 * Math.PI * this.freq) / this.sampleRate;
    for (let i = 0; i < n; i++) {
      if (this._on) {
        // Soft edges to avoid clicks.
        const ramp = Math.min(1, Math.min(this._count, this._onN - this._count) / (0.005 * this.sampleRate));
        out[i] = this.amplitude * Math.max(0, ramp) * Math.sin(this._phase);
        this._phase += step;
        if (++this._count >= this._onN) {
          this._on = false;
          this._count = 0;
        }
      } else {
        out[i] = 0;
        if (++this._count >= this._offN) {
          this._on = true;
          this._count = 0;
        }
      }
    }
    return out;
  }
}

// Detects the calling tone by energy ratio plus cadence (answer side). Fires
// ondetected once, after two valid beeps, so a steady tone can't trigger it.
class CallingToneDetector {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || DEFAULT_SR;
    this.freq = opts.freq || CALLING_TONE.freq;
    this._tone = new Correlator(this.freq, this.sampleRate, 60);
    this._broad = new OnePole(30, this.sampleRate); // total mean-square
    this._env = new OnePole(40, this.sampleRate); // smoothed in-band power
    // A pure tone at freq puts ~half the total energy in the correlator bin, so
    // the in-band/total ratio tops out near 0.5. Require it to dominate.
    this._ratio = opts.ratio || 0.3;
    this._on = false;
    this._runN = 0;
    this._beeps = 0;
    this._beepsNeeded = opts.beeps || 2;
    this._minOnN = Math.round((opts.minOnMs || 200) * this.sampleRate / 1000);
    this._maxOnN = Math.round((opts.maxOnMs || 900) * this.sampleRate / 1000);
    this._done = false;
    this.ondetected = null;
  }
  process(samples) {
    for (let i = 0; i < samples.length && !this._done; i++) {
      const tone = this._env.process(this._tone.process(samples[i]));
      const broad = this._broad.process(samples[i] * samples[i]) + 1e-12;
      const present = tone > broad * this._ratio;

      if (present) {
        this._runN++;
      } else {
        // A valid beep just ended (a cadenced on-burst of the right length).
        if (this._on && this._runN >= this._minOnN && this._runN <= this._maxOnN) {
          this._beeps++;
          if (this._beeps >= this._beepsNeeded) {
            this._done = true;
            if (this.ondetected) this.ondetected();
          }
        }
        this._runN = 0;
      }
      this._on = present;
    }
  }
}

// ---- PCM helpers -----------------------------------------------------------

function floatToPcm16(float32) {
  const buf = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    let v = float32[i];
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

function pcm16ToFloat(buf) {
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

module.exports = {
  DEFAULT_SR,
  PROFILES,
  CALLING_TONE,
  OnePole,
  Biquad,
  Correlator,
  FskModulator,
  FskDemodulator,
  CallingToneGenerator,
  CallingToneDetector,
  floatToPcm16,
  pcm16ToFloat,
};
