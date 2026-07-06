'use strict';

// A single global chat room. Sessions subscribe while inside the Chat screen;
// messages (and join/leave notices) are broadcast to every subscriber.

const subscribers = new Set();
const history = [];
const HISTORY_MAX = 50;

const chat = {
  subscribers,

  join(session) {
    subscribers.add(session);
    chat.system(`${session.user.handle} has joined the chat.`);
  },

  leave(session) {
    if (!subscribers.has(session)) return;
    subscribers.delete(session);
    chat.system(`${session.user.handle} has left the chat.`);
  },

  // A message from a specific user.
  say(session, text) {
    const line = { type: 'msg', handle: session.user.handle, text, at: Date.now() };
    chat._push(line);
  },

  // A system notice (joins, leaves, etc).
  system(text) {
    chat._push({ type: 'system', text, at: Date.now() });
  },

  recentHistory(n = 20) {
    return history.slice(-n);
  },

  count() {
    return subscribers.size;
  },

  _push(line) {
    history.push(line);
    if (history.length > HISTORY_MAX) history.shift();
    for (const s of subscribers) {
      try {
        if (typeof s.onChat === 'function') s.onChat(line);
      } catch (_) {
        /* a broken subscriber shouldn't take down the room */
      }
    }
  },
};

module.exports = chat;
