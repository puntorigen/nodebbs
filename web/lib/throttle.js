// Browser port of the CLI baud throttle. Drains bytes to a sink at a fixed baud
// rate so ANSI redraws and animations reveal at a period-correct pace. 8N1
// framing is ~10 bits per byte, so throughput is baud / 10 bytes per second.
// baud === 0 means "full speed".

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class BaudThrottle {
  constructor({ baud = 2400, sink, tickMs = 16 } = {}) {
    this.baud = baud;
    this.sink = sink || (() => {});
    this.tickMs = tickMs;
    this.queue = new Uint8Array(0);
    this._credit = 0; // fractional bytes carried between ticks
    this._timer = null;
  }

  get bytesPerSec() {
    return this.baud > 0 ? this.baud / 10 : Infinity;
  }

  push(data) {
    const buf = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    if (this.baud <= 0) {
      this.sink(buf);
      return;
    }
    this.queue = concat(this.queue, buf);
    this._ensureTimer();
  }

  _ensureTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this.tickMs);
  }

  _tick() {
    if (this.queue.length === 0) {
      clearInterval(this._timer);
      this._timer = null;
      this._credit = 0;
      return;
    }
    this._credit += (this.bytesPerSec * this.tickMs) / 1000;
    const n = Math.floor(this._credit);
    if (n <= 0) return;
    this._credit -= n;
    const take = Math.min(n, this.queue.length);
    const chunk = this.queue.subarray(0, take);
    this.queue = this.queue.subarray(take);
    this.sink(chunk);
  }

  // Emit everything now (used on hang-up so the last bytes aren't lost).
  flush() {
    if (this.queue.length) {
      this.sink(this.queue);
      this.queue = new Uint8Array(0);
    }
    this.stop();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
