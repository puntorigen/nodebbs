'use strict';

const { defineScreen } = require('../lib/screen');
const ansi = require('../lib/ansi');
const presence = require('../lib/presence');

const c = ansi.color;

function pad(str, len) {
  str = String(str);
  if (str.length >= len) return str.slice(0, len);
  return str + ' '.repeat(len - str.length);
}

function elapsed(since) {
  const secs = Math.floor((Date.now() - since) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

module.exports = defineScreen({
  activity: "Who's Online",
  async enter(session, data) {
    session._backMenu = data.from || 'main';
    const width = Math.min(session.cols, 78);
    const rule = c('═'.repeat(width), 'brightCyan');

    let out = ansi.clear + ansi.hideCursor;
    out += rule + '\r\n';
    out += c("  WHO'S ONLINE", 'brightWhite') + c(`   (${presence.count()} connected)`, 'gray') + '\r\n';
    out += rule + '\r\n\r\n';
    out +=
      c('  ' + pad('HANDLE', 20) + pad('DOING', 24) + 'ONLINE', 'brightYellow') + '\r\n';
    out += c('  ' + '─'.repeat(width - 2), 'gray') + '\r\n';

    for (const u of presence.list()) {
      const mine = u.sessionId === session.id;
      const handle = pad(u.handle + (mine ? ' (you)' : ''), 20);
      const line = '  ' + pad(handle, 20) + pad(u.activity, 24) + elapsed(u.since);
      out += (mine ? c(line, 'brightGreen') : c(line, 'white')) + '\r\n';
    }

    out += '\r\n' + c('  ─ Press any key to return ─', 'gray');
    session.write(out);
  },

  async key(session) {
    session.write(ansi.showCursor);
    session.goto('Menu', { id: session._backMenu || 'main' });
  },
});
