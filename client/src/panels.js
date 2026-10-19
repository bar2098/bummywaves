/**
 * The three concrete panels.
 *
 * Layouts are derived from the param table the bridge sends, never hardcoded.
 * The nanoKONTROL2 grid falls out of CC arithmetic: knobs 16-23, S 32-39,
 * M 48-55, R 64-71, sliders 120-127 — eight channels of five controls, which
 * is exactly the physical device Andrei Jay mapped waaave_pool to.
 */

import { Panel, Slider, Knob, Button, Label, List, THEME, roundRect } from './panel.js';
import { Feed } from './feed.js';

const byCC = (arr, cc) => arr.find(p => p.cc === cc);

// ---------------------------------------------------------------------------
// Menu — opened by any face button or a both-hands pinch
// ---------------------------------------------------------------------------

export class MenuPanel extends Panel {
  constructor(onPick) {
    super({ w: 560, h: 700, scale: 0.40, title: 'bummyWAVES' });

    this.add(new Label(34, 82, 'OPEN A PANEL', { size: 14, color: THEME.dim }));

    const mk = (y, label, sub, accent, key) => {
      const b = this.add(new Button(34, y, 492, 78, {
        label, accent, bold: true, fontSize: 20, momentary: true, radius: 12,
        onChange: on => { if (on) onPick(key); },
      }));
      this.add(new Label(46, y + 82, sub, { size: 13, color: THEME.dim }));
      return b;
    };

    mk(116, 'WAAAVE POOL CONTROLS', 'nanoKONTROL2 surface — knobs, faders, buttons', THEME.hot, 'nano');
    mk(246, 'VIDEO PLAYER', 'browse the USB stick and feed the pool', THEME.cool, 'video');
    mk(376, 'OUTPUT MIRROR', 'see the projector feed here in the room', THEME.warn, 'mirror');
    mk(506, 'PLAYFIELD', 'grab the video and stretch it \u2014 warps the synth too', '#9d5cff', 'playfield');

    this.add(new Button(34, 606, 492, 56, {
      label: '\u2694  SPAWN BAT', accent: THEME.cool, bold: true, fontSize: 17,
      momentary: true, radius: 12,
      onChange: on => { if (on) onPick('bat'); },
    }));

    this.add(new Label(280, 668, 'drag the title bar to place a panel', {
      size: 12, color: THEME.dim, align: 'center',
    }));
    this.add(new Label(280, 394, 'any face button · both-hands pinch · toggles this menu', {
      size: 11, color: THEME.edge, align: 'center',
    }));
  }
}

// ---------------------------------------------------------------------------
// nanoKONTROL2 surface
// ---------------------------------------------------------------------------

