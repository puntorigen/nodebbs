'use client';

import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import './crt.css';
import { BaudThrottle } from '@/lib/throttle';
import { createCrtSfx } from '@/lib/sfx';
import { synthHandshake } from '@/lib/modem';
import { createTransport } from '@/lib/transport';

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

function dialTarget(line, url) {
  if (line === 'phone') return 'ACOUSTIC LINE';
  if (line === 'loopback') return 'LOOPBACK (DSP SELF-TEST)';
  return hostLabel(url);
}

export default function CrtTerminal({ url, baud, sound, line = 'internet', robust = false, onStatus, onClosed }) {
  const hostRef = useRef(null);
  const screenRef = useRef(null);

  useEffect(() => {
    let disposed = false;
    let term = null;
    let fitAddon = null;
    let transport = null;
    let resizeObs = null;
    let dotTimer = null;
    let sfx = null;
    const phaseTimers = [];

    const isAudio = line === 'phone' || line === 'loopback';
    let live = false;
    let hangingUp = false;
    const pending = [];
    const enc = new TextEncoder();
    // Over a real (or looped-back) acoustic line the channel *is* the throttle
    // at ~30 B/s, so let bytes through at full speed; only the INTERNET line
    // simulates a baud rate for period-correct redraw pacing.
    const effBaud = isAudio ? 0 : baud;
    // On the INTERNET line the synthesized handshake's length gates the CONNECT
    // banner so audio and "connection" finish together. The acoustic lines are
    // event-driven (the modem reports CONNECT), so no gate is used there.
    const useHandshake = sound && line === 'internet';
    const handshake = useHandshake ? synthHandshake(baud) : null;
    const MIN_DIAL_MS = handshake ? Math.round(handshake.duration * 1000) : 600;
    const dialStart = Date.now();

    function clearPhaseTimers() {
      for (const id of phaseTimers) clearTimeout(id);
      phaseTimers.length = 0;
    }

    const throttle = new BaudThrottle({
      baud: effBaud,
      sink: (bytes) => {
        if (term) term.write(bytes);
      },
    });

    const status = (s) => onStatus && onStatus(s);

    // Lock the terminal to a true 80-column BBS width by scaling the font so 80
    // columns exactly span the container, then let rows fill the height.
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
      if (line === 'internet') {
        const speed = baud > 0 ? String(baud) : 'FAST';
        term.write(`\r\nCONNECT ${speed}\r\n`);
        status(`CONNECT ${speed}`);
      } else {
        // The acoustic modem already printed its CONNECT banner via onStatus.
        term.write('\r\n');
      }
      fitTo80();
      transport.sendControl('hello', term.cols, term.rows);
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
      term.write(`ATDT ${dialTarget(line, url)}\r\n`);
      term.write('DIALING');
      dotTimer = setInterval(() => term && term.write('.'), 350);
      status('DIALING');

      if (sound) {
        sfx = createCrtSfx();
        sfx.resume();
        // Tube powers on: degauss thunk + steady hum.
        sfx.thunk();
        sfx.startHum();
        if (useHandshake) {
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
      }

      resizeObs = new ResizeObserver(() => fitTo80());
      resizeObs.observe(hostRef.current);
      term.onResize(({ cols, rows }) => transport && transport.sendControl('size', cols, rows));
      term.onData((d) => {
        if (live && transport) transport.send(enc.encode(d));
      });

      transport = createTransport({ line, url, robust });
      transport.onOpen = () => {
        if (line === 'internet') maybeGoLive();
        else goLive();
      };
      transport.onData = (chunk) => {
        if (live) throttle.push(chunk);
        else pending.push(chunk);
      };
      transport.onClose = () => onCarrierLost();
      transport.onStatus = (s) => {
        status(s);
        // On the acoustic lines, echo dial-progress banners into the terminal
        // (the modem, not a synth soundtrack, is the source of truth here).
        if (isAudio && term && !live) term.write(`\r\n${s}`);
      };
      transport.onError = (msg) => failDial(msg);
      transport.start();
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
      if (transport) {
        try {
          transport.close();
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
  }, [url, baud, sound, line, robust, onStatus, onClosed]);

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
