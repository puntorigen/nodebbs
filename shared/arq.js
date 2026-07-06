'use strict';

// MNP/V.42-style reliable link over the raw FSK byte pipe. Application bytes
// are wrapped in CRC-checked, flag-delimited frames and retransmitted on
// timeout, so a session stays byte-clean over a noisy acoustic channel. An
// optional robust mode adds extended-Hamming FEC + byte interleaving.
//
// This is the canonical CommonJS copy. web/lib/arq.js mirrors it as ESM — keep
// them in sync. Operates on plain byte arrays (Uint8Array / number[]).
//
// Layering:
//   Session bytes  <->  ReliableLink  <->  raw modem byte pipe
//
// Negotiation: the originate side sends ENQ probes; if the answer side replies
// ACKENQ both switch to framed mode (and agree on robust). If no reply after a
// few probes, the originate side falls back to raw passthrough, fully
// compatible with a peer that has no ARQ at all.

const FLAG = 0x7e;
const ESC = 0x7d;
const XOR = 0x20;

const T_DATA = 0x01;
const T_ACK = 0x02;
const T_ENQ = 0x03; // originate -> answer: "do you speak framed?" (carries robust request bit)
const T_ACKENQ = 0x04; // answer -> originate: "yes" (carries agreed robust bit)

// ---- CRC-16/CCITT (0x1021, init 0xFFFF) ------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    t[i] = c & 0xffff;
  }
  return t;
})();

function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

// ---- extended Hamming(8,4) SECDED ------------------------------------------
// Each nibble -> 1 byte codeword (dmin = 4): corrects any single-bit error,
// detects any double-bit error. Two codewords per data byte.

const HAMMING_ENC = (() => {
  const enc = new Uint8Array(16);
  for (let n = 0; n < 16; n++) {
    const d0 = n & 1;
    const d1 = (n >> 1) & 1;
    const d2 = (n >> 2) & 1;
    const d3 = (n >> 3) & 1;
    const p0 = d0 ^ d1 ^ d3;
    const p1 = d0 ^ d2 ^ d3;
    const p2 = d1 ^ d2 ^ d3;
    const p3 = d0 ^ d1 ^ d2 ^ d3 ^ p0 ^ p1 ^ p2; // overall parity
    enc[n] = d0 | (d1 << 1) | (d2 << 2) | (d3 << 3) | (p0 << 4) | (p1 << 5) | (p2 << 6) | (p3 << 7);
  }
  return enc;
})();

function popcount(x) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

// For every possible received byte, precompute the nearest codeword: distance
// <=1 corrects; distance >=2 is an uncorrectable (detected) error.
const HAMMING_DEC = (() => {
  const dec = new Array(256);
  for (let r = 0; r < 256; r++) {
    let bestN = 0;
    let bestD = 9;
    for (let n = 0; n < 16; n++) {
      const d = popcount(r ^ HAMMING_ENC[n]);
      if (d < bestD) {
        bestD = d;
        bestN = n;
      }
    }
    dec[r] = { nibble: bestN, dist: bestD };
  }
  return dec;
})();

function hammingEncode(bytes) {
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    out[i * 2] = HAMMING_ENC[bytes[i] & 0x0f];
    out[i * 2 + 1] = HAMMING_ENC[(bytes[i] >> 4) & 0x0f];
  }
  return out;
}

// Returns { bytes, uncorrectable } — uncorrectable counts detected double
// errors (the frame's CRC check is the final backstop regardless).
function hammingDecode(code) {
  const n = code.length >> 1;
  const out = new Uint8Array(n);
  let uncorrectable = 0;
  for (let i = 0; i < n; i++) {
    const lo = HAMMING_DEC[code[i * 2]];
    const hi = HAMMING_DEC[code[i * 2 + 1]];
    if (lo.dist >= 2) uncorrectable++;
    if (hi.dist >= 2) uncorrectable++;
    out[i] = (lo.nibble & 0x0f) | ((hi.nibble & 0x0f) << 4);
  }
  return { bytes: out, uncorrectable };
}

