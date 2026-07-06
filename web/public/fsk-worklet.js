// AudioWorkletProcessor hosting the originate-side software modem for the web
// client's PHONE LINE. Runs on the audio render thread: it demodulates the
// microphone (the BBS's answer band) into bytes posted to the main thread, and
// modulates frame bytes from the main thread onto the speaker (the caller's
// originate band). The reliable link (ARQ) and dial orchestration live on the
// main thread (see web/lib/transport.js) — this file is pure DSP.
//
// A worklet cannot import modules, so the DSP classes are inlined here. They
// are byte-for-byte the same math as shared/fsk.js / web/lib/fsk.js — keep all
// three in sync if you touch the DSP.
//
// getUserMedia MUST be opened with echoCancellation/noiseSuppression/
// autoGainControl all false, or the browser's own DSP eats the carriers.

class OnePole {
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
  constructor(f0, bw, sampleRate) {
    const w0 = (2 * Math.PI * f0) / sampleRate;
    const Q = f0 / bw;
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
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
    const nc = this.c * this.cosD - this.s * this.sinD;
    const ns = this.s * this.cosD + this.c * this.sinD;
    this.c = nc;
    this.s = ns;
    if ((this._n = (this._n + 1) & 1023) === 0) {
      const m = Math.hypot(this.c, this.s) || 1;
      this.c /= m;
      this.s /= m;
    }
    const i = this.lpI.process(x * this.c);
    const q = this.lpQ.process(x * this.s);
    return i * i + q * q;
  }
}

