'use strict';

const { defineScreen } = require('../../lib/screen');
const ansi = require('../../lib/ansi');

const c = ansi.color;

module.exports = defineScreen({
  activity: 'Playing Hi-Lo',
  async enter(session, data) {
    const back = { id: data.from === 'games' ? 'games' : 'games' };
    const width = Math.min(session.cols, 78);

    const secret = 1 + Math.floor(Math.random() * 100);
    let tries = 0;

    let intro = ansi.clear + ansi.showCursor + '\r\n';
    intro += c('  ┌' + '─'.repeat(width - 4) + '┐', 'brightGreen') + '\r\n';
    intro += c('  │ ', 'brightGreen') + c('HI-LO  ·  Guess the Number', 'brightWhite') + '\r\n';
    intro += c('  └' + '─'.repeat(width - 4) + '┘', 'brightGreen') + '\r\n\r\n';
    intro += c("  I'm thinking of a number between 1 and 100.\r\n", 'white');
    intro += c('  Type your guess and press ENTER. (Q to quit)\r\n\r\n', 'gray');
    session.write(intro);

    for (;;) {
      const ans = (await session.readLine({ label: c('  Guess> ', 'brightGreen'), max: 5 })).trim();
      if (/^q/i.test(ans)) {
        return session.goto('Menu', back);
      }
      const n = parseInt(ans, 10);
      if (Number.isNaN(n) || n < 1 || n > 100) {
        session.writeln(c('  Please enter a whole number from 1 to 100.', 'yellow'));
        continue;
      }
      tries++;
      if (n === secret) {
        session.writeln('');
        session.writeln(c(`  *** CORRECT! ${secret} it was. ***`, 'brightGreen'));
        session.writeln(c(`  You got it in ${tries} ${tries === 1 ? 'guess' : 'guesses'}.`, 'brightWhite'));
        session.writeln(c('\r\n  Press any key to return to the Game Room…', 'gray'));
        await session.readKey();
        return session.goto('Menu', back);
      }
      if (n < secret) {
        session.writeln(c('  ↑ HIGHER', 'brightCyan') + c(`   (guess #${tries})`, 'gray'));
      } else {
        session.writeln(c('  ↓ LOWER', 'brightMagenta') + c(`   (guess #${tries})`, 'gray'));
      }
    }
  },
});
