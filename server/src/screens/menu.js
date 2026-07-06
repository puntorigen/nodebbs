'use strict';

const { defineScreen } = require('../lib/screen');
const ansi = require('../lib/ansi');
const presence = require('../lib/presence');
const menus = require('../menu.config');

const c = ansi.color;

function render(session, menu) {
  const width = Math.min(session.cols, 78);
  const name = session.meta.name || 'NodeBBS';
  const sysop = session.meta.sysop || 'sysop';
  const online = presence.count();

  const rule = c('═'.repeat(width), menu.color || 'brightCyan');
  const thin = c('─'.repeat(width), 'gray');

  let out = ansi.clear + ansi.showCursor;
  out += rule + '\r\n';
  out += c(' ' + name, 'brightWhite') + c('  ·  ', 'gray') + c(menu.title, menu.color || 'brightCyan') + '\r\n';
  out +=
    c(' Sysop: ', 'gray') +
    c(sysop, 'white') +
    c('   Callers online: ', 'gray') +
    c(String(online), 'brightGreen') +
    (session.user ? c('   You: ', 'gray') + c(session.user.handle, 'brightYellow') : '') +
    '\r\n';
  out += rule + '\r\n\r\n';

  for (const item of menu.items) {
    out +=
      '   ' +
      c('[', 'gray') +
      c(item.key.toUpperCase(), 'brightYellow') +
      c('] ', 'gray') +
      c(item.label, 'brightWhite') +
      '\r\n';
  }

  out += '\r\n' + thin + '\r\n';
  out += c(' Command ', 'gray') + c('> ', menu.color || 'brightCyan');
  session.write(out);
}

module.exports = defineScreen({
  async enter(session, data) {
    const id = data.id || 'main';
    session._menuId = menus[id] ? id : 'main';
    session.activity = (menus[session._menuId] || {}).title || 'Menu';
    render(session, menus[session._menuId]);
  },

  async key(session, key) {
    const menu = menus[session._menuId] || menus.main;

    // Escape / backspace goes up to the parent menu when there is one.
    if ((key.name === 'escape' || key.name === 'backspace') && menu.parent) {
      return session.goto('Menu', { id: menu.parent });
    }

    const ch = (key.ch || '').toLowerCase();
    if (!ch) return;

    const item = menu.items.find((it) => it.key.toLowerCase() === ch);
    if (!item) {
      // Echo the invalid key briefly, then repaint the prompt line.
      return;
    }

    // Echo the chosen hotkey so it feels responsive.
    session.write(c(item.key.toUpperCase(), 'brightYellow') + '\r\n');

    if (item.action === 'logoff') return session.goto('Goodbye');
    if (item.menu) return session.goto('Menu', { id: item.menu });
    if (item.screen) return session.goto(item.screen, { from: session._menuId });
  },
});