// ---- byte interleaving (depth 4) -------------------------------------------
// Spreads a short burst of channel errors across multiple Hamming codewords so
// each carries at most one bad bit. Row-major write, column-major read.

const INTERLEAVE_DEPTH = 4;

function interleave(bytes) {
  const n = bytes.length;
  const rows = INTERLEAVE_DEPTH;
  const cols = Math.ceil(n / rows);
  const out = new Uint8Array(rows * cols);
  for (let i = 0; i < n; i++) out[i] = bytes[i];
  const res = new Uint8Array(rows * cols);
  let k = 0;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) res[k++] = out[r * cols + c];
  }
  return { data: res, originalLen: n };
}

function deinterleave(bytes, originalLen) {
  const rows = INTERLEAVE_DEPTH;
  const cols = Math.ceil(bytes.length / rows);
  const grid = new Uint8Array(rows * cols);
  let k = 0;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) grid[r * cols + c] = bytes[k++];
  }
  return grid.subarray(0, originalLen);
}

// ---- byte stuffing ---------------------------------------------------------

function stuff(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === FLAG || b === ESC) {
      out.push(ESC, b ^ XOR);
    } else {
      out.push(b);
    }
  }
  return out;
}

// ---- reliable link ---------------------------------------------------------

const MODE_NEGOTIATING = 'negotiating';
const MODE_RELIABLE = 'reliable';
const MODE_RAW = 'raw';

class ReliableLink {
  constructor(opts = {}) {
    this.role = opts.role || 'originate';
    this.robustRequested = !!opts.robust;
    this.robust = false; // agreed after negotiation
    // Shorter frames survive a noisy line far better: a 64-byte frame is ~600
    // bits, so even 1% BER corrupts almost every one. 32 bytes halves that.
    this.maxPayload = opts.maxPayload || 32;
    this.windowSize = opts.windowSize || 2;
    this.rtoMs = opts.rtoMs || 1400; // ~2x a full frame at 30 B/s
    this.maxRetries = opts.maxRetries || 20; // warn after this, but keep trying
    this.probeRetries = opts.probeRetries || 12;
    this.now = opts.now || (() => Date.now());

    this._sendWire = opts.sendWire || (() => {});
    this.onData = opts.onData || (() => {});
    this.onUp = opts.onUp || (() => {});
    this.onRaw = opts.onRaw || (() => {});
    this.onDown = opts.onDown || (() => {});

    this.mode = MODE_NEGOTIATING;

    // TX (go-back-N-ish sliding window).
    this._appTx = []; // queued app bytes awaiting framing
    this._sendBase = 0;
    this._nextSeq = 0;
    this._unacked = new Map(); // seq -> { frame, sentAt, tries }

    // RX.
    this._rxExpected = 0;
    this._rxState = 0; // 0 idle, 1 in-frame
    this._rxEsc = false;
    this._rxBuf = [];

    // Negotiation.
    this._probes = 0;
    this._probeAt = 0;
    this._frameAttempts = 0; // frame-shaped blobs seen (proves a peer is there)

    this.stats = {
      framesSent: 0,
      framesRecv: 0,
      retransmits: 0,
      crcErrors: 0,
      fecCorrected: 0,
      fecUncorrectable: 0,
      dupFrames: 0,
    };
  }

  // Overall link quality 0..1 from CRC failures vs frames received.
  quality() {
    const total = this.stats.framesRecv + this.stats.crcErrors;
    if (total === 0) return 1;
    return this.stats.framesRecv / total;
  }

  start() {
    if (this.role === 'originate') {
      this.mode = MODE_NEGOTIATING;
      this._sendProbe();
    }
    // The answer side stays passive until it hears an ENQ (or, failing that,
    // treats arriving bytes as raw once data shows up without negotiation).
  }

  _sendProbe() {
    this._probes++;
    this._probeAt = this.now();
    // ENQ payload byte 0: robust requested?
    this._transmit(T_ENQ, 0, [this.robustRequested ? 1 : 0], /*forceRaw*/ true);
  }

  // ---- framing / wire --------------------------------------------------------

