'use strict';

const ansi = require('./lib/ansi');
const { decodeKeys } = require('./lib/keys');
const presence = require('./lib/presence');

let SEQ = 0;

// Thrown to unwind a screen when navigation happens or the caller disconnects.
class NavAbort extends Error {
  constructor() {
    super('navigation');
    this.nav = true;
  }
}

const NAV_ABORT = Symbol('nav-abort');

class Session {
  constructor(ws, ctx = {}) {
    this.id = ++SEQ;
    this.ws = ws;
    this.meta = ctx.meta || {};
    this.screens = ctx.screens || require('./screens');

    this.user = null;
    this.activity = 'connecting…';
    this.connected = true;
    this.connectedAt = Date.now();

    this.cols = 80;
    this.rows = 24;

    this.currentScreen = null;
    this._next = null;

    // Key input queue.
    this._keyBuf = [];
    this._waiter = null;

    // Set while an animation is playing so a keypress / navigation can cancel it.
    this._animation = null;

    // Set by the Chat screen to receive broadcast lines.
    this.onChat = null;
  }

  // ---- output -------------------------------------------------------------

  write(str) {
    if (!this.connected || !str) return;
    try {
      this.ws.send(String(str));
    } catch (_) {
      /* socket went away between checks */
    }
  }

  writeln(str = '') {
    this.write(str + '\r\n');
  }

  clear() {
    this.write(ansi.clear);
  }

  centerText(text) {
    return ansi.center(text, this.cols);
  }

  // ---- input --------------------------------------------------------------

  feedInput(data) {
    for (const key of decodeKeys(data)) this.feedKey(key);
  }

  feedKey(key) {
    // A keypress interrupts any running animation.
    if (this._animation) this._animation.cancel();
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w.resolve(key);
    } else {
      this._keyBuf.push(key);
    }
  }

  _nextKeyRaw() {
    if (this._keyBuf.length) return Promise.resolve(this._keyBuf.shift());
    return new Promise((resolve) => {
      this._waiter = { resolve };
    });
  }

  // Wake a pending readKey() without discarding buffered keys, so type-ahead
  // typed during a screen transition carries over to the next screen.
  _wake(value) {
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w.resolve(value);
    }
  }

  // Drop any buffered/awaited input (used when the connection is ending).
  _clearInput() {
    this._keyBuf = [];
    this._wake(NAV_ABORT);
  }

  async readKey() {
    if (!this.connected || this._next) throw new NavAbort();
    const key = await this._nextKeyRaw();
    if (key === NAV_ABORT || !this.connected || this._next) throw new NavAbort();
    return key;
  }

  // Classic remote-echo line editor. Resolves with the typed string on Enter.
  async readLine(opts = {}) {
    const { mask = false, max = 60, initial = '', label = '' } = opts;
    if (label) this.write(label);
    let buf = initial;
    if (initial) this.write(mask ? '*'.repeat(initial.length) : initial);

    for (;;) {
      const key = await this.readKey();
      if (key.name === 'enter') {
        this.write('\r\n');
        return buf;
      }
      if (key.name === 'backspace') {
        if (buf.length) {
          buf = buf.slice(0, -1);
          this.write('\b \b');
        }
        continue;
      }
      if (key.name === 'ctrl-c') {
        // Abandon the whole call, like hanging up mid-form.
        this.disconnect();
        throw new NavAbort();
      }
      if (key.ch && key.ch >= ' ' && buf.length < max) {
        buf += key.ch;
        this.write(mask ? '*' : key.ch);
      }
    }
  }

  // ---- navigation ---------------------------------------------------------

  goto(name, data = {}) {
    if (!this.screens[name]) {
      this.writeln(ansi.color(`\r\n?? Unknown screen: ${name}`, 'red'));
      name = this.meta.startScreen || 'Welcome';
    }
    this._next = { name, data };
    if (this._animation) this._animation.cancel();
    this._wake(NAV_ABORT);
  }

  disconnect(goodbye) {
    if (goodbye) this.write(goodbye);
    this.connected = false;
    this._clearInput();
    try {
      this.ws.close();
    } catch (_) {
      /* already closed */
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  handleControl(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello' || msg.t === 'size') {
      if (Number.isFinite(msg.cols) && msg.cols > 0) this.cols = Math.min(msg.cols, 200);
      if (Number.isFinite(msg.rows) && msg.rows > 0) this.rows = Math.min(msg.rows, 100);
    }
  }

  handleClose() {
    this.connected = false;
    this._clearInput();
  }

  async playArt(art) {
    // `art` may be a string (write once) or a function(session) that renders.
    if (typeof art === 'function') {
      await art(this);
    } else if (art) {
      this.write(String(art));
    }
  }

  start() {
    this._next = { name: this.meta.startScreen || 'Welcome', data: {} };
    this.write(ansi.clear + ansi.showCursor);
    this.run().catch((err) => {
      if (!(err instanceof NavAbort)) {
        // eslint-disable-next-line no-console
        console.error('[session]', err);
      }
    });
  }

  async run() {
    while (this.connected && this._next) {
      const { name, data } = this._next;
      this._next = null;
      this.currentScreen = name;
      const screen = this.screens[name];
      try {
        await screen.run(this, data);
        // If a screen returns without navigating (shouldn't happen normally),
        // fall back to the start screen instead of idling.
        if (this.connected && !this._next) {
          this._next = { name: this.meta.startScreen || 'Welcome', data: {} };
        }
      } catch (err) {
        if (err instanceof NavAbort) {
          // Expected: navigation or disconnect requested; continue the loop.
        } else {
          // eslint-disable-next-line no-console
          console.error(`[screen:${name}]`, err);
          this.write(ansi.color('\r\n\r\n*** SYSTEM ERROR ***\r\n', 'red'));
          if (name !== 'Welcome') {
            this._next = { name: this.meta.startScreen || 'Welcome', data: {} };
          } else {
            this.disconnect();
          }
        }
      }
    }
  }
}

module.exports = { Session, NavAbort };
