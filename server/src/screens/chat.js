'use strict';

const { defineScreen } = require('../lib/screen');
const ansi = require('../lib/ansi');
const chat = require('../lib/chat');
const presence = require('../lib/presence');

const c = ansi.color;

function layout(session) {
  const rows = Math.max(session.rows || 24, 12);
  const cols = Math.min(session.cols || 80, 120);
  return {
    rows,
    cols,
    scrollTop: 3,
    scrollBottom: rows - 2,
    inputRow: rows,
  };
}

function wrap(str, width) {
  const words = String(str).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur.length) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
    while (cur.length > width) {
      lines.push(cur.slice(0, width));
      cur = cur.slice(width);
    }
  }
  if (cur.length) lines.push(cur);
  return lines.length ? lines : [''];
}

function colorFor(session, line) {
  if (line.type === 'system') return 'yellow';
  if (session.user && line.handle === session.user.handle) return 'brightGreen';
  return 'brightCyan';
}

function textFor(line) {
  const time = new Date(line.at).toTimeString().slice(0, 5);
  if (line.type === 'system') return `* ${line.text}`;
  return `[${time}] <${line.handle}> ${line.text}`;
}

// Print one logical chat line into the scroll region, wrapping as needed, then
// return the cursor to the input line.
function pushLine(session, line) {
  const g = layout(session);
  const color = colorFor(session, line);
  const wrapped = wrap(textFor(line), g.cols);
  let out = ansi.saveCursor;
  for (const w of wrapped) {
    out += ansi.moveTo(g.scrollBottom, 1) + '\r\n' + c(w, color);
  }
  out += ansi.restoreCursor;
  session.write(out);
}

function drawInput(session) {
  const g = layout(session);
  session.write(ansi.moveTo(g.inputRow, 1) + ansi.clearLine + c('> ', 'brightGreen') + (session._chatBuf || ''));
}

function drawFrame(session) {
  const g = layout(session);
  const name = session.meta.name || 'NodeBBS';
  let out = ansi.clear + ansi.showCursor;

  // Header
  out += ansi.moveTo(1, 1) + c(' ' + name + ' · CHAT', 'brightWhite') + c(`   (${chat.count()} in room, ${presence.count()} online)`, 'gray');
  out += ansi.moveTo(2, 1) + c('─'.repeat(g.cols), 'brightBlue');

  // Footer separator + hint
  out += ansi.moveTo(g.scrollBottom + 1, 1) + c('─'.repeat(g.cols), 'brightBlue');

  // Scroll region for the message area only.
  out += `\x1b[${g.scrollTop};${g.scrollBottom}r`;
  out += ansi.moveTo(g.scrollTop, 1);
  session.write(out);
}

module.exports = defineScreen({
  activity: 'Chatting',
  async enter(session, data) {
    session._backMenu = data.from || 'main';
    session._chatBuf = '';
    drawFrame(session);

    // Replay recent history so the room isn't empty on arrival.
    for (const line of chat.recentHistory(15)) pushLine(session, line);

    // Greeting / help.
    pushLine(session, { type: 'system', text: 'Type a message and press ENTER. Commands: /who /help /quit', at: Date.now() });

    session.onChat = (line) => {
      pushLine(session, line);
      // Refresh header caller count and keep cursor on the input line.
      const g = layout(session);
      session.write(
        ansi.saveCursor +
          ansi.moveTo(1, 1) +
          ansi.clearLine +
          c(' ' + (session.meta.name || 'NodeBBS') + ' · CHAT', 'brightWhite') +
          c(`   (${chat.count()} in room, ${presence.count()} online)`, 'gray') +
          ansi.restoreCursor
      );
    };

    chat.join(session);
    drawInput(session);
  },

  async key(session, key) {
    const g = layout(session);

    if (key.name === 'enter') {
      const text = (session._chatBuf || '').trim();
      session._chatBuf = '';
      drawInput(session);
      if (!text) return;

      if (text[0] === '/') {
        const cmd = text.slice(1).toLowerCase().split(/\s+/)[0];
        if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') {
          return session.goto('Menu', { id: session._backMenu || 'main' });
        }
        if (cmd === 'who') {
          const names = [...chat.subscribers].map((s) => s.user.handle).join(', ');
          pushLine(session, { type: 'system', text: `In the room: ${names}`, at: Date.now() });
          return;
        }
        if (cmd === 'help') {
          pushLine(session, { type: 'system', text: 'Commands: /who (list room)  /quit (leave)  /help', at: Date.now() });
          return;
        }
        pushLine(session, { type: 'system', text: `Unknown command: /${cmd}`, at: Date.now() });
        return;
      }

      chat.say(session, text);
      return;
    }

    if (key.name === 'backspace') {
      if (session._chatBuf.length) {
        session._chatBuf = session._chatBuf.slice(0, -1);
        session.write('\b \b');
      }
      return;
    }

    if (key.name === 'escape') {
      return session.goto('Menu', { id: session._backMenu || 'main' });
    }

    const max = g.cols - 3;
    if (key.ch && key.ch >= ' ' && session._chatBuf.length < max) {
      session._chatBuf += key.ch;
      session.write(key.ch);
    }
  },

  async leave(session) {
    chat.leave(session);
    // Reset the scroll region and restore a normal full-screen terminal.
    session.write('\x1b[r' + ansi.showCursor + ansi.clear);
  },
});
