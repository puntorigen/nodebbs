#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const { Session } = require('./session');
const screens = require('./screens');
const presence = require('./lib/presence');
const users = require('./lib/users');

const meta = require('../nodebbs.json');
const pkg = require('../package.json');

const PORT = Number(process.env.PORT) || meta.port || 3000;

// Optional acoustic line (in addition to WebSocket, never instead of it).
const argv = process.argv.slice(2);
const AUDIO = argv.includes('--audio') || process.env.AUDIO === '1';
const AUDIO_ROBUST = argv.includes('--robust') || process.env.AUDIO_ROBUST === '1';

const wss = new WebSocket.Server({ port: PORT });

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').toString();
  const session = new Session(ws, { meta, screens });
  presence.register(session);
  console.log(`[+] carrier detected from ${ip} — session #${session.id} (${presence.count()} online)`);

  ws.on('message', (data, isBinary) => {
    // Text frames are control JSON (hello / resize); binary frames are keystrokes.
    if (!isBinary) {
      const str = data.toString();
      try {
        const msg = JSON.parse(str);
        session.handleControl(msg);
        return;
      } catch (_) {
        // Not JSON — fall through and treat as raw input.
      }
    }
    session.feedInput(data);
  });

  ws.on('close', () => {
    session.handleClose();
    presence.unregister(session);
    const who = session.user ? session.user.handle : 'guest';
    console.log(`[-] NO CARRIER: session #${session.id} (${who}) hung up (${presence.count()} online)`);
  });

  ws.on('error', () => {
    session.handleClose();
  });

  session.start();
});

let audioServer = null;

wss.on('listening', () => {
  console.log('');
  console.log(`  ${meta.name || 'NodeBBS'} v${pkg.version}`);
  console.log(`  Sysop: ${meta.sysop || 'unknown'}`);
  console.log(`  Registered users: ${users.count()}`);
  console.log('');
  console.log(`  ANSI BBS listening on ws://localhost:${PORT}`);
  console.log(`  Dial in with:  node client/index.js ws://localhost:${PORT}`);
  console.log('');

  if (AUDIO) {
    try {
      const { AudioModemServer } = require('./transports/audio');
      audioServer = new AudioModemServer({ meta, screens, robust: AUDIO_ROBUST });
      audioServer.start();
      console.log(`  Acoustic line ENABLED${AUDIO_ROBUST ? ' (robust FEC)' : ''} — callers can dial in over sound.`);
      console.log('  Dial in with:  node client/index.js --audio');
      console.log('');
    } catch (err) {
      console.error('[server] could not start acoustic line:', err.message);
    }
  }
});

wss.on('error', (err) => {
  console.error('[server] error:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[server] shutting down…');
  if (audioServer) {
    try {
      audioServer.stop();
    } catch (_) {
      /* ignore */
    }
  }
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
