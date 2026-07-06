'use strict';

// Decode a raw byte chunk from the client into a list of key tokens. A single
// chunk may contain several keys (e.g. a pasted line) or a multi-byte escape
// sequence (arrow keys). Each token is { name, ch } where for printable input
// name === ch, and for special keys ch is '' (except enter/space).

const CSI_MAP = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  '3~': 'delete',
  '5~': 'pageup',
  '6~': 'pagedown',
};

function decodeKeys(data) {
  const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const keys = [];
  let i = 0;

  while (i < s.length) {
    const c = s[i];

    if (c === '\x1b') {
      if (s[i + 1] === '[' || s[i + 1] === 'O') {
        // Read the rest of the CSI/SS3 sequence.
        let j = i + 2;
        let seq = '';
        while (j < s.length && /[0-9;]/.test(s[j])) {
          seq += s[j];
          j++;
        }
        const final = s[j] || '';
        const lookup = CSI_MAP[final] || CSI_MAP[seq + final];
        if (lookup) {
          keys.push({ name: lookup, ch: '' });
        } else {
          keys.push({ name: 'escape', ch: '' });
        }
        i = j + 1;
        continue;
      }
      keys.push({ name: 'escape', ch: '' });
      i++;
      continue;
    }

    if (c === '\r' || c === '\n') {
      keys.push({ name: 'enter', ch: '\n' });
      if (c === '\r' && s[i + 1] === '\n') i++; // swallow CRLF pair
      i++;
      continue;
    }

    if (c === '\x7f' || c === '\b') {
      keys.push({ name: 'backspace', ch: '' });
      i++;
      continue;
    }

    if (c === '\x03') {
      keys.push({ name: 'ctrl-c', ch: '' });
      i++;
      continue;
    }

    if (c === '\t') {
      keys.push({ name: 'tab', ch: '' });
      i++;
      continue;
    }

    if (c >= ' ') {
      keys.push({ name: c, ch: c });
      i++;
      continue;
    }

    // Any other control byte: ignore.
    i++;
  }

  return keys;
}

module.exports = { decodeKeys };