  _buildFrame(type, seq, payload) {
    const body = [type, seq & 0xff, payload.length & 0xff];
    for (let i = 0; i < payload.length; i++) body.push(payload[i] & 0xff);
    const crc = crc16(body);
    body.push((crc >> 8) & 0xff, crc & 0xff);
    let coded = Uint8Array.from(body);
    if (this.robust) {
      const il = interleave(hammingEncode(coded));
      // Prefix a length byte (of the pre-interleave code length) so the RX can
      // deinterleave/trim. That byte is itself Hamming-protected.
      const codeLen = hammingEncode(coded).length;
      const lenByte = hammingEncode(Uint8Array.of(codeLen & 0xff)); // 2 bytes
      const merged = new Uint8Array(lenByte.length + il.data.length);
      merged.set(lenByte, 0);
      merged.set(il.data, lenByte.length);
      coded = merged;
    }
    return Uint8Array.from([FLAG, ...stuff(coded), FLAG]);
  }

  // forceRaw builds a frame even during negotiation (ENQ/ACKENQ never robust).
  _transmit(type, seq, payload, forceRaw) {
    const wasRobust = this.robust;
    if (forceRaw) this.robust = false;
    const frame = this._buildFrame(type, seq, payload);
    this.robust = wasRobust;
    this._sendWire(frame);
    return frame;
  }

