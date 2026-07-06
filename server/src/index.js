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

wss.on('listening', () => {
  console.log('');
  console.log(`  ${meta.name || 'NodeBBS'} v${pkg.version}`);
  console.log(`  Sysop: ${meta.sysop || 'unknown'}`);
  console.log(`  Registered users: ${users.count()}`);
  console.log('');
  console.log(`  ANSI BBS listening on ws://localhost:${PORT}`);
  console.log(`  Dial in with:  node client/index.js ws://localhost:${PORT}`);
  console.log('');
});

wss.on('error', (err) => {
  console.error('[server] error:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[server] shutting down…');
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
