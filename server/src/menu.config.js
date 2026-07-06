'use strict';

// Menus are pure data. The generic `Menu` screen renders any of these.
// Each item does one of:
//   - screen: 'Name'   -> navigate to that screen
//   - menu:   'id'      -> open another menu (by key in this object)
//   - action: 'logoff' -> special built-in action
//
// To add a menu item, just add an entry here. To add a whole new menu, add a
// new keyed object and point to it from another menu's item via `menu:`.

module.exports = {
  main: {
    title: 'MAIN MENU',
    color: 'brightCyan',
    items: [
      { key: 'C', label: 'Chat Room', screen: 'Chat' },
      { key: 'G', label: 'Game Room', menu: 'games' },
      { key: 'W', label: "Who's Online", screen: 'WhosOnline' },
      { key: 'X', label: 'Log Off', action: 'logoff' },
    ],
  },

  games: {
    title: 'GAME ROOM',
    color: 'brightGreen',
    parent: 'main',
    items: [
      { key: 'H', label: 'Hi-Lo (Guess the Number)', screen: 'HiLo' },
      { key: 'T', label: 'Tic-Tac-Toe vs. the CPU', screen: 'TicTacToe' },
      { key: 'Q', label: 'Back to Main Menu', menu: 'main' },
    ],
  },
};
