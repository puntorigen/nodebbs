'use strict';

const { defineScreen } = require('../lib/screen');
const art = require('../art');

// Animated logo, then wait for any key to proceed to the login prompt.
module.exports = defineScreen({
  activity: 'Connecting',
  art: art.welcome,
  async key(session) {
    session.goto('Login');
  },
});
