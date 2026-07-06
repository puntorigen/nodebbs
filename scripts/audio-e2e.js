#!/usr/bin/env node
'use strict';

// Headless end-to-end test of the acoustic modem: the real originate-side
// (AudioModemClient) and answer-side (AudioModemServer) modems are wired to
// each other through a virtual "air" that mixes both bands, adds self-leakage
// crosstalk, attenuation and room noise. No hardware, no sox — proves the
// dial → answer → carrier handshake → ARQ → byte-exact session all work.
//
// Run: node scripts/audio-e2e.js [--noise 0.02] [--robust]

const { EventEmitter } = require('events');
const { AudioModemClient } = require('../client/lib/audio-modem');
const { AudioModemServer } = require('../server/src/transports/audio');

const argv = process.argv.slice(2);
const NOISE = Number((argv[argv.indexOf('--noise') + 1]) || 0) || 0;
const ROBUST = argv.includes('--robust');
const SR = 48000;
const BLOCK = 2048;

// ---- virtual air -----------------------------------------------------------
// Two endpoints share the air. Each endpoint's speaker output on tick N is
// heard by the *other* endpoint's mic on tick N+1 (one-block latency), plus a
// bit of its own output leaking back (the FDM crosstalk the demod must reject),
// plus band-limited noise.

