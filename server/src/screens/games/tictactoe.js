'use strict';

const { defineScreen } = require('../../lib/screen');
const ansi = require('../../lib/ansi');

const c = ansi.color;

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const empties = (b) => b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

function winner(b) {
  for (const [a, d, e] of LINES) {
    if (b[a] && b[a] === b[d] && b[a] === b[e]) return b[a];
  }
  return null;
}

// Classic unbeatable-ish heuristic: win, block, center, corner, random.
function cpuMove(b) {
  for (const i of empties(b)) {
    b[i] = 'O';
    if (winner(b) === 'O') { b[i] = null; return i; }
    b[i] = null;
  }
  for (const i of empties(b)) {
    b[i] = 'X';
    if (winner(b) === 'X') { b[i] = null; return i; }
    b[i] = null;
  }
  if (!b[4]) return 4;
  const corners = [0, 2, 6, 8].filter((i) => !b[i]);
  if (corners.length) return rand(corners);
  return rand(empties(b));
}

function render(session) {
  const st = session._ttt;
  let out = ansi.clear + ansi.hideCursor + '\r\n';
  out += c('  TIC-TAC-TOE', 'brightWhite') + c('     you = X    cpu = O', 'gray') + '\r\n\r\n';

  for (let r = 0; r < 3; r++) {
    let row = '      ';
    for (let col = 0; col < 3; col++) {
      const i = r * 3 + col;
      const v = st.board[i];
      let cell;
      if (v === 'X') cell = c(' X ', 'brightYellow');
      else if (v === 'O') cell = c(' O ', 'brightRed');
      else cell = c(' ' + (i + 1) + ' ', 'gray');
      if (i === st.cursor && !st.over) cell = ansi.inverse(v ? cell : c(' ' + (i + 1) + ' ', 'brightWhite'));
      row += cell;
      if (col < 2) row += c('│', 'blue');
    }
    out += row + '\r\n';
    if (r < 2) out += '      ' + c('───┼───┼───', 'blue') + '\r\n';
  }

  out += '\r\n  ' + (st.message || '') + '\r\n\r\n';
  out += st.over
    ? c('  Press any key to return to the Game Room…', 'gray')
    : c('  Move: arrow keys + ENTER, or press 1-9.   Q to quit.', 'gray');
  session.write(out);
}

function place(session, i) {
  const st = session._ttt;
  if (st.over || st.board[i]) return;

  st.board[i] = 'X';
  if (winner(st.board) === 'X') {
    st.over = true;
    st.message = c('YOU WIN! Nicely played.', 'brightGreen');
    return;
  }
  if (empties(st.board).length === 0) {
    st.over = true;
    st.message = c("It's a draw.", 'yellow');
    return;
  }

  const j = cpuMove(st.board);
  st.board[j] = 'O';
  st.cursor = st.board[st.cursor] ? (empties(st.board)[0] ?? st.cursor) : st.cursor;
  if (winner(st.board) === 'O') {
    st.over = true;
    st.message = c('The CPU wins this round. Try again!', 'brightRed');
    return;
  }
  if (empties(st.board).length === 0) {
    st.over = true;
    st.message = c("It's a draw.", 'yellow');
  }
}

module.exports = defineScreen({
  activity: 'Playing Tic-Tac-Toe',
  async enter(session, data) {
    session._tttBack = data.from === 'games' ? 'games' : 'games';
    session._ttt = { board: Array(9).fill(null), cursor: 4, over: false, message: 'Your move.' };
    render(session);
  },

  async key(session, key) {
    const st = session._ttt;
    const back = { id: session._tttBack || 'games' };

    if (key.name === 'escape' || (key.ch && key.ch.toLowerCase() === 'q')) {
      session.write(ansi.showCursor);
      return session.goto('Menu', back);
    }

    if (st.over) {
      session.write(ansi.showCursor);
      return session.goto('Menu', back);
    }

    if (key.name === 'up' && st.cursor >= 3) st.cursor -= 3;
    else if (key.name === 'down' && st.cursor < 6) st.cursor += 3;
    else if (key.name === 'left' && st.cursor % 3 > 0) st.cursor -= 1;
    else if (key.name === 'right' && st.cursor % 3 < 2) st.cursor += 1;
    else if (key.name === 'enter' || key.ch === ' ') place(session, st.cursor);
    else if (key.ch && key.ch >= '1' && key.ch <= '9') place(session, Number(key.ch) - 1);
    else return;

    render(session);
  },
});
