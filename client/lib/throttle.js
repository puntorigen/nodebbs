'use strict';

// Drains bytes to a sink at a fixed baud rate so ANSI redraws and animations
// reveal at a period-correct pace. 8N1 framing is ~10 bits per byte, so the
// throughput is baud / 10 bytes per second. baud === 0 means "full speed".

class BaudThrottle {
  constructor({ baud = 2400, sink, tickMs = 16 } = {}) {
    this.baud = baud;
    this.sink = sink || ((s) => process.stdout.write(s));
    this.tickMs = tickMs;
    this.queue = Buffer.alloc(0);
    this._credit = 0; // fractional bytes carried between ticks
    this._timer = null;
  }

  get bytesPerSec() {
    return this.baud > 0 ? this.baud / 10 : Infinity;
  }

  push(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (this.baud <= 0) {
      // No throttling: emit immediately.
      this.sink(buf);
      return;
    }
    this.queue = Buffer.concat([this.queue, buf]);
    this._ensureTimer();
  }

  _ensureTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this.tickMs);
    // Don't keep the process alive solely for the drain timer.
    if (this._timer.unref) this._timer.unref();
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

  // Flush everything now (used on hang-up so the last bytes aren't lost).
  flush() {
    if (this.queue.length) {
      this.sink(this.queue);
      this.queue = Buffer.alloc(0);
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = { BaudThrottle };
