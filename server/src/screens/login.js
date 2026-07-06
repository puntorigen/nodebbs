'use strict';

const { defineScreen } = require('../lib/screen');
const ansi = require('../lib/ansi');
const art = require('../art');
const users = require('../lib/users');
const presence = require('../lib/presence');

const c = ansi.color;

async function signup(session) {
  session.write('\r\n' + c('- NEW USER REGISTRATION -', 'brightYellow') + '\r\n');
  session.write(c('Pick a handle other callers will see.', 'gray') + '\r\n\r\n');

  const handle = (await session.readLine({ label: c('New handle: ', 'brightWhite'), max: 20 })).trim();
  const err = users.validateHandle(handle);
  if (err) {
    session.writeln(c('  ! ' + err, 'red'));
    return false;
  }
  if (users.exists(handle)) {
    session.writeln(c('  ! That handle is already registered. Try logging in.', 'red'));
    return false;
  }

  const pw = await session.readLine({ label: c('New password: ', 'brightWhite'), mask: true, max: 40 });
  const confirm = await session.readLine({ label: c('Confirm password: ', 'brightWhite'), mask: true, max: 40 });
  if (pw !== confirm) {
    session.writeln(c('  ! Passwords did not match.', 'red'));
    return false;
  }

  try {
    await users.create(handle, pw);
  } catch (e) {
    session.writeln(c('  ! ' + e.message, 'red'));
    return false;
  }

  session.user = { handle };
  session.writeln('');
  session.writeln(c(`  Welcome aboard, ${handle}! Account created.`, 'brightGreen'));
  return true;
}

module.exports = defineScreen({
  activity: 'At Login',
  async enter(session) {
    session.write(ansi.clear + ansi.showCursor);
    session.write(art.loginBanner(session.cols));
    session.write('\r\n' + c("Type your handle to log in, or ", 'gray') + c('NEW', 'brightYellow') + c(' to register.', 'gray') + '\r\n\r\n');

    for (;;) {
      const handle = (await session.readLine({ label: c('LOGIN: ', 'brightCyan'), max: 20 })).trim();
      if (!handle) continue;

      if (/^new$/i.test(handle)) {
        const ok = await signup(session);
        if (ok) break;
        session.writeln('');
        continue;
      }

      const pw = await session.readLine({ label: c('PASSWORD: ', 'brightCyan'), mask: true, max: 40 });
      const user = await users.authenticate(handle, pw);
      if (!user) {
        session.writeln(c('\r\nLogin incorrect. Try again, or type NEW to register.\r\n', 'red'));
        continue;
      }
      if (presence.isOnline(user.handle)) {
        session.writeln(c('\r\nThat account is already connected from another session.\r\n', 'red'));
        continue;
      }
      session.user = user;
      session.writeln('');
      session.writeln(c(`  Connection established. Welcome back, ${user.handle}.`, 'brightGreen'));
      const calls = user.calls ? ` (call #${user.calls})` : '';
      if (calls) session.writeln(c('  ' + calls.trim(), 'gray'));
      break;
    }

    // Brief "handshake complete" beat before the menu.
    session.write(c('\r\n  Loading main menu', 'gray'));
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 180));
      session.write(c('.', 'gray'));
    }
    session.goto('Menu', { id: 'main' });
  },
});
