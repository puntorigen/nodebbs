'use strict';

// Answer-side acoustic modem: an optional, additional line into the same BBS
// as the WebSocket listener. It sits idle listening for a caller's V.25
// calling tone, answers with a carrier, and once the caller's carrier locks it
// builds a ws-shim so the existing Session runs unchanged over sound.
//
// One session per sound card — the line is genuinely busy while connected,
// exactly like a single phone line.

const { Session } = require('../session');
const presence = require('../lib/presence');
const {
  PROFILES,
  FskModulator,
  FskDemodulator,
  CallingToneDetector,
  DEFAULT_SR,
} = require('../../../shared/fsk');
const { ReliableLink } = require('../../../shared/arq');
const audioIO = require('../../../shared/audio-io');

const STATE_IDLE = 'idle';
const STATE_ANSWERING = 'answering';
const STATE_CONNECTED = 'connected';

class AudioModemServer {
  constructor(opts = {}) {
    this.meta = opts.meta || {};
    this.screens = opts.screens;
    this.robust = !!opts.robust;
    this.sampleRate = opts.sampleRate || DEFAULT_SR;
    this.log = opts.log || console.log;
    // Injectable for headless testing; defaults to the real sox-backed I/O and
    // real clock/timers.
    this.audio = opts.audio || audioIO;
    this.now = opts.now || (() => Date.now());
    this.setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer || ((id) => clearTimeout(id));

    this.profile = PROFILES.bell103;
    this.state = STATE_IDLE;

    this.mic = null;
    this.speaker = null;
    this.session = null;
    this.link = null;

    // TX on the answer band; RX on the caller's originate band.
    this.mod = new FskModulator(this.profile.answer, { sampleRate: this.sampleRate, bitRate: this.profile.bitRate });
    this.demod = new FskDemodulator(this.profile.originate, { sampleRate: this.sampleRate, bitRate: this.profile.bitRate });
    this.callTone = new CallingToneDetector({ sampleRate: this.sampleRate });

    this._answerTimer = null;
    this._rxBytes = [];
  }

  start() {
    this.mic = this.audio.openMic({ sampleRate: this.sampleRate });
    this.speaker = this.audio.openSpeaker({ sampleRate: this.sampleRate });

    const onErr = (err) => {
      this.log(`[audio] ${err.message}`);
      if (err.code === 'SOX_MISSING') this.stop();
    };
    this.mic.on('error', onErr);
    this.speaker.on('error', onErr);

    // Route demodulated bytes: buffer per block, then hand to the link (or,
    // pre-negotiation, straight to the session as raw input).
    this.demod.onbyte = (b) => this._rxBytes.push(b);
    this.demod.oncarrier = () => this._onCallerCarrier();
    this.demod.oncarrierloss = () => this._onCallerCarrierLoss();

    this.callTone.ondetected = () => this._answer();

    this.mic.on('block', (block) => this._onMicBlock(block));

    this.log('[audio] line open — listening for a caller (V.25 calling tone)…');
  }

  _onMicBlock(block) {
    // RX: while idle, listen for the cadenced calling tone; always run the
    // demodulator (its carrier detect drives the connect/hangup transitions).
    if (this.state === STATE_IDLE) this.callTone.process(block);
    this.demod.process(block);

    // Deliver any bytes the demod produced this block.
    if (this._rxBytes.length) {
      const bytes = Uint8Array.from(this._rxBytes);
      this._rxBytes.length = 0;
      if (this.link) this.link.receiveWire(bytes);
    }

    // TX: generate an equal-length block so playback keeps pace with capture.
    this.speaker.write(this.mod.generate(block.length));

    if (this.link) this.link.tick();
  }

  _answer() {
    if (this.state !== STATE_IDLE) return;
    this.state = STATE_ANSWERING;
    this.log('[audio] calling tone — answering (raising carrier)…');
    // The answer-band idle mark (2225 Hz) is the Bell 103 answer tone; raising
    // the carrier both answers and holds the line.
    this.mod.raiseCarrier();
    // Fresh carrier detect so we react to the caller's *new* originate carrier,
    // not to the calling-tone beeps we heard while idle.
    this.demod.carrierDetected = false;
    this.demod.reset();
    this._answerTimer = this.setTimer(() => {
      if (this.state === STATE_ANSWERING) {
        this.log('[audio] no caller carrier — returning to idle.');
        this._toIdle();
      }
    }, 12000);
  }

  _onCallerCarrier() {
    if (this.state !== STATE_ANSWERING) return;
    if (this._answerTimer) {
      this.clearTimer(this._answerTimer);
      this._answerTimer = null;
    }
    this._connect();
  }

  _connect() {
    this.state = STATE_CONNECTED;

    // The reliable link (answer role) waits for the caller's ENQ. Its raw wire
    // is the modulator; delivered payload bytes are session keystroke input.
    this.link = new ReliableLink({
      role: 'answer',
      robust: this.robust,
      now: this.now,
      sendWire: (frame) => this.mod.pushBytes(frame),
      onData: (bytes) => this.session && this.session.feedInput(Buffer.from(bytes)),
      onUp: ({ robust }) => this.log(`[audio] CONNECT 300${robust ? '/REL-FEC' : '/REL'}`),
      onRaw: () => this.log('[audio] caller has no ARQ — raw 300 baud'),
      onDown: (why) => this.log(`[audio] ${why}`),
    });

    // ws-shim: Session writes ANSI strings; we frame + modulate them. close()
    // drops the carrier, which the caller sees as NO CARRIER.
    const shim = {
      send: (str) => {
        const bytes = Buffer.from(String(str), 'utf8');
        if (this.link.mode === 'raw') this.mod.pushBytes(bytes);
        else this.link.send(bytes);
      },
      close: () => this._hangup(),
    };

    this.session = new Session(shim, { meta: this.meta, screens: this.screens });
    presence.register(this.session);
    this.log(`[audio] carrier locked — session #${this.session.id} on the phone line (${presence.count()} online)`);
    this.session.start();
  }

  _onCallerCarrierLoss() {
    if (this.state === STATE_CONNECTED) {
      this.log('[audio] NO CARRIER — caller hung up.');
      this._hangup();
    }
  }

  _hangup() {
    if (this.session) {
      const q = this.link ? Math.round(this.link.quality() * 100) : 100;
      this.log(`[audio] line quality this call: ${q}%`);
      this.session.handleClose();
      presence.unregister(this.session);
    }
    this._toIdle();
  }

  _toIdle() {
    if (this._answerTimer) {
      this.clearTimer(this._answerTimer);
      this._answerTimer = null;
    }
    this.mod.dropCarrier();
    this.demod.reset();
    this.demod.carrierDetected = false;
    this.session = null;
    this.link = null;
    this._rxBytes.length = 0;
    // Rebuild the calling-tone detector so the next caller starts clean.
    this.callTone = new CallingToneDetector({ sampleRate: this.sampleRate });
    this.callTone.ondetected = () => this._answer();
    this.state = STATE_IDLE;
    this.log('[audio] line idle — listening for the next caller…');
  }

  stop() {
    if (this.session) {
      try {
        this.session.handleClose();
        presence.unregister(this.session);
      } catch (_) {
        /* ignore */
      }
    }
    if (this.mic) this.mic.close();
    if (this.speaker) this.speaker.close();
    this.mic = this.speaker = this.session = this.link = null;
    this.state = STATE_IDLE;
  }
}

module.exports = { AudioModemServer };