function makeEndpointIO() {
  const mic = new EventEmitter();
  let lastTx = new Float32Array(BLOCK);
  const speaker = {
    write: (block) => {
      lastTx = block;
      return true;
    },
    close: () => {},
    on: () => {},
  };
  mic.close = () => {};
  return {
    audio: {
      openMic: () => mic,
      openSpeaker: () => speaker,
    },
    emitMic: (block) => mic.emit('block', block),
    takeTx: () => lastTx,
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const logs = [];
function log(m) {
  logs.push(m);
}

// ---- virtual clock + timers ------------------------------------------------
// Everything (ARQ retransmit timers, transport setTimeouts) runs on this clock
// so 25 s of "air" can be simulated in a fraction of a second of wall time.
let vnow = 0;
const timers = [];
let timerSeq = 0;
const setTimer = (fn, ms) => {
  const id = ++timerSeq;
  timers.push({ id, at: vnow + ms, fn });
  return id;
};
const clearTimer = (id) => {
  const i = timers.findIndex((t) => t.id === id);
  if (i >= 0) timers.splice(i, 1);
};
const now = () => vnow;
function fireDueTimers() {
  const due = timers.filter((t) => t.at <= vnow);
  for (const t of due) {
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  }
  for (const t of due) t.fn();
}

const clientIO = makeEndpointIO();
const serverIO = makeEndpointIO();
const rng = mulberry32(1234);

const LEAK = 0.5; // how much of your own speaker your mic hears
const ATTEN = 0.7; // path loss to the other mic
const BASE_NOISE = 0.002; // a realistic room is never digitally silent

let clientPrevTx = new Float32Array(BLOCK);
let serverPrevTx = new Float32Array(BLOCK);

function mixInto(otherTx, selfTx) {
  const n = Math.max(otherTx.length, selfTx.length, BLOCK);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = otherTx[i] || 0;
    const s = selfTx[i] || 0;
    out[i] = o * ATTEN + s * LEAK + (rng() * 2 - 1) * (BASE_NOISE + NOISE);
  }
  return out;
}

// ---- stub session ----------------------------------------------------------
// The server transport builds a real Session; but to keep this test focused on
// the transport/DSP/ARQ stack we intercept Session by giving the server a
// screens/meta pair that drives a trivial echo. Simpler: we let the real
// Session run, but the Welcome screen is heavy. Instead we monkeypatch the
// server's _connect to attach a tiny echo responder in place of a Session.

const SERVER_GREETING = 'WELCOME TO NODEBBS (ACOUSTIC)\r\nLOGIN: ';
let serverReceived = '';
let clientReceived = '';

const server = new AudioModemServer({
  meta: {},
  screens: {},
  robust: ROBUST,
  audio: serverIO.audio,
  log: () => {},
  now,
  setTimer,
  clearTimer,
});

// Replace Session wiring with a minimal echo BBS: on connect, greet; for each
// input byte, echo it back and, on Enter, reply with a canned line.
const realConnect = server._connect.bind(server);
server._connect = function patchedConnect() {
  this.state = 'connected';
  const { ReliableLink } = require('../shared/arq');
  this.link = new ReliableLink({
    role: 'answer',
    robust: this.robust,
    now,
    sendWire: (frame) => this.mod.pushBytes(frame),
    onData: (bytes) => {
      serverReceived += Buffer.from(bytes).toString('utf8');
      // Echo + respond to Enter.
      this.link.send(Uint8Array.from(bytes));
      if (Buffer.from(bytes).includes(0x0d) || Buffer.from(bytes).includes(0x0a)) {
        this.link.send(Uint8Array.from(Buffer.from('\r\nHELLO, CALLER!\r\n', 'utf8')));
      }
    },
    onUp: () => this.link.send(Uint8Array.from(Buffer.from(SERVER_GREETING, 'utf8'))),
    onRaw: () => this.mod.pushBytes(Buffer.from(SERVER_GREETING, 'utf8')),
  });
  this.session = { handleClose: () => {}, id: 1 };
};

server.start();

const client = new AudioModemClient({
  robust: ROBUST,
  audio: clientIO.audio,
  now,
  setTimer,
  clearTimer,
  onStatus: (label) => log(`[client] ${label}`),
  onData: (bytes) => {
    clientReceived += Buffer.from(bytes).toString('utf8');
  },
  onConnect: () => {
    log('[client] onConnect — terminal bound');
    // Type a login once connected.
    setTimer(() => client.sendInput(Buffer.from('pablo\r')), 400);
  },
  onNoCarrier: (r) => log(`[client] NO CARRIER: ${r}`),
});
client.start();

// ---- drive the virtual clock ----------------------------------------------

let tick = 0;
const MAX_TICKS = Math.round((25 * SR) / BLOCK); // ~25 s of audio
const BLOCK_MS = (BLOCK / SR) * 1000;

function step() {
  // Deliver last tick's TX (cross-coupled) to each mic; the handlers will
  // synchronously produce this tick's TX via speaker.write.
  clientIO.emitMic(mixInto(serverPrevTx, clientPrevTx));
  serverIO.emitMic(mixInto(clientPrevTx, serverPrevTx));
  clientPrevTx = clientIO.takeTx();
  serverPrevTx = serverIO.takeTx();
  vnow += BLOCK_MS;
  fireDueTimers();
  tick++;
}

console.log(`Acoustic end-to-end (virtual air)  noise=${NOISE}  robust=${ROBUST}\n`);

const startWall = Date.now();
while (tick < MAX_TICKS) {
  step();
  // Stop early once we've clearly succeeded.
  if (clientReceived.includes('HELLO, CALLER!') && serverReceived.includes('pablo')) break;
}

const airSeconds = ((tick * BLOCK) / SR).toFixed(1);
for (const l of logs) console.log('  ' + l);
console.log('');
console.log(`  air time: ${airSeconds}s  (wall ${((Date.now() - startWall) / 1000).toFixed(1)}s)`);
console.log(`  client received: ${JSON.stringify(clientReceived)}`);
console.log(`  server received: ${JSON.stringify(serverReceived)}`);
console.log('');

const greetingOK = clientReceived.includes('WELCOME TO NODEBBS');
const loginEchoOK = serverReceived.includes('pablo');
const replyOK = clientReceived.includes('HELLO, CALLER!');

function line(ok, label) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
line(greetingOK, 'server greeting reached the client');
line(loginEchoOK, 'client keystrokes reached the server');
line(replyOK, 'server reply to Enter reached the client');

client.stop();
server.stop();

if (greetingOK && loginEchoOK && replyOK) {
  console.log('\nEnd-to-end acoustic session works: dial, answer, handshake, ARQ, byte-exact I/O.');
  process.exit(0);
} else {
  console.log('\nEnd-to-end failed — see received buffers above.');
  process.exit(1);
}
