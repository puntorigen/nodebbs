'use strict';

// Originate-side acoustic modem for the CLI: dials with a diegetic dial
// tone + DTMF, transmits a real V.25 calling tone, waits for the answer
// carrier, then runs a Bell 103 FSK link (with the ARQ layer) over the
// speaker and microphone. This is the acoustic alternative to the WebSocket
// dialer; it is only used with `--audio`.

const {
  PROFILES,
  FskModulator,
  FskDemodulator,
  CallingToneGenerator,
  DEFAULT_SR,
} = require('../../shared/fsk');
const { ReliableLink } = require('../../shared/arq');
const audioIO = require('../../shared/audio-io');

// ---- diegetic dial prologue (flavor) --------------------------------------

const DTMF = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  0: [941, 1336],
};

// Build ~2 s of: dial tone, then DTMF for a phone number. Pure flavor before
// the real signaling begins.
function synthDialPrologue(sampleRate, number = '5551212') {
  const parts = [];
  const tone = (freqs, ms, amp = 0.28) => {
    const n = Math.round((ms / 1000) * sampleRate);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / sampleRate);
      const ramp = Math.min(1, Math.min(i, n - i) / (0.004 * sampleRate));
      s[i] = amp * (v / freqs.length) * Math.max(0, ramp);
    }
    return s;
  };
  const silence = (ms) => new Float32Array(Math.round((ms / 1000) * sampleRate));

  parts.push(tone([350, 440], 700)); // North American dial tone
  parts.push(silence(150));
  for (const d of number) {
    const f = DTMF[d];
    if (f) {
      parts.push(tone(f, 110, 0.3));
      parts.push(silence(70));
    }
  }
  parts.push(silence(200));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---- modem client ----------------------------------------------------------

const S_DIAL = 'dial';
const S_CALL = 'call';
const S_TRAIN = 'train';
const S_CONNECTED = 'connected';
const S_DEAD = 'dead';

class AudioModemClient {
  constructor(opts = {}) {
    this.robust = !!opts.robust;
    this.sampleRate = opts.sampleRate || DEFAULT_SR;
    // Injectable for headless testing; defaults to the real sox-backed I/O and
    // real clock/timers.
    this.audio = opts.audio || audioIO;
    this.now = opts.now || (() => Date.now());
    this.setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer || ((id) => clearTimeout(id));
    this.onStatus = opts.onStatus || (() => {});
    this.onData = opts.onData || (() => {});
    this.onConnect = opts.onConnect || (() => {});
    this.onNoCarrier = opts.onNoCarrier || (() => {});

    this.profile = PROFILES.bell103;
    this.state = S_DIAL;

    // TX on the originate band; RX on the server's answer band.
    this.mod = new FskModulator(this.profile.originate, { sampleRate: this.sampleRate, bitRate: this.profile.bitRate });
    this.demod = new FskDemodulator(this.profile.answer, { sampleRate: this.sampleRate, bitRate: this.profile.bitRate });
    this.callTone = new CallingToneGenerator({ sampleRate: this.sampleRate });

    this.mic = null;
    this.speaker = null;
    this.link = null;

    this._prologue = synthDialPrologue(this.sampleRate);
    this._proPos = 0;
    this._rxBytes = [];
    this._noAnswerTimer = null;
  }

  start() {
    this.mic = this.audio.openMic({ sampleRate: this.sampleRate });
    this.speaker = this.audio.openSpeaker({ sampleRate: this.sampleRate });

    const onErr = (err) => {
      this._fail(err.code === 'SOX_MISSING' ? err.message : `AUDIO ERROR — ${err.message}`);
    };
    this.mic.on('error', onErr);
    this.speaker.on('error', onErr);

    this.demod.onbyte = (b) => this._rxBytes.push(b);
    this.demod.oncarrier = () => this._onAnswerCarrier();
    this.demod.oncarrierloss = () => this._onCarrierLoss();

    this.mic.on('block', (block) => this._onMicBlock(block));

    this.onStatus('DIALING');
    this._noAnswerTimer = this.setTimer(() => {
      if (this.state === S_CALL || this.state === S_DIAL) this._fail('NO ANSWER');
    }, 30000);
  }

  _onMicBlock(block) {
    // RX: always demodulate the answer band.
    this.demod.process(block);
    if (this._rxBytes.length) {
      const bytes = Uint8Array.from(this._rxBytes);
      this._rxBytes.length = 0;
      if (this.link) this.link.receiveWire(bytes);
    }

    // TX: source depends on the dial phase.
    this.speaker.write(this._txBlock(block.length));

    if (this.link) this.link.tick();
  }

  _txBlock(n) {
    if (this.state === S_DIAL) {
      const out = new Float32Array(n);
      const remaining = this._prologue.length - this._proPos;
      const take = Math.min(n, Math.max(0, remaining));
      if (take > 0) {
        out.set(this._prologue.subarray(this._proPos, this._proPos + take), 0);
        this._proPos += take;
      }
      if (this._proPos >= this._prologue.length) {
        this.state = S_CALL;
        this.onStatus('RINGING');
      }
      return out;
    }
    if (this.state === S_CALL) return this.callTone.generate(n);
    // S_TRAIN / S_CONNECTED: the FSK carrier + framed data.
    return this.mod.generate(n);
  }

  _onAnswerCarrier() {
    if (this.state !== S_CALL) return;
    this.state = S_TRAIN;
    this.onStatus('CARRIER DETECT');
    if (this._noAnswerTimer) {
      this.clearTimer(this._noAnswerTimer);
      this._noAnswerTimer = null;
    }
    // Raise our own carrier so the answer side locks, then start the reliable
    // link. A short delay lets the server's carrier detect settle before our
    // first ENQ, so it isn't clipped by the ~150 ms detect window.
    this.mod.raiseCarrier();
    this.onStatus('TRAINING');
    this.setTimer(() => {
      if (this.state !== S_TRAIN) return;
      this._startLink();
    }, 450);
  }

  _startLink() {
    this.link = new ReliableLink({
      role: 'originate',
      robust: this.robust,
      now: this.now,
      sendWire: (frame) => this.mod.pushBytes(frame),
      onData: (bytes) => this.onData(Buffer.from(bytes)),
      onUp: ({ robust }) => this._goConnected(robust ? 'CONNECT 300/REL-FEC' : 'CONNECT 300/REL'),
      onRaw: () => this._goConnected('CONNECT 300'),
    });
    this.link.start();
  }

  _goConnected(banner) {
    if (this.state === S_CONNECTED) return;
    this.state = S_CONNECTED;
    this.onStatus(banner);
    this.onConnect();
  }

  // Called by index.js with raw keystroke bytes from stdin.
  sendInput(buf) {
    if (this.state !== S_CONNECTED || !this.link) return;
    this.link.send(Uint8Array.from(buf));
  }

  _onCarrierLoss() {
    if (this.state === S_CONNECTED || this.state === S_TRAIN) {
      this._fail('NO CARRIER');
    }
  }

  hangup() {
    this.mod.dropCarrier();
    this.stop();
  }

  _fail(reason) {
    if (this.state === S_DEAD) return;
    this.state = S_DEAD;
    this.onNoCarrier(reason);
    this.stop();
  }

  stop() {
    if (this._noAnswerTimer) {
      this.clearTimer(this._noAnswerTimer);
      this._noAnswerTimer = null;
    }
    if (this.mic) this.mic.close();
    if (this.speaker) this.speaker.close();
    this.mic = this.speaker = null;
  }
}

module.exports = { AudioModemClient, synthDialPrologue };
