'use strict';

const ansi = require('./ansi');

// Simple cancellable sleep. Rejects with a tagged error if cancelled so callers
// can distinguish "animation finished" from "user pressed a key".
function sleep(ms, controller) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (controller) controller._onCancel = null;
      resolve();
    }, ms);
    if (controller) {
      controller._onCancel = () => {
        clearTimeout(timer);
        const err = new Error('cancelled');
        err.cancelled = true;
        reject(err);
      };
    }
  });
}

// A controller lets a screen (or a keypress) interrupt a running animation.
function createController() {
  const controller = {
    cancelled: false,
    _onCancel: null,
    cancel() {
      this.cancelled = true;
      if (this._onCancel) this._onCancel();
    },
  };
  return controller;
}

// Play a sequence of full-screen frames as an animation. Each frame is a string
// of ANSI/text. Resolves normally when done, or when cancelled (e.g. a keypress).
async function playFrames(session, frames, opts = {}) {
  const { fps = 8, loops = 1, clearBetween = true, home = true } = opts;
  const delay = Math.max(1, Math.round(1000 / fps));
  const controller = createController();
  session._animation = controller;
  try {
    for (let loop = 0; loop < loops; loop++) {
      for (const frame of frames) {
        if (controller.cancelled) return;
        let out = '';
        if (clearBetween) out += ansi.clear;
        else if (home) out += ansi.home;
        out += frame;
        session.write(out);
        await sleep(delay, controller);
      }
    }
  } catch (err) {
    if (!err.cancelled) throw err;
  } finally {
    if (session._animation === controller) session._animation = null;
  }
}

// Reveal a block of text one character at a time (server-side typewriter).
// Handy at full baud where the client throttle would otherwise print instantly.
async function typewriter(session, text, opts = {}) {
  const { cps = 200 } = opts;
  const delay = Math.max(1, Math.round(1000 / cps));
  const controller = createController();
  session._animation = controller;
  try {
    for (const ch of text) {
      if (controller.cancelled) {
        // Flush the remainder instantly if interrupted.
        session.write(text.slice(text.indexOf(ch)));
        return;
      }
      session.write(ch);
      await sleep(delay, controller);
    }
  } catch (err) {
    if (!err.cancelled) throw err;
  } finally {
    if (session._animation === controller) session._animation = null;
  }
}

module.exports = { playFrames, typewriter, sleep, createController };
