// Transport abstraction for the web client. The terminal (CrtTerminal) speaks
// to one of these, never to a WebSocket or AudioContext directly:
//
//   createWsTransport({ url })      — the default INTERNET line (WebSocket)
//   createAudioTransport({ robust }) — the PHONE LINE (real acoustic modem via
//                                      getUserMedia + the fsk-worklet)
//   createLoopbackTransport({...})   — ?loopback=1 DSP self-test: a full
//                                      originate+answer modem pair wired through
//                                      a virtual "air" in-process, no hardware
//
// Common interface (assign the callbacks, then call start()):
//   .kind                      'internet' | 'phone' | 'loopback'
//   .hasControlChannel         true only for WebSocket (cols/rows resize)
//   .start()                   begin dialing
//   .send(bytes|string)        keystrokes to the far side
//   .sendControl(kind,cols,rows) resize control frame (no-op without a channel)
//   .close()                   hang up / tear down
//   onOpen()                   link is live
//   onData(bytesOrString)      bytes from the far side
//   onClose()                  carrier lost / socket closed
//   onStatus(label)            dial-progress banner (CARRIER DETECT, CONNECT…)
//   onError(msg)               fatal dial failure (NO ANSWER, MIC DENIED…)

import {
  PROFILES,
  FskModulator,
  FskDemodulator,
  CallingToneGenerator,
  CallingToneDetector,
} from './fsk.js';
import { ReliableLink } from './arq.js';

function makeTransport(kind) {
  return {
    kind,
    hasControlChannel: false,
    onOpen: null,
    onData: null,
    onClose: null,
    onStatus: null,
    onError: null,
    start() {},
    send() {},
    sendControl() {},
    close() {},
  };
}

const toBytes = (data) =>
  data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));

// ---- WebSocket (INTERNET) --------------------------------------------------

export function createWsTransport({ url }) {
  const t = makeTransport('internet');
  t.hasControlChannel = true;
  let ws = null;
  let opened = false;
  let closedByUs = false;

  t.start = () => {
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      opened = true;
      t.onOpen && t.onOpen();
    };
    ws.onmessage = (ev) => {
      const chunk = typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data);
      t.onData && t.onData(chunk);
    };
    ws.onclose = () => {
      if (!closedByUs) t.onClose && t.onClose();
    };
    ws.onerror = () => {
      if (!opened) t.onError && t.onError('NO ANSWER');
    };
  };

  t.send = (data) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(toBytes(data));
  };

  t.sendControl = (kind, cols, rows) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: kind, cols, rows }));
    }
  };

  t.close = () => {
    closedByUs = true;
    if (ws) {
      try {
        ws.close();
      } catch (_) {
        /* ignore */
      }
    }
  };

  return t;
}

// ---- real acoustic modem (PHONE LINE) --------------------------------------

export function createAudioTransport({ robust = false } = {}) {
  const t = makeTransport('phone');
  let ctx = null;
  let node = null;
  let micStream = null;
  let micSrc = null;
  let link = null;
  let tickTimer = null;
  let noAnswerTimer = null;
  let phase = 'idle'; // idle | call | train | connected | dead

  const status = (s) => t.onStatus && t.onStatus(s);

  function fail(msg) {
    if (phase === 'dead') return;
    phase = 'dead';
    t.onError && t.onError(msg);
    teardown();
  }

  function startLink() {
    link = new ReliableLink({
      role: 'originate',
      robust,
      sendWire: (frame) => node && node.port.postMessage({ cmd: 'bytes', bytes: Array.from(frame) }),
      onData: (bytes) => t.onData && t.onData(Uint8Array.from(bytes)),
      onUp: ({ robust: r }) => goConnected(r ? 'CONNECT 300/REL-FEC' : 'CONNECT 300/REL'),
      onRaw: () => goConnected('CONNECT 300'),
      onDown: (why) => status(why),
    });
    link.start();
  }

  function goConnected(banner) {
    if (phase === 'connected') return;
    phase = 'connected';
    status(banner);
    t.onOpen && t.onOpen();
  }

  function onAnswerCarrier() {
    if (phase !== 'call') return;
    phase = 'train';
    if (noAnswerTimer) {
      clearTimeout(noAnswerTimer);
      noAnswerTimer = null;
    }
    status('CARRIER DETECT');
    node.port.postMessage({ cmd: 'raise' });
    node.port.postMessage({ cmd: 'txmode', mode: 'data' });
    status('TRAINING');
    // Let the answer side's carrier detect settle before the first ENQ.
    setTimeout(() => {
      if (phase === 'train') startLink();
    }, 450);
  }

  function onWorkletMessage(msg) {
    if (!msg) return;
    if (msg.type === 'rx') {
      if (link) link.receiveWire(Uint8Array.from(msg.bytes));
    } else if (msg.type === 'carrier') {
      onAnswerCarrier();
    } else if (msg.type === 'carrierloss') {
      if (phase === 'connected' || phase === 'train') fail('NO CARRIER');
    }
  }

  t.start = async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return fail('NO MIC SUPPORT');
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (_) {
      return fail('MIC DENIED');
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return fail('NO AUDIO CONTEXT');
    ctx = new AC();
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      await ctx.audioWorklet.addModule('/fsk-worklet.js');
    } catch (_) {
      return fail('WORKLET LOAD FAILED');
    }
    node = new AudioWorkletNode(ctx, 'modem-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { profile: PROFILES.bell103, bitRate: 300 },
    });
    node.port.onmessage = (ev) => onWorkletMessage(ev.data);
    micSrc = ctx.createMediaStreamSource(micStream);
    micSrc.connect(node);
    node.connect(ctx.destination);

    phase = 'call';
    status('DIALING');
    node.port.postMessage({ cmd: 'txmode', mode: 'call' });
    tickTimer = setInterval(() => link && link.tick(), 60);
    noAnswerTimer = setTimeout(() => {
      if (phase === 'call') fail('NO ANSWER');
    }, 30000);
  };

  t.send = (data) => {
    if (phase === 'connected' && link) link.send(toBytes(data));
  };

  t.close = () => {
    if (node) node.port.postMessage({ cmd: 'drop' });
    if (phase !== 'dead') t.onClose && t.onClose();
    teardown();
  };

  function teardown() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (noAnswerTimer) {
      clearTimeout(noAnswerTimer);
      noAnswerTimer = null;
    }
    if (micStream) {
      for (const track of micStream.getTracks()) {
        try {
          track.stop();
        } catch (_) {
          /* ignore */
        }
      }
      micStream = null;
    }
    if (ctx) {
      try {
        ctx.close();
      } catch (_) {
        /* ignore */
      }
      ctx = null;
    }
    node = null;
    micSrc = null;
    link = null;
  }

  return t;
}

