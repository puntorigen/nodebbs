'use strict';

// Adapts the friendly { art, enter, key, leave, activity } screen definition
// into a runnable object with a single async run(session, data). Input is read
// through session.readKey(), which throws NavAbort the moment the screen
// navigates away or the caller disconnects, so screens never leak key loops.

function defineScreen(def) {
  const { art, enter, key, leave, activity } = def;
  return {
    def,
    async run(session, data) {
      if (activity) session.activity = activity;
      try {
        if (art) await session.playArt(art);
        if (enter) await enter(session, data || {});
        // Dispatch keys until the screen navigates (readKey throws NavAbort).
        for (;;) {
          const k = await session.readKey();
          if (key) await key(session, k);
        }
      } finally {
        session.onChat = null;
        if (leave) {
          try {
            await leave(session);
          } catch (_) {
            /* ignore cleanup errors */
          }
        }
      }
    },
  };
}

module.exports = { defineScreen };
