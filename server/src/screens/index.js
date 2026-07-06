'use strict';

// Screen registry. `goto('Name')` looks screens up here by key.
module.exports = {
  Welcome: require('./welcome'),
  Login: require('./login'),
  Menu: require('./menu'),
  Chat: require('./chat'),
  WhosOnline: require('./whosonline'),
  Goodbye: require('./goodbye'),
  HiLo: require('./games/hilo'),
  TicTacToe: require('./games/tictactoe'),
};
