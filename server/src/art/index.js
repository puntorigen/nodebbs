'use strict';

const ansi = require('../lib/ansi');

// A tiny 5-row block font. Enough glyphs to spell the banner + login art.
// Each glyph is 5 rows; render() joins glyphs with a single-column gap.
const FONT = {
  ' ': ['     ', '     ', '     ', '     ', '     '],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  B: ['████ ', '█   █', '████ ', '█   █', '████ '],
  S: ['█████', '█    ', '█████', '    █', '█████'],
  W: ['█   █', '█   █', '█ █ █', '██ ██', '█   █'],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
};

// Render a word into a 5-line string using the block font.
function renderWord(word) {
  const rows = ['', '', '', '', ''];
  const chars = word.toUpperCase().split('');
  chars.forEach((ch, idx) => {
    const glyph = FONT[ch] || FONT[' '];
    for (let r = 0; r < 5; r++) {
      rows[r] += glyph[r] + (idx < chars.length - 1 ? ' ' : '');
    }
  });
  return rows;
}

// Center every line of a multi-line block within `width` columns, colored.
function centerBlock(lines, width, color) {
  return lines
    .map((l) => ansi.center(color ? ansi.color(l, color) : l, width))
    .join('\r\n');
}

const CYCLE = ['brightCyan', 'brightMagenta', 'brightGreen', 'brightYellow', 'brightBlue'];

const art = {
  renderWord,
  centerBlock,

  // The main NODEBBS banner in a given color, centered for the terminal.
  banner(width = 80, color = 'brightCyan') {
    return centerBlock(renderWord('NODEBBS'), width, color);
  },

  // Animated welcome: color-cycles the banner, then invites a keypress.
  async welcome(session) {
    const width = session.cols;
    const lines = renderWord('NODEBBS');
    const name = session.meta.name || 'NodeBBS';
    const sub = session.meta.description || '';

    const frames = CYCLE.map((c) => {
      let f = '\r\n\r\n';
      f += centerBlock(lines, width, c) + '\r\n\r\n';
      f += ansi.center(ansi.color('· ' + name + ' ·', 'brightWhite'), width) + '\r\n';
      if (sub) f += ansi.center(ansi.color(sub, 'gray'), width) + '\r\n';
      return f;
    });

    const { playFrames } = require('../lib/ansimate');
    await playFrames(session, frames, { fps: 5, loops: 2, clearBetween: true });

    // Settle on a final frame + prompt.
    let final = ansi.clear + '\r\n\r\n';
    final += centerBlock(lines, width, 'brightCyan') + '\r\n\r\n';
    final += ansi.center(ansi.color('· ' + name + ' ·', 'brightWhite'), width) + '\r\n';
    if (sub) final += ansi.center(ansi.color(sub, 'gray'), width) + '\r\n';
    final += '\r\n\r\n';
    final += ansi.center(ansi.blink(ansi.color('-=[ PRESS ANY KEY TO CONNECT ]=-', 'brightGreen')), width);
    session.write(final);
  },

  // Graffiti-style login banner.
  loginBanner(width = 80) {
    const lines = renderWord('WELCOME');
    let out = '\r\n';
    out += centerBlock(lines, width, 'brightMagenta') + '\r\n\r\n';
    out += ansi.center(ansi.color('╓─────────────────────────────────╖', 'magenta'), width) + '\r\n';
    out += ansi.center(ansi.color('║   ', 'magenta') + ansi.color('E N T E R   T H E   S Y S T E M', 'brightWhite') + ansi.color('   ║', 'magenta'), width) + '\r\n';
    out += ansi.center(ansi.color('╙─────────────────────────────────╜', 'magenta'), width) + '\r\n';
    return out;
  },
};

module.exports = art;