  receiveWire(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === FLAG) {
        if (this._rxState === 1 && this._rxBuf.length) this._onFrameBytes(this._rxBuf);
        this._rxBuf = [];
        this._rxState = 1;
        this._rxEsc = false;
        continue;
      }
      if (this._rxState !== 1) continue;
      if (b === ESC) {
        this._rxEsc = true;
        continue;
      }
      this._rxBuf.push(this._rxEsc ? b ^ XOR : b);
      this._rxEsc = false;
    }
  }

  // Try to recover a frame from received bytes under a given coding. Returns
  // { type, seq, payload, fec } or null if the CRC doesn't check out.
  _parseFrame(raw, robust) {
    let body;
    let fec = 0;
    if (robust) {
      if (raw.length < 4) return null;
      // First two bytes are the Hamming-coded original code length.
      const codeLen = hammingDecode(Uint8Array.of(raw[0], raw[1])).bytes[0];
      const payloadCode = deinterleave(Uint8Array.from(raw.slice(2)), codeLen);
      const dec = hammingDecode(payloadCode);
      fec = dec.uncorrectable;
      body = dec.bytes;
    } else {
      body = Uint8Array.from(raw);
    }
    if (body.length < 5) return null; // type+seq+len+crc(2) minimum
    const len = body[2];
    if (body.length < 3 + len + 2) return null;
    const rxCrc = (body[3 + len] << 8) | body[3 + len + 1];
    if (rxCrc !== crc16(body.subarray(0, 3 + len))) return null;
    return { type: body[0], seq: body[1], payload: body.subarray(3, 3 + len), fec };
  }

  _onFrameBytes(raw) {
    this._frameAttempts++;
    // Data rides the negotiated coding, but ENQ/ACKENQ are always raw. Try the
    // robust decode first when active, then fall back to raw so negotiation
    // frames still get through after robust mode is established.
    let frame = null;
    if (this.robust && this.mode === MODE_RELIABLE) frame = this._parseFrame(raw, true);
    if (!frame) frame = this._parseFrame(raw, false);
    if (!frame) {
      this.stats.crcErrors++;
      return; // dropped like a lost frame; sender will retransmit
    }
    if (frame.fec) this.stats.fecUncorrectable += frame.fec;
    this.stats.framesRecv++;
    this._handleFrame(frame.type, frame.seq, frame.payload);
  }

  _handleFrame(type, seq, payload) {
    if (type === T_ENQ) {
      // Answer side agrees to framed mode; robust = both want it. Idempotent:
      // a retransmitted ENQ just gets ACKENQ'd again.
      const agreed = this.robustRequested && payload[0] === 1;
      this.robust = agreed;
      this._transmit(T_ACKENQ, 0, [agreed ? 1 : 0], /*forceRaw*/ true);
      if (this.mode !== MODE_RELIABLE) {
        this.mode = MODE_RELIABLE;
        this.onUp({ robust: this.robust });
        this._pump();
      }
      return;
    }
    if (type === T_ACKENQ) {
      if (this.mode !== MODE_RELIABLE) {
        this.robust = this.robustRequested && payload[0] === 1;
        this.mode = MODE_RELIABLE;
        this.onUp({ robust: this.robust });
        this._pump();
      }
      return;
    }
    if (type === T_ACK) {
      if (this.mode === MODE_NEGOTIATING) this._becomeReliable();
      this._onAck(seq);
      return;
    }
    if (type === T_DATA) {
      // Receiving framed data proves the peer speaks framed; adopt reliable.
      if (this.mode === MODE_NEGOTIATING) this._becomeReliable();
      if (seq === this._rxExpected) {
        this._rxExpected = (this._rxExpected + 1) & 0xff;
        this.onData(payload);
      } else {
        this.stats.dupFrames++;
      }
      // Cumulative ACK carries the next sequence we expect (everything before
      // it is acknowledged). "Expect 0" cleanly means "nothing received yet".
      this._transmit(T_ACK, this._rxExpected & 0xff, []);
      return;
    }
  }

  _becomeReliable() {
    this.mode = MODE_RELIABLE;
    this.onUp({ robust: this.robust });
    this._pump();
  }

  _onAck(ackNext) {
    // ackNext = next seq the peer expects; free every unacked frame before it.
    const span = (ackNext - this._sendBase) & 0xff;
    if (span === 0 || span > this.windowSize) return; // stale / duplicate ACK
    for (const seq of [...this._unacked.keys()]) {
      if (((seq - this._sendBase) & 0xff) < span) this._unacked.delete(seq);
    }
    this._sendBase = ackNext;
    this._pump();
  }

  // ---- application API -------------------------------------------------------

  send(data) {
    if (this.mode === MODE_RAW) {
      this._sendWire(Uint8Array.from(data));
      return;
    }
    for (let i = 0; i < data.length; i++) this._appTx.push(data[i] & 0xff);
    this._pump();
  }

  _pump() {
    if (this.mode !== MODE_RELIABLE) return;
    while (this._unacked.size < this.windowSize && this._appTx.length > 0) {
      const chunk = this._appTx.splice(0, this.maxPayload);
      const seq = this._nextSeq;
      this._nextSeq = (this._nextSeq + 1) & 0xff;
      const frame = this._transmit(T_DATA, seq, chunk);
      this._unacked.set(seq, { payload: chunk, sentAt: this.now(), tries: 1 });
      this.stats.framesSent++;
    }
  }

  tick() {
    const t = this.now();
    if (this.mode === MODE_NEGOTIATING && this.role === 'originate') {
      if (t - this._probeAt >= this.rtoMs) {
        // Keep probing as long as *some* framing is coming back (a lossy but
        // live ARQ peer). Only fall back to raw for a peer that never sends a
        // single frame after several probes — e.g. a dumb terminal.
        if (this._frameAttempts === 0 && this._probes >= this.probeRetries) {
          this.mode = MODE_RAW;
          this.onRaw();
        } else {
          this._sendProbe();
        }
      }
      return;
    }
    if (this.mode !== MODE_RELIABLE) return;
    // Retransmit the oldest unacked frame whose timer expired. We never switch
    // a live reliable session to raw mid-stream (that would corrupt the byte
    // stream); we just keep retrying and flag a poor link once. The modem's
    // carrier-loss detection tears down a genuinely dead call.
    for (const [seq, info] of this._unacked) {
      if (t - info.sentAt >= this.rtoMs) {
        if (info.tries === this.maxRetries && !this._warnedDown) {
          this._warnedDown = true;
          this.onDown('poor link — sustained retransmits');
        }
        this._transmit(T_DATA, seq, info.payload);
        info.sentAt = t;
        info.tries++;
        this.stats.retransmits++;
      }
    }
  }
}

module.exports = {
  FLAG,
  ESC,
  XOR,
  crc16,
  hammingEncode,
  hammingDecode,
  interleave,
  deinterleave,
  ReliableLink,
  MODE_NEGOTIATING,
  MODE_RELIABLE,
  MODE_RAW,
};
