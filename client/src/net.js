/**
 * WebSocket client for the bridge.
 *
 * Browsers can't speak UDP, so OSC-to-the-Pi isn't an option — everything rides
 * a single WebSocket as JSON. The wire format uses parameter *names*; CC
 * numbers live only in the bridge and params/waaave_params.json.
 */

export class Net {
  constructor(url) {
    // wss when the page is https, which it must be for WebXR to exist at all
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.url = url || `${proto}://${location.host}/ws`;
    this.ws = null;
    this.handlers = new Map();
    this.connected = false;
    this.params = null;
    this.values = {};
    this.toggles = {};
    this.rtt = 0;
    this._retry = 0;
    this._pending = new Map();   // param id -> value, flushed once per frame
    this._flushQueued = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  _emit(type, payload) {
    for (const fn of this.handlers.get(type) || []) {
      try { fn(payload); } catch (e) { console.error(`handler ${type}:`, e); }
    }
  }

  connect() {
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this._retry = 0;
      this._emit('open');
      this.send({ t: 'hello' });
      this._pingTimer = setInterval(() => {
        this.send({ t: 'ping', ts: performance.now() });
      }, 4000);
    };

    this.ws.onclose = () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      this._emit('close');
      this._scheduleReconnect();
    };

    this.ws.onerror = () => { /* onclose always follows; nothing useful here */ };

    this.ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case 'params':
          this.params = m;
          this.values = { ...m.values };
          this.toggles = { ...m.toggle_values };
          this._emit('params', m);
          break;
        case 'val':  this.values[m.p] = m.v; this._emit('val', m); break;
        case 'vals': Object.assign(this.values, m.vals); this._emit('vals', m); break;
        case 'tog':  this.toggles[m.p] = m.v; this._emit('tog', m); break;
        case 'reset':
          this.values = { ...m.values };
          this.toggles = { ...m.toggle_values };
          this._pending.clear();      // don't replay stale drags over the reset
          this._emit('reset', m);
          break;
        case 'mirrorstate': this._emit('mirrorstate', m); break;
        case 'files': this._emit('files', m.files); break;
        case 'video': this._emit('video', m); break;
        case 'pong': this.rtt = performance.now() - m.ts; this._emit('pong', this.rtt); break;
        case 'err': console.warn('bridge:', m.m); this._emit('err', m); break;
      }
    };
  }

  _scheduleReconnect() {
    // back off, but stay responsive — a gig box should reconnect fast
    const delay = Math.min(4000, 250 * 2 ** this._retry++);
    setTimeout(() => this.connect(), delay);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /**
   * Set a continuous param, 0..1.
   *
   * Hand tracking and knob drags fire far faster than MIDI needs, so writes are
   * coalesced into one bundle per animation frame. The bridge additionally
   * drops anything that doesn't change the 7-bit value.
   */
  set(id, v) {
    v = Math.max(0, Math.min(1, v));
    this.values[id] = v;
    this._pending.set(id, v);

    // NOT requestAnimationFrame: the window's rAF is suspended for the whole
    // life of an immersive XR session, so a rAF-scheduled flush never runs and
    // every value silently piles up in _pending. The XR render loop calls
    // flush() directly each frame; this timer is the fallback for anything
    // outside a session (the landing page, 2D debugging).
    if (!this._flushQueued) {
      this._flushQueued = true;
      setTimeout(() => this._flush(), 16);
    }
  }

  /** Called once per XR frame — the real coalescing point in a session. */
  flush() { this._flush(); }

  _flush() {
    this._flushQueued = false;
    if (!this._pending.size) return;
    if (this._pending.size === 1) {
      const [id, v] = this._pending.entries().next().value;
      this.send({ t: 'set', p: id, v });
    } else {
      this.send({ t: 'setmany', vals: Object.fromEntries(this._pending) });
    }
    this._pending.clear();
  }

  toggle(id, on) {
    this.toggles[id] = on;
    this.send({ t: 'trig', p: id, v: !!on });
  }

  reset()     { this.send({ t: 'reset' }); }
  listFiles() { this.send({ t: 'ls' }); }
  play(path)  { this.send({ t: 'play', path }); }
  pause(v)    { this.send({ t: 'pause', v }); }
  stop()      { this.send({ t: 'stop' }); }
}
