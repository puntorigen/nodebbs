'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const CrtTerminal = dynamic(() => import('@/components/CrtTerminal'), { ssr: false });

const BAUDS = [300, 1200, 2400, 9600, 14400, 0];
const baudLabel = (b) => (b === 0 ? 'FULL' : String(b));

const DEFAULT_URL = process.env.NEXT_PUBLIC_BBS_URL || 'ws://localhost:3000';

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) u = DEFAULT_URL;
  if (!/^wss?:\/\//.test(u)) u = 'ws://' + u;
  const hostPart = u.replace(/^wss?:\/\//, '');
  if (!/:\d+/.test(hostPart)) u += ':3000';
  return u;
}

export default function Home() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [baud, setBaud] = useState(2400);
  const [sound, setSound] = useState(true);
  const [line, setLine] = useState('internet'); // internet | phone | loopback
  const [robust, setRobust] = useState(false);
  const [phase, setPhase] = useState('dialer');
  const [status, setStatus] = useState('');
  const [carrierLost, setCarrierLost] = useState(false);
  const [connUrl, setConnUrl] = useState('');

  // ?loopback=1 offers the in-process DSP self-test as a third LINE option.
  const [loopbackEnabled, setLoopbackEnabled] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('loopback') === '1') {
      setLoopbackEnabled(true);
    }
  }, []);

  const onClosed = useCallback(() => setCarrierLost(true), []);

  const isAudio = line === 'phone' || line === 'loopback';

  const dial = () => {
    setConnUrl(line === 'internet' ? normalizeUrl(url) : '');
    setStatus('DIALING');
    setCarrierLost(false);
    setPhase('connected');
  };

  const hangup = () => {
    setPhase('dialer');
    setStatus('');
    setCarrierLost(false);
  };

  const lineTag =
    line === 'phone' ? '☎ PHONE LINE' : line === 'loopback' ? '⟲ LOOPBACK' : `◉ ${connUrl.replace(/^wss?:\/\//, '')}`;

  if (phase === 'connected') {
    return (
      <div className="conn">
        <div className="statusbar">
          <span className="sb-left">{lineTag}</span>
          <span className={'sb-status ' + (carrierLost ? 'lost' : 'live')}>{status || '…'}</span>
          <button className="sb-btn" onClick={hangup}>
            {carrierLost ? 'REDIAL' : 'HANG UP'}
          </button>
        </div>
        <div className="bezel">
          <CrtTerminal
            url={connUrl}
            baud={baud}
            sound={sound}
            line={line}
            robust={robust}
            onStatus={setStatus}
            onClosed={onClosed}
          />
        </div>
      </div>
    );
  }

  const LINES = [
    { id: 'internet', label: 'INTERNET' },
    { id: 'phone', label: 'PHONE LINE' },
    ...(loopbackEnabled ? [{ id: 'loopback', label: 'LOOPBACK' }] : []),
  ];

  return (
    <div className="dialer">
      <div className="dialer-panel">
        <h1 className="dialer-title">NODEBBS</h1>
        <p className="dialer-sub">// dial into an ANSI BBS from your browser</p>

        <div className="field">
          <label>LINE</label>
          <div className="baud-row">
            {LINES.map((l) => (
              <button
                key={l.id}
                type="button"
                className={'baud-chip' + (l.id === line ? ' active' : '')}
                onClick={() => setLine(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {line === 'internet' && (
          <div className="field">
            <label htmlFor="host">SERVER</label>
            <input
              id="host"
              type="text"
              value={url}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && dial()}
              placeholder="ws://localhost:3000"
            />
          </div>
        )}

        {line === 'phone' && (
          <p className="dialer-hint" style={{ marginTop: 0 }}>
            Places a real Bell 103 acoustic call over your speaker and microphone. Point this device at a machine
            running <code>node server/src/index.js --audio</code>, turn the volume up (~70%), and allow the mic prompt.
            30 chars/sec — the welcome screen takes about a minute. That is the point.
          </p>
        )}

        {line === 'loopback' && (
          <p className="dialer-hint" style={{ marginTop: 0 }}>
            In-process DSP self-test: a full originate + answer modem pair wired through a virtual air. No hardware,
            no server. Type and the far side echoes you back in UPPERCASE.
          </p>
        )}

        {line === 'internet' && (
          <div className="field">
            <label>BAUD</label>
            <div className="baud-row">
              {BAUDS.map((b) => (
                <button
                  key={b}
                  type="button"
                  className={'baud-chip' + (b === baud ? ' active' : '')}
                  onClick={() => setBaud(b)}
                >
                  {baudLabel(b)}
                </button>
              ))}
            </div>
          </div>
        )}

        {isAudio && (
          <div className="field">
            <label>ROBUST (FEC)</label>
            <button
              type="button"
              className={'baud-chip' + (robust ? ' active' : '')}
              onClick={() => setRobust((r) => !r)}
            >
              {robust ? 'ON' : 'OFF'}
            </button>
          </div>
        )}

        <div className="field">
          <label>{line === 'phone' ? 'MODEM SOUND (CRT AMBIENCE)' : 'MODEM SOUND'}</label>
          <button
            type="button"
            className={'baud-chip' + (sound ? ' active' : '')}
            onClick={() => setSound((s) => !s)}
          >
            {sound ? 'ON' : 'OFF'}
          </button>
        </div>

        <button className="dial-btn" onClick={dial}>
          DIAL
        </button>

        <p className="dialer-hint">
          Type an existing handle at LOGIN, or NEW to register. Open a second tab to chat with yourself. Use the HANG
          UP button to disconnect.
        </p>
      </div>
    </div>
  );
}
