'use strict';

// Tracks every live session so menus can show "N callers online" and the
// Who's Online screen can list handles + what each caller is currently doing.

const sessions = new Set();

const presence = {
  register(session) {
    sessions.add(session);
  },

  unregister(session) {
    sessions.delete(session);
  },

  count() {
    return sessions.size;
  },

  // Number of callers who have actually logged in.
  authedCount() {
    let n = 0;
    for (const s of sessions) if (s.user) n++;
    return n;
  },

  list() {
    return [...sessions].map((s) => ({
      handle: s.user ? s.user.handle : 'connecting…',
      activity: s.activity || 'idle',
      since: s.connectedAt,
      me: false,
      sessionId: s.id,
    }));
  },

  // Is `handle` already logged in on another session? (prevents double-login)
  isOnline(handle) {
    const h = String(handle).toLowerCase();
    for (const s of sessions) {
      if (s.user && s.user.handle.toLowerCase() === h) return true;
    }
    return false;
  },
};

module.exports = presence;