export class NanoPanel extends Panel {
  constructor(net, onNav) {
    super({ w: 1180, h: 660, scale: 0.86, title: 'WAAAVE POOL — nanoKONTROL2' });
    this.net = net;
    this.bound = new Map();   // param id -> widget

    const cont = net.params?.continuous || [];
    const togs = net.params?.toggles || [];

    const COLS = 8;
    const x0 = 42, colW = 124, gap = 8;

    for (let i = 0; i < COLS; i++) {
      const cx = x0 + i * (colW + gap);

      const knobP = byCC(cont, 16 + i);
      const sliderP = byCC(cont, 120 + i);
      const sBtn = byCC(togs, 32 + i);
      const mBtn = byCC(togs, 48 + i);
      const rBtn = byCC(togs, 64 + i);

      // channel strip label
      this.add(new Label(cx + colW / 2, 74, String(i + 1), {
        size: 13, color: THEME.edge, align: 'center', weight: 700,
      }));

      if (knobP) {
        const k = this.add(new Knob(cx + colW / 2 - 34, 92, 68, 68, {
          label: knobP.label, accent: THEME.hot,
          value: net.values[knobP.id] ?? 0.5,
          onChange: v => net.set(knobP.id, v),
        }));
        this.bound.set(knobP.id, k);
      }

      // S / M / R button column
      const btnY = 186;
      [[sBtn, 'S'], [mBtn, 'M'], [rBtn, 'R']].forEach(([p, ch], row) => {
        if (!p) return;
        const b = this.add(new Button(cx + 8, btnY + row * 38, colW - 16, 30, {
          label: `${ch}  ${p.label}`, fontSize: 11, accent: THEME.warn,
          value: net.toggles[p.id] ? 1 : 0,
          onChange: on => net.toggle(p.id, on),
        }));
        this.bound.set(p.id, b);
      });

      if (sliderP) {
        const s = this.add(new Slider(cx + colW / 2 - 26, 320, 52, 230, {
          label: sliderP.label, accent: sliderP.group === 'warp' ? THEME.cool : '#7d76a0',
          value: net.values[sliderP.id] ?? 0.5,
          onChange: v => net.set(sliderP.id, v),
        }));
        this.bound.set(sliderP.id, s);
      }
    }

    // global switches along the bottom
    const globals = ['toroid', 'mirror', 'lumakey_invert', 'wet_dry', 'video_reactive', 'p_lock'];
    let gx = 42;
    for (const id of globals) {
      const p = togs.find(t => t.id === id);
      if (!p) continue;
      const w = 148;
      const b = this.add(new Button(gx, 598, w, 36, {
        label: p.label, fontSize: 12, accent: THEME.cool,
        value: net.toggles[p.id] ? 1 : 0,
        onChange: on => net.toggle(p.id, on),
      }));
      this.bound.set(p.id, b);
      gx += w + 8;
    }

    // RESET: back to the synth's baseline. Everything to 0, which is both
    // "off" and the value at which a soft-takeover control re-latches — so
    // after a reset every knob is immediately live again.
    this.add(new Button(1180 - 348, 598, 148, 36, {
      label: 'RESET', fontSize: 12, accent: THEME.warn, bold: true, momentary: true,
      onChange: on => { if (on) net.reset(); },
    }));

    net.on('reset', m => {
      for (const [id, v] of Object.entries(m.values || {})) this._sync(id, v);
      for (const [id, v] of Object.entries(m.toggle_values || {})) this._syncToggle(id, v);
      this.markDirty();
    });

    // jump straight to the video browser without going back to the menu
    if (onNav) {
      this.add(new Button(1180 - 190, 598, 148, 36, {
        label: 'VIDEO \u25B8', fontSize: 12, accent: THEME.hot, momentary: true,
        onChange: on => { if (on) onNav('video'); },
      }));
    }

    // keep the surface in step when another client (or a real nanoKONTROL
    // wired into the same virtual port) moves something
    net.on('val',  m => this._sync(m.p, m.v));
    net.on('vals', m => { for (const [id, v] of Object.entries(m.vals)) this._sync(id, v); });
    net.on('tog',  m => this._syncToggle(m.p, m.v));
  }

  _sync(id, v) {
    const w = this.bound.get(id);
    if (w && w.value !== v) { w.value = v; this.markDirty(); }
  }

  _syncToggle(id, on) {
    const w = this.bound.get(id);
    if (w) { w.value = on ? 1 : 0; this.markDirty(); }
  }
}

// ---------------------------------------------------------------------------
// Video player — r_e_c_u_r-style sample browser
// ---------------------------------------------------------------------------

