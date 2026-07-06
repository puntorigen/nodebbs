# nodebbs

Dial into an ANSI BBS from your terminal, like it's 1994.

![NodeBBS web client: dialing in, the animated welcome, login, main menu, Who's Online, and a game — all inside a simulated CRT monitor](docs/demo.gif)

> The browser client (`web/`) dialing into the BBS at 9600 baud: modem handshake, color-cycling ANSI welcome, signup, main menu, Who's Online, a round of Hi-Lo, and the `NO CARRIER` power-off — wrapped in a CRT monitor with scanlines and phosphor glow.

`nodebbs` is a retro bulletin board system in three parts:

- **server/** holds all the session logic and streams raw **ANSI/VT100 bytes** to callers over a WebSocket.
- **client/** is a thin CLI "modem": it plays a dial-up sound, throttles the incoming bytes to a **simulated baud rate**, and forwards your keystrokes back to the server.
- **web/** is a Next.js browser client (deployable to Vercel) that renders the same stream in an `xterm.js` terminal wrapped in a **CRT monitor** — scanlines, phosphor glow, curvature, flicker, and synthesized tube hum + degauss thunk.

Because the server just streams bytes and each client just prints them, colored ASCII, cursor animations, live presence counts, and multi-user chat all work with no special client support.

```mermaid
flowchart LR
    subgraph clientCli [Client CLI]
        dialer[Dialer + modem sound]
        throttle[Baud throttle]
        stdinRaw[Raw stdin]
    end
    subgraph serverCli [Server]
        ws[WebSocket server]
        session[Session state machine]
        screens[Screens + menu config]
        chatHub[Chat hub + presence]
        store[JSON user store]
    end
    dialer --> ws
    ws -->|"raw ANSI bytes"| throttle --> term[Terminal stdout]
    stdinRaw -->|"keystrokes"| ws --> session --> screens
    session --- chatHub
    session --- store
```

## Quick start

Requires Node.js 18+.

```bash
# 1. install both packages
npm run install:all

# 2. start the BBS server (terminal 1)
npm run server

# 3. dial in from a client (terminal 2, or a friend's machine)
npm run call
```

`npm run call` dials `ws://localhost:3000` at a simulated 2400 baud. To connect elsewhere or change speed, run the client directly:

```bash
node client/index.js ws://some-host:3000 --baud 9600
node client/index.js localhost:3000 --no-sound   # skip dial-up sound + handshake delay
node client/index.js --baud 0                     # full speed (no throttle)
```

While connected, press **Ctrl+]** (or Ctrl+C) to hang up. You'll get a satisfying `NO CARRIER`.

### First call

1. The animated logo plays — press any key.
2. At `LOGIN:` type an existing handle, or type `NEW` to register (handle + password).
3. You land in the Main Menu. Press the letter in `[brackets]` to pick an option:
   `[C]` chat, `[G]` games, `[W]` who's online, `[X]` log off.

Open a second client and log in as a different user to try multi-user chat and watch the "callers online" count change.

## Web client (browser + CRT)

The [web/](web) app is a Next.js (App Router) client that connects to the same WebSocket server and renders the ANSI stream inside a simulated CRT monitor. It keeps the terminal locked to a true **80 columns** (scaling the font to fit) so the server's ANSI art always lines up.

Run it locally alongside the server:

```bash
cd web
npm install
npm run dev            # http://localhost:3001
```

Then open the page, set the **SERVER** field (defaults to `ws://localhost:3000`), pick a baud rate + modem sound, and hit **DIAL**. Use the **HANG UP** button to disconnect.

### Deploy to Vercel

The web client is a standard Next.js app and deploys to Vercel with no extra config:

1. Point Vercel at the repo and set the **Root Directory** to `web/`.
2. Add an environment variable so the dialer defaults to your public server instead of localhost:

   ```
   NEXT_PUBLIC_BBS_URL=wss://your-bbs-host.example.com
   ```

   Use `wss://` (TLS) — browsers block insecure `ws://` from an `https://` page. Callers can still override the target in the SERVER field at runtime.
3. Deploy. The BBS server itself is a long-lived WebSocket process, so host it somewhere that keeps a socket open (a small VM, Fly.io, Railway, a container, etc.) — not on Vercel's serverless functions.

## Configuration

Edit [server/nodebbs.json](server/nodebbs.json):

```json
{
  "name": "The Demo BBS",
  "sysop": "Pablo",
  "description": "A NodeJS ANSI BBS you dial into from your terminal",
  "port": 3000,
  "baudBanner": 2400,
  "startScreen": "Welcome"
}
```

User accounts are stored (with scrypt-hashed passwords) in `server/data/users.json`, created automatically on first signup.

## How it's organized

```
server/src/
  index.js          WebSocket server; one Session per caller
  session.js        Per-caller state machine: output, key input, navigation
  menu.config.js    Declarative menus (pure data)
  art/index.js      ANSI block-font banners + animated welcome
  lib/
    ansi.js         Colors, cursor moves, boxes, centering
    ansimate.js     Frame animation + typewriter (cancellable on keypress)
    keys.js         Decodes raw bytes into key tokens (arrows, enter, etc.)
    screen.js       defineScreen(): turns { art, enter, key, leave } into a screen
    users.js        JSON user store, scrypt password hashing
    chat.js         Global chat room: join/leave/broadcast + history
    presence.js     Live session registry (online counts, who's online)
  screens/
    welcome.js login.js menu.js chat.js whosonline.js goodbye.js
    games/hilo.js games/tictactoe.js

client/
  index.js          Dialer: modem sound, CONNECT banner, raw stdin bridge
  lib/throttle.js   Baud-rate byte drainer (baud / 10 bytes per second)
  assets/dial-up.mp3

web/
  app/page.js               Dialer UI (server/baud/sound) + connected view
  app/layout.js globals.css Fonts, base theme, dialer/status-bar styling
  components/CrtTerminal.js xterm bridge: WebSocket, baud throttle, 80-col lock
  components/crt.css        CRT overlays: scanlines, glow, curvature, flicker
  lib/throttle.js           Browser baud throttle (Uint8Array)
  lib/sfx.js                Web Audio CRT hum + degauss thunk
```

## Adding a menu item

Menus are just data in [server/menu.config.js](server/menu.config.js). Add an entry to any menu's `items`:

```js
{ key: 'N', label: 'My New Thing', screen: 'MyScreen' }   // go to a screen
{ key: 'G', label: 'Game Room',    menu: 'games' }         // open another menu
{ key: 'X', label: 'Log Off',      action: 'logoff' }      // built-in action
```

Add a whole new sub-menu by adding a new keyed object and pointing to it with `menu: 'yourId'`.

## Adding a screen

A screen is a small module built with `defineScreen`. `enter` renders; `key` handles one keystroke at a time; `leave` cleans up. Navigate with `session.goto('Name', data)`.

```js
// server/src/screens/myscreen.js
const { defineScreen } = require('../lib/screen');
const ansi = require('../lib/ansi');

module.exports = defineScreen({
  activity: 'My Screen',                 // shown in Who's Online
  async enter(session) {
    session.write(ansi.clear + ansi.color('Hello, ' + session.user.handle + '!\r\n', 'brightCyan'));
    session.write('Press Q to go back.\r\n');
  },
  async key(session, key) {
    if ((key.ch || '').toLowerCase() === 'q') session.goto('Menu', { id: 'main' });
  },
});
```

Register it in [server/src/screens/index.js](server/src/screens/index.js):

```js
MyScreen: require('./myscreen'),
```

Then point a menu item at it with `screen: 'MyScreen'`.

Useful `session` helpers inside a screen:

- `session.write(str)` / `session.writeln(str)` — send ANSI to the caller
- `await session.readLine({ label, mask, max })` — classic line input (mask for passwords)
- `await session.readKey()` — one keystroke (throws when the caller navigates away)
- `session.cols` / `session.rows` — the caller's terminal size
- `session.user` — the logged-in user, or `null`
- `session.goto(name, data)` — navigate to another screen

## Tips for great ANSI

- Use `require('../lib/ansi')` helpers: `ansi.color(text, 'brightCyan')`, `ansi.moveTo(row, col)`, `ansi.center(text, width)`, `ansi.box(lines)`.
- For animation, `require('../lib/ansimate')` gives `playFrames(session, frames, { fps })` and `typewriter(session, text)`, both cancellable when the caller presses a key.
- Test at a real baud rate (`--baud 1200`) — it changes how animations feel.
