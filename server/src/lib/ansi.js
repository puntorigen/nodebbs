'use strict';

// Low-level ANSI / VT100 helpers. Everything the server sends to a client is
// just bytes; these helpers make it pleasant to build classic BBS screens.

const ESC = '\x1b';
const CSI = ESC + '[';

// SGR (Select Graphic Rendition) foreground / background color codes.
const FG = {
  black: 30, red: 31, green: 32, yellow: 33,
  blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, brightRed: 91, brightGreen: 92, brightYellow: 93,
  brightBlue: 94, brightMagenta: 95, brightCyan: 96, brightWhite: 97,
};
const BG = {
  black: 40, red: 41, green: 42, yellow: 43,
  blue: 44, magenta: 45, cyan: 46, white: 47,
};

const sgr = (...codes) => `${CSI}${codes.join(';')}m`;

const ansi = {
  ESC,
  CSI,

  // Screen / cursor control
  reset: sgr(0),
  clear: `${CSI}2J${CSI}H`,
  clearLine: `${CSI}2K`,
  home: `${CSI}H`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  saveCursor: `${ESC}7`,
  restoreCursor: `${ESC}8`,

  moveTo: (row, col) => `${CSI}${row};${col}H`,
  up: (n = 1) => `${CSI}${n}A`,
  down: (n = 1) => `${CSI}${n}B`,
  right: (n = 1) => `${CSI}${n}C`,
  left: (n = 1) => `${CSI}${n}D`,

  // Attributes
  bold: (s) => `${sgr(1)}${s}${sgr(22)}`,
  dim: (s) => `${sgr(2)}${s}${sgr(22)}`,
  underline: (s) => `${sgr(4)}${s}${sgr(24)}`,
  blink: (s) => `${sgr(5)}${s}${sgr(25)}`,
  inverse: (s) => `${sgr(7)}${s}${sgr(27)}`,

  sgr,
  FG,
  BG,

  // color('hello', 'brightCyan') or color('hi', 'white', 'blue')
  color(text, fg, bg) {
    const codes = [];
    if (fg && FG[fg] != null) codes.push(FG[fg]);
    if (bg && BG[bg] != null) codes.push(BG[bg]);
    if (!codes.length) return text;
    return `${sgr(...codes)}${text}${sgr(0)}`;
  },
};

// Strip ANSI escape sequences so we can measure printable width.
const STRIP_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
ansi.strip = (s) => String(s).replace(STRIP_RE, '');
ansi.visibleLength = (s) => ansi.strip(s).length;

// Center a single line of (possibly colored) text within `width` columns.
ansi.center = (text, width = 80) => {
  const len = ansi.visibleLength(text);
  if (len >= width) return text;
  const pad = Math.floor((width - len) / 2);
  return ' '.repeat(pad) + text;
};

// Draw a single-line box around a block of lines using CP437-ish box chars.
ansi.box = (lines, { color: fg = 'cyan', width } = {}) => {
  const arr = Array.isArray(lines) ? lines : String(lines).split('\n');
  const inner = width || Math.max(...arr.map((l) => ansi.visibleLength(l)));
  const top = ansi.color('┌' + '─'.repeat(inner + 2) + '┐', fg);
  const bottom = ansi.color('└' + '─'.repeat(inner + 2) + '┘', fg);
  const bar = ansi.color('│', fg);
  const body = arr.map((l) => {
    const gap = inner - ansi.visibleLength(l);
    return `${bar} ${l}${' '.repeat(Math.max(0, gap))} ${bar}`;
  });
  return [top, ...body, bottom].join('\r\n');
};

module.exports = ansi;
