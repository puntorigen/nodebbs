// MNP/V.42-style reliable link over the raw FSK byte pipe (browser ESM mirror
// of shared/arq.js).
//
// NOTE: mirrored from shared/arq.js (canonical, CommonJS). Keep them in sync —
// the logic is identical; only the module syntax differs. Operates on plain
// byte arrays (Uint8Array / number[]).

const FLAG = 0x7e;
const ESC = 0x7d;
const XOR = 0x20;

const T_DATA = 0x01;
const T_ACK = 0x02;
const T_ENQ = 0x03;
const T_ACKENQ = 0x04;

// ---- CRC-16/CCITT ----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    t[i] = c & 0xffff;
  }
  return t;
})();

export function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

// ---- extended Hamming(8,4) SECDED ------------------------------------------

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
    const p3 = d0 ^ d1 ^ d2 ^ d3 ^ p0 ^ p1 ^ p2;
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

export function hammingEncode(bytes) {
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    out[i * 2] = HAMMING_ENC[bytes[i] & 0x0f];
    out[i * 2 + 1] = HAMMING_ENC[(bytes[i] >> 4) & 0x0f];
  }
  return out;
}

export function hammingDecode(code) {
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

const INTERLEAVE_DEPTH = 4;

export function interleave(bytes) {
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

export function deinterleave(bytes, originalLen) {
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
    if (b === FLAG || b === ESC) out.push(ESC, b ^ XOR);
    else out.push(b);
  }
  return out;
}

// ---- reliable link ---------------------------------------------------------

export const MODE_NEGOTIATING = 'negotiating';
export const MODE_RELIABLE = 'reliable';
export const MODE_RAW = 'raw';

export class ReliableLink {
  constructor(opts = {}) {
    this.role = opts.role || 'originate';
    this.robustRequested = !!opts.robust;
    this.robust = false;
    this.maxPayload = opts.maxPayload || 32;
    this.windowSize = opts.windowSize || 2;
    this.rtoMs = opts.rtoMs || 1400;
    this.maxRetries = opts.maxRetries || 20;
    this.probeRetries = opts.probeRetries || 12;
    this.now = opts.now || (() => Date.now());

    this._sendWire = opts.sendWire || (() => {});
    this.onData = opts.onData || (() => {});
    this.onUp = opts.onUp || (() => {});
    this.onRaw = opts.onRaw || (() => {});
    this.onDown = opts.onDown || (() => {});

    this.mode = MODE_NEGOTIATING;

    this._appTx = [];
    this._sendBase = 0;
    this._nextSeq = 0;
    this._unacked = new Map();

    this._rxExpected = 0;
    this._rxState = 0;
    this._rxEsc = false;
    this._rxBuf = [];

    this._probes = 0;
    this._probeAt = 0;
    this._frameAttempts = 0;

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
  }

  _sendProbe() {
    this._probes++;
    this._probeAt = this.now();
    this._transmit(T_ENQ, 0, [this.robustRequested ? 1 : 0], true);
  }

  _buildFrame(type, seq, payload) {
    const body = [type, seq & 0xff, payload.length & 0xff];
    for (let i = 0; i < payload.length; i++) body.push(payload[i] & 0xff);
    const crc = crc16(body);
    body.push((crc >> 8) & 0xff, crc & 0xff);
    let coded = Uint8Array.from(body);
    if (this.robust) {
      const il = interleave(hammingEncode(coded));
      const codeLen = hammingEncode(coded).length;
      const lenByte = hammingEncode(Uint8Array.of(codeLen & 0xff));
      const merged = new Uint8Array(lenByte.length + il.data.length);
      merged.set(lenByte, 0);
      merged.set(il.data, lenByte.length);
      coded = merged;
    }
    return Uint8Array.from([FLAG, ...stuff(coded), FLAG]);
  }

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

  _parseFrame(raw, robust) {
    let body;
    let fec = 0;
    if (robust) {
      if (raw.length < 4) return null;
      const codeLen = hammingDecode(Uint8Array.of(raw[0], raw[1])).bytes[0];
      const payloadCode = deinterleave(Uint8Array.from(raw.slice(2)), codeLen);
      const dec = hammingDecode(payloadCode);
      fec = dec.uncorrectable;
      body = dec.bytes;
    } else {
      body = Uint8Array.from(raw);
    }
    if (body.length < 5) return null;
    const len = body[2];
    if (body.length < 3 + len + 2) return null;
    const rxCrc = (body[3 + len] << 8) | body[3 + len + 1];
    if (rxCrc !== crc16(body.subarray(0, 3 + len))) return null;
    return { type: body[0], seq: body[1], payload: body.subarray(3, 3 + len), fec };
  }

  _onFrameBytes(raw) {
    this._frameAttempts++;
    let frame = null;
    if (this.robust && this.mode === MODE_RELIABLE) frame = this._parseFrame(raw, true);
    if (!frame) frame = this._parseFrame(raw, false);
    if (!frame) {
      this.stats.crcErrors++;
      return;
    }
    if (frame.fec) this.stats.fecUncorrectable += frame.fec;
    this.stats.framesRecv++;
    this._handleFrame(frame.type, frame.seq, frame.payload);
  }

  _handleFrame(type, seq, payload) {
    if (type === T_ENQ) {
      const agreed = this.robustRequested && payload[0] === 1;
      this.robust = agreed;
      this._transmit(T_ACKENQ, 0, [agreed ? 1 : 0], true);
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
      if (this.mode === MODE_NEGOTIATING) this._becomeReliable();
      if (seq === this._rxExpected) {
        this._rxExpected = (this._rxExpected + 1) & 0xff;
        this.onData(payload);
      } else {
        this.stats.dupFrames++;
      }
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
    const span = (ackNext - this._sendBase) & 0xff;
    if (span === 0 || span > this.windowSize) return;
    for (const seq of [...this._unacked.keys()]) {
      if (((seq - this._sendBase) & 0xff) < span) this._unacked.delete(seq);
    }
    this._sendBase = ackNext;
    this._pump();
  }

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
      this._transmit(T_DATA, seq, chunk);
      this._unacked.set(seq, { payload: chunk, sentAt: this.now(), tries: 1 });
      this.stats.framesSent++;
    }
  }

  tick() {
    const t = this.now();
    if (this.mode === MODE_NEGOTIATING && this.role === 'originate') {
      if (t - this._probeAt >= this.rtoMs) {
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