// ---- in-process loopback (DSP self-test) -----------------------------------
// Runs a full originate modem, a full answer modem, and a tiny echo BBS wired
// through a virtual air, exactly like scripts/audio-e2e.js but in the browser
// and on a real timer (accelerated so the handshake takes a second, not thirty).
// It exercises the same fsk.js + arq.js the worklet path uses, so a green
// loopback session proves the browser DSP end to end without a second machine.

export function createLoopbackTransport({ robust = false } = {}) {
  const t = makeTransport('loopback');
  const SR = 48000;
  const BLOCK = 2048;
  const BLOCKS_PER_TICK = 8; // ~20x real time
  const profile = PROFILES.bell103;

  // Virtual clock so the ARQ/handshake timers advance with air time.
  let vnow = 0;
  const timers = [];
  let seq = 0;
  const now = () => vnow;
  const setTimer = (fn, ms) => {
    const id = ++seq;
    timers.push({ id, at: vnow + ms, fn });
    return id;
  };
  const clearTimer = (id) => {
    const i = timers.findIndex((x) => x.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const fireDue = () => {
    const due = timers.filter((x) => x.at <= vnow);
    for (const x of due) {
      const i = timers.indexOf(x);
      if (i >= 0) timers.splice(i, 1);
    }
    for (const x of due) x.fn();
  };

  // Deterministic room noise.
  let rngState = 0x1234abcd;
  const rng = () => {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let x = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const LEAK = 0.5;
  const ATTEN = 0.7;
  const NOISE = 0.002;

  // Originate (client) side.
  const cMod = new FskModulator(profile.originate, { sampleRate: SR, bitRate: 300 });
  const cDemod = new FskDemodulator(profile.answer, { sampleRate: SR, bitRate: 300 });
  const callTone = new CallingToneGenerator({ sampleRate: SR });
  let cPhase = 'call'; // call | train | connected
  let cLink = null;
  const cRx = [];

  // Answer (server) side.
  const sMod = new FskModulator(profile.answer, { sampleRate: SR, bitRate: 300 });
  const sDemod = new FskDemodulator(profile.originate, { sampleRate: SR, bitRate: 300 });
  const callDet = new CallingToneDetector({ sampleRate: SR });
  let sState = 'idle'; // idle | answering | connected
  let sLink = null;
  const sRx = [];

  const GREETING =
    '\x1b[2J\x1b[H\x1b[1;32m*** NODEBBS ACOUSTIC LOOPBACK ***\x1b[0m\r\n' +
    'DSP self-test — mic/speaker not used.\r\n' +
    'Type below; the far side echoes it back in UPPERCASE.\r\n\r\n> ';

  // Client demod → bytes → client link.
  cDemod.onbyte = (b) => cRx.push(b);
  cDemod.oncarrier = () => {
    if (cPhase !== 'call') return;
    cPhase = 'train';
    t.onStatus && t.onStatus('CARRIER DETECT');
    cMod.raiseCarrier();
    t.onStatus && t.onStatus('TRAINING');
    setTimer(() => {
      if (cPhase !== 'train') return;
      cLink = new ReliableLink({
        role: 'originate',
        robust,
        now,
        sendWire: (frame) => cMod.pushBytes(frame),
        onData: (bytes) => t.onData && t.onData(Uint8Array.from(bytes)),
        onUp: ({ robust: r }) => cConnected(r ? 'CONNECT 300/REL-FEC' : 'CONNECT 300/REL'),
        onRaw: () => cConnected('CONNECT 300'),
      });
      cLink.start();
    }, 450);
  };
  cDemod.oncarrierloss = () => {
    if (cPhase === 'connected' || cPhase === 'train') {
      t.onClose && t.onClose();
      stop();
    }
  };

  function cConnected(banner) {
    if (cPhase === 'connected') return;
    cPhase = 'connected';
    t.onStatus && t.onStatus(banner);
    t.onOpen && t.onOpen();
  }

  // Server side: detect calling tone → answer → connect → echo BBS.
  callDet.ondetected = () => {
    if (sState !== 'idle') return;
    sState = 'answering';
    sMod.raiseCarrier();
    sDemod.carrierDetected = false;
    sDemod.reset();
  };
  sDemod.onbyte = (b) => sRx.push(b);
  sDemod.oncarrier = () => {
    if (sState !== 'answering') return;
    sState = 'connected';
    sLink = new ReliableLink({
      role: 'answer',
      robust,
      now,
      sendWire: (frame) => sMod.pushBytes(frame),
      onData: (bytes) => serverConsume(bytes),
      onUp: () => sLink.send(bytesOf(GREETING)),
      onRaw: () => sMod.pushBytes(bytesOf(GREETING)),
    });
  };

  function serverConsume(bytes) {
    // Echo each byte back uppercased; on Enter, send a canned reply.
    const up = [];
    let sawEnter = false;
    for (const b of bytes) {
      if (b === 0x0d || b === 0x0a) {
        sawEnter = true;
        up.push(0x0d, 0x0a, 0x3e, 0x20); // CRLF + "> "
      } else if (b >= 0x61 && b <= 0x7a) {
        up.push(b - 0x20);
      } else {
        up.push(b);
      }
    }
    if (sLink) {
      sLink.send(Uint8Array.from(up));
      if (sawEnter) sLink.send(bytesOf('\x1b[36mHELLO, CALLER!\x1b[0m\r\n> '));
    }
  }

  const bytesOf = (str) => new TextEncoder().encode(str);

  // Virtual air with one-block latency + self-leakage + noise.
  let cPrevTx = new Float32Array(BLOCK);
  let sPrevTx = new Float32Array(BLOCK);
  function mix(otherTx, selfTx) {
    const out = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      out[i] = (otherTx[i] || 0) * ATTEN + (selfTx[i] || 0) * LEAK + (rng() * 2 - 1) * NOISE;
    }
    return out;
  }

  function clientTx() {
    if (cPhase === 'call') return callTone.generate(BLOCK);
    return cMod.generate(BLOCK);
  }
  function serverTx() {
    return sMod.generate(BLOCK);
  }

  let runTimer = null;
  function oneBlock() {
    // Deliver last block's cross-coupled audio.
    const cMic = mix(sPrevTx, cPrevTx);
    const sMic = mix(cPrevTx, sPrevTx);

    if (sState === 'idle') callDet.process(sMic);
    sDemod.process(sMic);
    cDemod.process(cMic);

    if (cRx.length && cLink) {
      cLink.receiveWire(Uint8Array.from(cRx));
      cRx.length = 0;
    }
    if (sRx.length && sLink) {
      sLink.receiveWire(Uint8Array.from(sRx));
      sRx.length = 0;
    }

    cPrevTx = clientTx();
    sPrevTx = serverTx();

    vnow += (BLOCK / SR) * 1000;
    fireDue();
    if (cLink) cLink.tick();
    if (sLink) sLink.tick();
  }

  function stop() {
    if (runTimer) {
      clearInterval(runTimer);
      runTimer = null;
    }
  }

  t.start = () => {
    cPhase = 'call';
    t.onStatus && t.onStatus('DIALING');
    runTimer = setInterval(() => {
      for (let i = 0; i < BLOCKS_PER_TICK; i++) oneBlock();
    }, 16);
  };
  t.send = (data) => {
    if (cPhase === 'connected' && cLink) cLink.send(toBytes(data));
  };
  t.close = () => {
    if (cPhase !== 'connected') {
      // nothing live yet
    }
    stop();
    t.onClose && t.onClose();
  };

  return t;
}

export function createTransport(opts) {
  if (opts.line === 'phone') return createAudioTransport({ robust: opts.robust });
  if (opts.line === 'loopback') return createLoopbackTransport({ robust: opts.robust });
  return createWsTransport({ url: opts.url });
}
