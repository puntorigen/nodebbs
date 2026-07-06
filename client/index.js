#!/usr/bin/env node
'use strict';

const path = require('path');
const WebSocket = require('ws');
const { BaudThrottle } = require('./lib/throttle');

// ---- args ----------------------------------------------------------------

function parseArgs(argv) {
  const args = { url: 'ws://localhost:3000', baud: 2400, noSound: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--no-sound') args.noSound = true;
    else if (a === '--baud') args.baud = parseInt(argv[++i], 10) || 0;
    else if (a.startsWith('--baud=')) args.baud = parseInt(a.split('=')[1], 10) || 0;
    else if (!a.startsWith('-')) args.url = a;
  }
  // Accept host:port or bare host without a scheme.
  if (!/^wss?:\/\//.test(args.url)) args.url = 'ws://' + args.url;
  if (!/:\d+/.test(args.url.replace(/^wss?:\/\//, ''))) args.url += ':3000';
  return args;
}

function help() {
  process.stdout.write(
    [
      'NodeBBS terminal client — dial into an ANSI BBS from your terminal.',
      '',
      'Usage: node index.js [ws://host:port] [options]',
      '',
      'Options:',
      '  --baud <n>    Simulated modem speed (default 2400). 0 = full speed.',
      '  --no-sound    Skip the dial-up sound and handshake delay.',
      '  -h, --help    Show this help.',
      '',
      'While connected: press Ctrl+] (or Ctrl+C) to hang up.',
      '',
    ].join('\n') + '\n'
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  help();
  process.exit(0);
}

// ---- dialer --------------------------------------------------------------

const SOUND = path.join(__dirname, 'assets', 'dial-up.mp3');
const MIN_DIAL_MS = args.noSound ? 0 : 3500;

const hostLabel = args.url.replace(/^wss?:\/\//, '');
const dialStart = Date.now();

let audio = null;
let dotTimer = null;
let opened = false;
let liveConnected = false;
let hangingUp = false;
const pending = [];

const throttle = new BaudThrottle({ baud: args.baud, sink: (b) => process.stdout.write(b) });

function startDialAudio() {
  if (args.noSound) return;
  try {
    const player = require('play-sound')({});
    audio = player.play(SOUND, () => {});
  } catch (_) {
    // No audio backend available — carry on silently.
  }
}

function stopAudio() {
  if (audio) {
    try {
      audio.kill();
    } catch (_) {
      /* already gone */
    }
    audio = null;
  }
}

function printDialIntro() {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write('NodeBBS Terminal Client\r\n');
  process.stdout.write('(press Ctrl+] to hang up)\r\n\r\n');
  process.stdout.write(`ATDT ${hostLabel}\r\n`);
  process.stdout.write('DIALING');
  dotTimer = setInterval(() => process.stdout.write('.'), 350);
}

// ---- connection ----------------------------------------------------------

printDialIntro();
startDialAudio();

const ws = new WebSocket(args.url);

ws.on('open', () => {
  opened = true;
  maybeGoLive();
});

ws.on('message', (data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (liveConnected) throttle.push(buf);
  else pending.push(buf);
});

ws.on('close', () => hangup('NO CARRIER'));

ws.on('error', (err) => {
  if (!opened) {
    if (dotTimer) clearInterval(dotTimer);
    stopAudio();
    process.stdout.write(`\r\n\r\nNO ANSWER — ${err.code || err.message}\r\n`);
    process.exit(1);
  } else {
    hangup('NO CARRIER');
  }
});

function maybeGoLive() {
  const wait = Math.max(0, MIN_DIAL_MS - (Date.now() - dialStart));
  setTimeout(goLive, wait);
}

function goLive() {
  if (liveConnected || hangingUp) return;
  liveConnected = true;
  if (dotTimer) clearInterval(dotTimer);
  stopAudio();

  const speed = args.baud > 0 ? String(args.baud) : 'FAST';
  process.stdout.write(`\r\nCONNECT ${speed}\r\n`);

  bindTerminal();
  sendSize('hello');

  // Flush anything the server sent while we were still "dialing".
  for (const buf of pending) throttle.push(buf);
  pending.length = 0;
}

function bindTerminal() {
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (buf) => {
    // Local hang-up: Ctrl+] (0x1d) or Ctrl+C (0x03).
    if (buf.length === 1 && (buf[0] === 0x1d || buf[0] === 0x03)) {
      hangup('NO CARRIER (you hung up)');
      return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true });
  });
  process.stdout.on('resize', () => sendSize('size'));
}

function sendSize(t) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ t, cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }));
}

function restoreTerminal() {
  process.stdout.write('\x1b[r\x1b[?25h'); // reset scroll region, show cursor
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch (_) {
      /* not a tty */
    }
  }
}

function hangup(msg) {
  if (hangingUp) return;
  hangingUp = true;
  if (dotTimer) clearInterval(dotTimer);
  throttle.flush();
  stopAudio();
  try {
    ws.close();
  } catch (_) {
    /* already closing */
  }
  restoreTerminal();
  process.stdout.write(`\r\n\r\n${msg}\r\n`);
  setTimeout(() => process.exit(0), 60);
}

process.on('SIGTERM', () => hangup('NO CARRIER'));
