'use client';

import { useCallback, useState } from 'react';
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
  const [phase, setPhase] = useState('dialer');
  const [status, setStatus] = useState('');
  const [carrierLost, setCarrierLost] = useState(false);
  const [connUrl, setConnUrl] = useState('');

  const onClosed = useCallback(() => setCarrierLost(true), []);

  const dial = () => {
    setConnUrl(normalizeUrl(url));
    setStatus('DIALING');
    setCarrierLost(false);
    setPhase('connected');
  };

  const hangup = () => {
    setPhase('dialer');
    setStatus('');
    setCarrierLost(false);
  };

  if (phase === 'connected') {
    return (
      <div className="conn">
        <div className="statusbar">
          <span className="sb-left">◉ {connUrl.replace(/^wss?:\/\//, '')}</span>
          <span className={'sb-status ' + (carrierLost ? 'lost' : 'live')}>{status || '…'}</span>
          <button className="sb-btn" onClick={hangup}>
            {carrierLost ? 'REDIAL' : 'HANG UP'}
          </button>
        </div>
        <div className="bezel">
          <CrtTerminal url={connUrl} baud={baud} sound={sound} onStatus={setStatus} onClosed={onClosed} />
        </div>
      </div>
    );
  }

  return (
    <div className="dialer">
      <div className="dialer-panel">
        <h1 className="dialer-title">NODEBBS</h1>
        <p className="dialer-sub">// dial into an ANSI BBS from your browser</p>

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

        <div className="field">
          <label>MODEM SOUND</label>
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
          Type an existing handle at LOGIN, or NEW to register. Open a second tab to chat with yourself.
          Use the HANG UP button to disconnect.
        </p>
      </div>
    </div>
  );
}
