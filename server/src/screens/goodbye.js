'use strict';

const { defineScreen } = require('../lib/screen');
const ansi = require('../lib/ansi');
const art = require('../art');

const c = ansi.color;

module.exports = defineScreen({
  activity: 'Logging off',
  async enter(session) {
    const width = session.cols;
    let out = ansi.clear + ansi.showCursor + '\r\n\r\n';
    out += art.centerBlock(art.renderWord('BYE'), width, 'brightMagenta') + '\r\n\r\n';
    if (session.user) {
      out += ansi.center(c(`Thanks for calling, ${session.user.handle}.`, 'brightWhite'), width) + '\r\n';
    }
    out += ansi.center(c('Hanging up the modem…', 'gray'), width) + '\r\n';
    session.write(out);

    await new Promise((r) => setTimeout(r, 700));
    session.disconnect();
  },
});