export class VideoPanel extends Panel {
  constructor(net, onNav) {
    super({ w: 760, h: 620, scale: 0.55, title: 'VIDEO PLAYER' });
    this.net = net;

    this.status = this.add(new Label(28, 76, 'scanning…', { size: 14, color: THEME.dim }));

    this.list = this.add(new List(28, 104, 704, 384, {
      empty: 'no videos found — plug in a USB stick',
      onSelect: item => {
        this.status.text = `selected  ${item.name}`;
        this.markDirty();
        this._pick = item;
      },
    }));

    const by = 508;
    this.add(new Button(28, by, 220, 58, {
      label: '▶  PLAY', accent: THEME.cool, bold: true, fontSize: 18, momentary: true,
      onChange: on => {
        if (!on) return;
        if (!this._pick) { this.status.text = 'pick a file first'; this.markDirty(); return; }
        net.play(this._pick.path);
      },
    }));
    this.add(new Button(260, by, 160, 58, {
      label: '❚❚ PAUSE', accent: THEME.warn, fontSize: 16,
      onChange: on => net.pause(on),
    }));
    this.add(new Button(432, by, 140, 58, {
      label: '■ STOP', accent: THEME.hot, fontSize: 16, momentary: true,
      onChange: on => { if (on) net.stop(); },
    }));
    this.add(new Button(584, by, 148, 58, {
      label: '⟳ RESCAN', fontSize: 15, momentary: true,
      onChange: on => { if (on) { this.status.text = 'scanning…'; this.markDirty(); net.listFiles(); } },
    }));

    if (onNav) {
      this.add(new Button(28, 568, 200, 40, {
        label: '\u25C2 POOL CONTROLS', fontSize: 12, accent: THEME.hot, momentary: true,
        onChange: on => { if (on) onNav('nano'); },
      }));
    }

    net.on('files', files => {
      this.list.setItems(files);
      this.status.text = files.length
        ? `${files.length} file${files.length === 1 ? '' : 's'}`
        : 'no videos found';
      this.markDirty();
    });

    net.on('video', st => {
      if (st.detail && st.ok === false) this.status.text = st.detail;
      else if (st.playing) this.status.text = `playing  ${(st.current || '').split('/').pop()}`;
      else if (st.current) this.status.text = `stopped  ${(st.current || '').split('/').pop()}`;
      this.markDirty();
    });

    net.listFiles();
  }
}


// ---------------------------------------------------------------------------
// Output mirror — the projector feed, floating in the room
// ---------------------------------------------------------------------------

export class MirrorPanel extends Panel {
  constructor(net, onNav) {
    super({ w: 976, h: 620, scale: 1.05, title: 'OUTPUT MIRROR' });
    this.net = net;

    // MJPEG in an <img> keeps updating on its own; we just blit whatever the
    // element currently holds. Throttled to roughly the stream rate because a
    // 960x540 blit plus texture upload at headset framerate is pure waste.
    this.img = Feed.acquire(net);
    this.err = null;
    this._unsub = Feed.onChange(({ error }) => { this.err = error; this.markDirty(); });
    this._lastBlit = 0;
    this.blitInterval = 1000 / 18;

    this.add(new Button(28, 560, 180, 44, {
      label: '\u25A0 STOP', fontSize: 14, accent: THEME.hot, momentary: true,
      onChange: on => { if (on) this.stop(); },
    }));
    if (onNav) {
      this.add(new Button(976 - 208, 560, 180, 44, {
        label: '\u25C2 CONTROLS', fontSize: 13, accent: THEME.cool, momentary: true,
        onChange: on => { if (on) onNav('nano'); },
      }));
    }
  }

  stop() {
    Feed.release(this.net);
    this.markDirty();
  }

  update() {
    const now = performance.now();
    if (Feed.ready && now - this._lastBlit >= this.blitInterval) {
      this._lastBlit = now;
      this.dirty = true;
    }
    super.update();
  }

  draw(c) {
    super.draw(c);
    const x = 28, y = 74, w = this.cw - 56, h = 470;
    c.save();
    roundRect(c, x, y, w, h, 10);
    c.clip();
    c.fillStyle = '#05040a';
    c.fillRect(x, y, w, h);
    if (Feed.ready) {
      // letterbox rather than stretch — this is a monitor, it should be honest
      const ar = this.img.naturalWidth / this.img.naturalHeight;
      let dw = w, dh = w / ar;
      if (dh > h) { dh = h; dw = h * ar; }
      c.drawImage(this.img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      c.fillStyle = THEME.dim;
      c.font = '500 17px ui-monospace, monospace';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(this.err || 'connecting to the projector feed\u2026', x + w / 2, y + h / 2);
      c.textAlign = 'left';
    }
    c.restore();
  }

  dispose() {
    this._unsub?.();
    Feed.release(this.net);
    super.dispose();
  }
}
