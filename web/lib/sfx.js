// Synthesized CRT sound effects via the Web Audio API — no asset files needed.
// A low mains-style hum with a faint flyback whine while powered on, and a
// short "degauss thunk" when the tube powers up.

export function createCrtSfx() {
  let ctx = null;
  let hum = null;
  let whine = null;

  function ensure() {
    if (typeof window === 'undefined') return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  return {
    resume() {
      ensure();
    },

    // Deep, fast-decaying thump like a CRT degaussing at power-on.
    thunk() {
      const c = ensure();
      if (!c) return;
      const t = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(140, t);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.28);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    },

    // Continuous quiet hum + very faint high whine.
    startHum() {
      const c = ensure();
      if (!c || hum) return;

      hum = c.createOscillator();
      const humGain = c.createGain();
      hum.type = 'sawtooth';
      hum.frequency.value = 60;
      humGain.gain.value = 0.01;
      hum.connect(humGain).connect(c.destination);
      hum.start();

      whine = c.createOscillator();
      const whineGain = c.createGain();
      whine.type = 'sine';
      whine.frequency.value = 15700;
      whineGain.gain.value = 0.0012;
      whine.connect(whineGain).connect(c.destination);
      whine.start();
    },

    stop() {
      try {
        if (hum) hum.stop();
      } catch (_) {
        /* already stopped */
      }
      try {
        if (whine) whine.stop();
      } catch (_) {
        /* already stopped */
      }
      hum = null;
      whine = null;
      if (ctx) {
        try {
          ctx.close();
        } catch (_) {
          /* ignore */
        }
        ctx = null;
      }
    },
  };
}