class FskModulator {
  constructor(band, opts = {}) {
    this.sampleRate = opts.sampleRate || 48000;
    this.bitRate = opts.bitRate || 300;
    this.amplitude = opts.amplitude != null ? opts.amplitude : 0.5;
    this.band = band;
    this.spb = Math.round(this.sampleRate / this.bitRate);
    this._bits = [];
    this._bitHead = 0;
    this._phase = 0;
    this._curFreq = band.mark;
    this._bitLeft = 0;
    this._carrierOn = false;
    this._env = 0;
    this._rampStep = 1 / (0.005 * this.sampleRate);
  }
  raiseCarrier() {
    this._carrierOn = true;
  }
  dropCarrier() {
    this._carrierOn = false;
    this._bits.length = 0;
    this._bitHead = 0;
  }
  pushByte(b) {
    b &= 0xff;
    const { space, mark } = this.band;
    this._bits.push(space);
    for (let k = 0; k < 8; k++) this._bits.push((b >> k) & 1 ? mark : space);
    this._bits.push(mark);
  }
  pushBytes(data) {
    for (let i = 0; i < data.length; i++) this.pushByte(data[i]);
  }
  generate(n) {
    const out = new Float32Array(n);
    const twoPiOverSr = (2 * Math.PI) / this.sampleRate;
    for (let i = 0; i < n; i++) {
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
          if (this._bitHead > 8192) {
            this._bits = this._bits.slice(this._bitHead);
            this._bitHead = 0;
          }
        } else {
          this._curFreq = this.band.mark;
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

const RX_IDLE = 0;
const RX_RECEIVING = 1;

class FskDemodulator {
  constructor(band, opts = {}) {
    this.sampleRate = opts.sampleRate || 48000;
    this.bitRate = opts.bitRate || 300;
    this.band = band;
    this.spb = Math.round(this.sampleRate / this.bitRate);
    const f0 = (band.space + band.mark) / 2;
    this._bp = new Biquad(f0, opts.bandwidth || 420, this.sampleRate);
    this._mark = new Correlator(band.mark, this.sampleRate, opts.lpCut || 150);
    this._space = new Correlator(band.space, this.sampleRate, opts.lpCut || 150);
    this._magFast = new OnePole(200, this.sampleRate);
    this._floor = 1e-9;
    this._cdRatio = opts.cdRatio || 6;
    this._cdFloorMin = opts.cdFloorMin != null ? opts.cdFloorMin : 1e-4;
    this._cdHi = 0;
    this._cdLo = 0;
    this._cdHiNeed = Math.round(((opts.cdOnMs || 150) * this.sampleRate) / 1000);
    this._cdLoNeed = Math.round(((opts.cdOffMs || 600) * this.sampleRate) / 1000);
    this.carrierDetected = false;
    this._level = 1;
    this._prevLevel = 1;
    this._hyst = 0.15;
    this._syncOffset = opts.syncOffset != null ? opts.syncOffset : Math.round(0.22 * this.spb);
    this._state = RX_IDLE;
    this._rxCount = 0;
    this._bitIndex = 0;
    this._byte = 0;
    this._bitSamples = [];
    this._w0 = Math.round(0.2 * this.spb);
    this._sub = Math.round(0.2 * this.spb);
    this.stats = { bytes: 0, framingErrors: 0 };
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
    return votes >= 0 ? 1 : 0;
  }
  _sample(x) {
    const f = this._bp.process(x);
    const pm = this._mark.process(f);
    const ps = this._space.process(f);
    const total = pm + ps;
    this._updateCarrier(total);
    const d = (pm - ps) / (total + 1e-9);
    if (d > this._hyst) this._level = 1;
    else if (d < -this._hyst) this._level = 0;
    if (this._state === RX_IDLE) {
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
    this._rxCount++;
    const posInBit = this._rxCount - this._bitIndex * this.spb;
    if (posInBit >= this._w0 && posInBit < this._w0 + 3 * this._sub) this._bitSamples.push(d);
    if (this._rxCount >= (this._bitIndex + 1) * this.spb) {
      const bit = this._decideBit();
      this._bitSamples.length = 0;
      if (this._bitIndex === 0) {
        if (bit !== 0) {
          this.stats.framingErrors++;
          this._state = RX_IDLE;
          this._prevLevel = this._level;
          return;
        }
      } else if (this._bitIndex <= 8) {
        if (bit) this._byte |= 1 << (this._bitIndex - 1);
      } else {
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

class CallingToneGenerator {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 48000;
    this.freq = opts.freq || 1300;
    this.amplitude = opts.amplitude != null ? opts.amplitude : 0.5;
    this._onN = Math.round(((opts.onMs || 400) * this.sampleRate) / 1000);
    this._offN = Math.round(((opts.offMs || 600) * this.sampleRate) / 1000);
    this._phase = 0;
    this._count = 0;
    this._on = true;
  }
  generate(n) {
    const out = new Float32Array(n);
    const step = (2 * Math.PI * this.freq) / this.sampleRate;
    for (let i = 0; i < n; i++) {
      if (this._on) {
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

// ---- processor -------------------------------------------------------------

const DEFAULT_PROFILE = {
  bitRate: 300,
  originate: { space: 1070, mark: 1270 },
  answer: { space: 2025, mark: 2225 },
};

class ModemProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const profile = o.profile || DEFAULT_PROFILE;
    const bitRate = o.bitRate || profile.bitRate || 300;
    const sr = sampleRate; // AudioWorkletGlobalScope global

    // Originate side: transmit in the originate band, listen to the answer band.
    this.mod = new FskModulator(profile.originate, { sampleRate: sr, bitRate });
    this.demod = new FskDemodulator(profile.answer, { sampleRate: sr, bitRate });
    this.callTone = new CallingToneGenerator({ sampleRate: sr });

    this._txMode = 'silence'; // 'call' | 'data' | 'silence'
    this._rx = [];

    this.demod.onbyte = (b) => this._rx.push(b);
    this.demod.oncarrier = () => this.port.postMessage({ type: 'carrier' });
    this.demod.oncarrierloss = () => this.port.postMessage({ type: 'carrierloss' });

    this.port.onmessage = (ev) => this._onCommand(ev.data || {});
  }

  _onCommand(msg) {
    switch (msg.cmd) {
      case 'txmode':
        this._txMode = msg.mode;
        break;
      case 'raise':
        this.mod.raiseCarrier();
        break;
      case 'drop':
        this.mod.dropCarrier();
        break;
      case 'bytes':
        this.mod.pushBytes(msg.bytes);
        break;
      default:
        break;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const inCh = input && input[0];
    const output = outputs[0];
    const outCh = output && output[0];
    const n = outCh ? outCh.length : 128;

    if (inCh && inCh.length) {
      this.demod.process(inCh);
      if (this._rx.length) {
        const bytes = this._rx.slice();
        this._rx.length = 0;
        this.port.postMessage({ type: 'rx', bytes });
      }
    }

    if (outCh) {
      if (this._txMode === 'call') outCh.set(this.callTone.generate(n));
      else if (this._txMode === 'data') outCh.set(this.mod.generate(n));
      else outCh.fill(0);
    }
    return true;
  }
}

registerProcessor('modem-processor', ModemProcessor);
