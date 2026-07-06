'use client';

import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import './crt.css';
import { BaudThrottle } from '@/lib/throttle';
import { createCrtSfx } from '@/lib/sfx';
import { synthHandshake } from '@/lib/modem';

const TERM_FONT = "'DejaVu Sans Mono','Menlo','Consolas','Liberation Mono',monospace";

const THEME = {
  background: 'rgba(4, 18, 10, 0)',
  foreground: '#33ff66',
  cursor: '#7dffa2',
  cursorAccent: '#04120a',
  selectionBackground: '#1f9e3f',
  black: '#04120a',
  red: '#ff5f56',
  green: '#33ff66',
  yellow: '#ffd866',
  blue: '#57c7ff',
  magenta: '#ff6ac1',
  cyan: '#5ffbf1',
  white: '#c7ffd6',
  brightBlack: '#3a6b4a',
  brightRed: '#ff8a80',
  brightGreen: '#87ffa8',
  brightYellow: '#ffe08a',
  brightBlue: '#8fd6ff',
  brightMagenta: '#ff9bd6',
  brightCyan: '#a6fff6',
  brightWhite: '#eafff0',
};

function hostLabel(url) {
  return String(url).replace(/^wss?:\/\//, '');
}

export default function CrtTerminal({ url, baud, sound, onStatus, onClosed }) {
  const hostRef = useRef(null);
  const screenRef = useRef(null);

  useEffect(() => {
    let disposed = false;
    let term = null;
    let fitAddon = null;
    let ws = null;
    let resizeObs = null;
    let dotTimer = null;
    let sfx = null;
    const phaseTimers = [];

    let opened = false;
    let live = false;
    let hangingUp = false;
    const pending = [];
    const enc = new TextEncoder();
    // The synthesized handshake's real length gates the CONNECT banner so the
    // audio and the "connection" finish together. Longer bauds = more drama.
    const handshake = sound ? synthHandshake(baud) : null;
    const MIN_DIAL_MS = handshake ? Math.round(handshake.duration * 1000) : 600;
    const dialStart = Date.now();

    function clearPhaseTimers() {
      for (const id of phaseTimers) clearTimeout(id);
      phaseTimers.length = 0;
    }

    const throttle = new BaudThrottle({
      baud,
      sink: (bytes) => {
        if (term) term.write(bytes);
      },
    });

    const status = (s) => onStatus && onStatus(s);

    function sendSize(t, cols, rows) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t, cols: cols || (term && term.cols) || 80, rows: rows || (term && term.rows) || 24 }));
      }
    }

    // Lock the terminal to a true 80-column BBS width by scaling the font so 80
    // columns exactly span the container, then let rows fill the height. This
    // keeps the browser view aligned with the server's 80-column ANSI art.
    const TARGET_COLS = 80;
    function fitTo80() {
      if (!term || !fitAddon) return;
      try {
        const base = fitAddon.proposeDimensions();
        if (!base || !base.cols) {
          fitAddon.fit();
          return;
        }
        const newFont = Math.max(7, Math.min(28, (term.options.fontSize * base.cols) / TARGET_COLS));
        term.options.fontSize = newFont;
        const after = fitAddon.proposeDimensions();
        const rows = after && after.rows ? after.rows : 24;
        term.resize(TARGET_COLS, Math.max(24, rows));
      } catch (_) {
        /* ignore fit errors */
      }
    }

    function maybeGoLive() {
      const wait = Math.max(0, MIN_DIAL_MS - (Date.now() - dialStart));
      setTimeout(goLive, wait);
    }

    function goLive() {
      if (live || hangingUp || disposed) return;
      live = true;
      if (dotTimer) {
        clearInterval(dotTimer);
        dotTimer = null;
      }
      clearPhaseTimers();
      if (sfx) sfx.stopHandshake();
      const speed = baud > 0 ? String(baud) : 'FAST';
      term.write(`\r\nCONNECT ${speed}\r\n`);
      status(`CONNECT ${speed}`);
      fitTo80();
      sendSize('hello', term.cols, term.rows);
      for (const c of pending) throttle.push(c);
      pending.length = 0;
      term.focus();
    }

    function onCarrierLost() {
      if (hangingUp || disposed) return;
      throttle.flush();
      if (dotTimer) {
        clearInterval(dotTimer);
        dotTimer = null;
      }
      if (term) term.write('\r\n\r\n\x1b[1;31mNO CARRIER\x1b[0m\r\n');
      status('NO CARRIER');
      if (sfx) sfx.stop();
      if (screenRef.current) {
        screenRef.current.classList.remove('powered');
        screenRef.current.classList.add('poweroff');
      }
      onClosed && onClosed();
    }

    function failDial(msg) {
      if (dotTimer) {
        clearInterval(dotTimer);
        dotTimer = null;
      }
      clearPhaseTimers();
      if (term) term.write(`\r\n\r\n\x1b[1;31m${msg}\x1b[0m\r\n`);
      status(msg);
      if (sfx) sfx.stop();
      onClosed && onClosed();
    }

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !hostRef.current) return;

      term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontFamily: TERM_FONT,
        fontSize: 16,
        lineHeight: 1.0,
        letterSpacing: 0,
        scrollback: 1000,
        theme: THEME,
        allowTransparency: true,
        allowProposedApi: true,
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(hostRef.current);
      fitTo80();
      term.focus();

      // Dial intro (rendered locally in the terminal).
      term.write('\x1b[2J\x1b[H');
      term.write('NodeBBS Web Client\r\n');
      term.write('\x1b[2m(click HANG UP to disconnect)\x1b[0m\r\n\r\n');
      term.write(`ATDT ${hostLabel(url)}\r\n`);
      term.write('DIALING');
      dotTimer = setInterval(() => term && term.write('.'), 350);
      status('DIALING');

      if (sound) {
        sfx = createCrtSfx();
        sfx.resume();
        // Tube powers on: degauss thunk + steady hum.
        sfx.thunk();
        sfx.startHum();
        // Baud-dependent synthesized modem handshake, with stage labels
        // (RINGING, CARRIER DETECT, TRAINING…) printed in sync with the audio.
        sfx.playHandshake(handshake.samples, handshake.sampleRate);
        for (const p of handshake.phases) {
          if (!p.label) continue;
          phaseTimers.push(
            setTimeout(() => {
              if (term && !live && !disposed) term.write(`\r\n${p.label}`);
            }, Math.round(p.t * 1000))
          );
        }
      }

      resizeObs = new ResizeObserver(() => fitTo80());
      resizeObs.observe(hostRef.current);
      term.onResize(({ cols, rows }) => sendSize('size', cols, rows));
      term.onData((d) => {
        if (live && ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
      });

      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        opened = true;
        maybeGoLive();
      };
      ws.onmessage = (ev) => {
        const chunk = typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data);
        if (live) throttle.push(chunk);
        else pending.push(chunk);
      };
      ws.onclose = () => onCarrierLost();
      ws.onerror = () => {
        if (!opened) failDial('NO ANSWER');
      };
    })();

    return () => {
      disposed = true;
      hangingUp = true;
      if (dotTimer) clearInterval(dotTimer);
      clearPhaseTimers();
      throttle.stop();
      if (resizeObs) resizeObs.disconnect();
      if (sfx) {
        try {
          sfx.stop();
        } catch (_) {
          /* ignore */
        }
      }
      if (ws) {
        try {
          ws.close();
        } catch (_) {
          /* ignore */
        }
      }
      if (term) {
        try {
          term.dispose();
        } catch (_) {
          /* ignore */
        }
      }
    };
  }, [url, baud, sound, onStatus, onClosed]);

  return (
    <div className="crt-screen powering" ref={screenRef}>
      <div className="crt-terminal" ref={hostRef} />
      <div className="crt-overlay crt-scanlines" />
      <div className="crt-overlay crt-mask" />
      <div className="crt-overlay crt-vignette" />
      <div className="crt-overlay crt-glow" />
      <div className="crt-overlay crt-flicker" />
    </div>
  );
}
