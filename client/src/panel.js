/**
 * Floating UI panels.
 *
 * Each panel is a 2D canvas painted with widgets and mapped onto a quad. A
 * controller ray hits the quad, the UV becomes canvas pixels, and the pixel
 * picks the widget. This beats building 3D widgets: the nanoKONTROL surface is
 * a flat control panel in real life, so drawing it flat is both easier and
 * more faithful.
 */

import * as THREE from '../vendor/three.module.js';

export const THEME = {
  bg:      '#100d18',
  bgTop:   '#181327',
  edge:    '#2c2440',
  ink:     '#f2effa',
  dim:     '#8d86a8',
  hot:     '#ff2d7e',
  cool:    '#25e0d0',
  warn:    '#ffb020',
  track:   '#0a0810',
  ok:      '#25e0d0',
};

const TITLE_H = 54;   // canvas px — also the grab strip

export class Panel {
  /**
   * @param {object} opts
   * @param {number} opts.w  canvas width in px
   * @param {number} opts.h  canvas height in px
   * @param {number} opts.scale  metres per 1000 canvas px
   */
  constructor({ w = 1024, h = 640, scale = 0.62, title = 'PANEL' } = {}) {
    this.cw = w; this.ch = h; this.title = title;
    this.widgets = [];
    this.dirty = true;
    this.closed = false;

    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    const worldW = (w / 1000) * scale * 1000 / 1000;
    const aspect = h / w;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(worldW, worldW * aspect),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false })
    );
    this.mesh.userData.panel = this;
    this.worldW = worldW;
    this.worldH = worldW * aspect;

    // per-pointer drag state, keyed by controller index
    this._drag = new Map();
  }

  get object3D() { return this.mesh; }

  add(widget) {
    widget.panel = this;
    this.widgets.push(widget);
    return widget;
  }

  markDirty() { this.dirty = true; }

  /** UV (0..1, origin bottom-left) -> canvas px (origin top-left) */
  uvToPx(u, v) { return { x: u * this.cw, y: (1 - v) * this.ch }; }

  widgetAt(x, y) {
    // reverse order so the most recently added wins overlaps
    for (let i = this.widgets.length - 1; i >= 0; i--) {
      const w = this.widgets[i];
      if (w.enabled !== false && w.hit(x, y)) return w;
    }
    return null;
  }

  isTitleBar(y) { return y <= TITLE_H; }

  pointerDown(id, x, y) {
    const w = this.widgetAt(x, y);
    if (!w) return null;
    this._drag.set(id, { widget: w, x0: x, y0: y, v0: w.value });
    w.onDown?.(x, y);
    this.markDirty();
    return w;
  }

  pointerMove(id, x, y) {
    const d = this._drag.get(id);
    if (!d) return;
    d.widget.onDrag?.(x - d.x0, y - d.y0, d.v0, x, y);
    this.markDirty();
  }

  pointerUp(id, x, y) {
    const d = this._drag.get(id);
    if (!d) return;
    d.widget.onUp?.(x, y);
    this._drag.delete(id);
    this.markDirty();
  }

  /** Redraw only when something changed — these canvases are not cheap. */
  update() {
    if (!this.dirty) return;
    try {
      this.draw();
    } catch (e) {
      // One bad frame must never kill the XR animation loop — that reads to
      // the wearer as the whole app crashing.
      console.error('panel draw failed:', e);
      window.__bwReport?.('panel-draw', e);
      this.drawError(e);
    }
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  drawError(e) {
    const c = this.ctx;
    c.fillStyle = '#1a0d14';
    c.fillRect(0, 0, this.cw, this.ch);
    c.fillStyle = THEME.hot;
    c.font = '600 18px ui-monospace, monospace';
    c.fillText('panel error', 22, 40);
    c.fillStyle = THEME.dim;
    c.font = '400 14px ui-monospace, monospace';
    c.fillText(String(e && e.message || e).slice(0, 80), 22, 70);
  }

  draw() {
    const c = this.ctx, { cw, ch } = this;
    c.clearRect(0, 0, cw, ch);

    // body
    const g = c.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, THEME.bgTop);
    g.addColorStop(1, THEME.bg);
    roundRect(c, 0, 0, cw, ch, 22);
    c.fillStyle = g; c.fill();
    c.strokeStyle = THEME.edge; c.lineWidth = 3; c.stroke();

    // title bar / grab strip
    c.save();
    roundRect(c, 0, 0, cw, TITLE_H, 22);
    c.clip();
    c.fillStyle = '#1d1730';
    c.fillRect(0, 0, cw, TITLE_H);
    c.restore();
    c.fillStyle = THEME.dim;
    c.font = '600 21px ui-monospace, Menlo, monospace';
    c.textBaseline = 'middle';
    c.fillText(this.title, 22, TITLE_H / 2);

    // grab affordance
    c.fillStyle = THEME.edge;
    for (let i = 0; i < 3; i++) c.fillRect(cw - 74 + i * 14, TITLE_H / 2 - 7, 6, 14);

    for (const w of this.widgets) w.draw(c);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

class Widget {
  constructor(x, y, w, h, opts = {}) {
    Object.assign(this, { x, y, w, h }, opts);
    this.value = opts.value ?? 0;
  }
  hit(px, py) {
    return px >= this.x && px <= this.x + this.w && py >= this.y && py <= this.y + this.h;
  }
  draw() {}
}

/** Vertical fader. Drag up to raise; the nanoKONTROL sliders behave this way. */
export class Slider extends Widget {
  constructor(x, y, w, h, opts) { super(x, y, w, h, opts); }

  onDrag(dx, dy, v0) {
    const v = Math.max(0, Math.min(1, v0 - dy / this.h));
    if (v !== this.value) { this.value = v; this.onChange?.(v); }
  }

  draw(c) {
    const { x, y, w, h } = this;
    const trackW = 12, tx = x + w / 2 - trackW / 2;
    roundRect(c, tx, y, trackW, h, 6);
    c.fillStyle = THEME.track; c.fill();

    const fy = y + h * (1 - this.value);
    roundRect(c, tx, fy, trackW, y + h - fy, 6);
    c.fillStyle = this.accent || THEME.cool; c.fill();

    // cap
    const capH = 26;
    roundRect(c, x + 3, fy - capH / 2, w - 6, capH, 6);
    c.fillStyle = '#3a3252'; c.fill();
    c.strokeStyle = this.accent || THEME.cool; c.lineWidth = 2; c.stroke();

    if (this.label) {
      c.fillStyle = THEME.dim;
      c.font = '500 14px ui-monospace, monospace';
      c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText(this.label, x + w / 2, y + h + 8);
      c.textAlign = 'left';
    }
  }
}

/** Rotary. Vertical drag, same as every DAW. */
export class Knob extends Widget {
  onDrag(dx, dy, v0) {
    const v = Math.max(0, Math.min(1, v0 - dy / 160));
    if (v !== this.value) { this.value = v; this.onChange?.(v); }
  }

  draw(c) {
    const cx = this.x + this.w / 2, cy = this.y + this.h / 2;
    const r = Math.min(this.w, this.h) / 2 - 4;
    const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;
    const a = A0 + (A1 - A0) * this.value;

    c.lineCap = 'round';
    c.beginPath(); c.arc(cx, cy, r, A0, A1);
    c.strokeStyle = THEME.track; c.lineWidth = 7; c.stroke();

    c.beginPath(); c.arc(cx, cy, r, A0, a);
    c.strokeStyle = this.accent || THEME.hot; c.lineWidth = 7; c.stroke();

    c.beginPath(); c.arc(cx, cy, r - 9, 0, Math.PI * 2);
    c.fillStyle = '#241d38'; c.fill();

    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
    c.strokeStyle = THEME.ink; c.lineWidth = 3; c.stroke();
    c.lineCap = 'butt';

    if (this.label) {
      c.fillStyle = THEME.dim;
      c.font = '500 13px ui-monospace, monospace';
      c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText(this.label, cx, this.y + this.h + 4);
      c.textAlign = 'left';
    }
  }
}

export class Button extends Widget {
  onDown() {
    if (this.momentary) { this.value = 1; this.onChange?.(true); }
    else { this.value = this.value ? 0 : 1; this.onChange?.(!!this.value); }
  }
  onUp() {
    if (this.momentary) { this.value = 0; this.onChange?.(false); }
  }

  draw(c) {
    const on = !!this.value;
    roundRect(c, this.x, this.y, this.w, this.h, this.radius ?? 7);
    c.fillStyle = on ? (this.accent || THEME.hot) : '#211b33';
    c.fill();
    c.strokeStyle = on ? (this.accent || THEME.hot) : THEME.edge;
    c.lineWidth = 2; c.stroke();

    if (this.label) {
      c.fillStyle = on ? '#0a0710' : THEME.dim;
      c.font = `${this.bold ? '700' : '500'} ${this.fontSize || 14}px ui-monospace, monospace`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(this.label, this.x + this.w / 2, this.y + this.h / 2);
      c.textAlign = 'left';
    }
  }
}

export class Label extends Widget {
  constructor(x, y, text, opts = {}) { super(x, y, 0, 0, opts); this.text = text; }
  hit() { return false; }
  draw(c) {
    c.fillStyle = this.color || THEME.dim;
    c.font = `${this.weight || 500} ${this.size || 15}px ui-monospace, monospace`;
    c.textAlign = this.align || 'left'; c.textBaseline = 'top';
    c.fillText(this.text, this.x, this.y);
    c.textAlign = 'left';
  }
}

/** Scrolling list — the video browser. */
export class List extends Widget {
  constructor(x, y, w, h, opts = {}) {
    super(x, y, w, h, opts);
    this.items = opts.items || [];
    this.rowH = opts.rowH || 44;
    this.scroll = 0;
    this.selected = -1;
  }

  setItems(items) { this.items = items; this.scroll = 0; this.panel?.markDirty(); }
  get maxScroll() { return Math.max(0, this.items.length * this.rowH - this.h); }

  onDown(px, py) {
    this._downY = py;
    this._scroll0 = this.scroll;
    this._moved = 0;
  }

  onDrag(dx, dy) {
    this._moved = Math.max(this._moved, Math.abs(dy));
    this.scroll = Math.max(0, Math.min(this.maxScroll, this._scroll0 - dy));
  }

  onUp(px, py) {
    // a drag scrolls, a tap selects
    if (this._moved > 8) return;
    const idx = Math.floor((py - this.y + this.scroll) / this.rowH);
    if (idx >= 0 && idx < this.items.length) {
      this.selected = idx;
      this.onSelect?.(this.items[idx], idx);
    }
  }

  draw(c) {
    const { x, y, w, h } = this;
    c.save();
    roundRect(c, x, y, w, h, 10); c.fillStyle = THEME.track; c.fill(); c.clip();

    if (!this.items.length) {
      c.fillStyle = THEME.dim;
      c.font = '500 16px ui-monospace, monospace';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(this.empty || 'no files found', x + w / 2, y + h / 2);
      c.textAlign = 'left';
      c.restore();
      return;
    }

    const first = Math.max(0, Math.floor(this.scroll / this.rowH));
    const last = Math.min(this.items.length, first + Math.ceil(h / this.rowH) + 1);

    for (let i = first; i < last; i++) {
      const it = this.items[i];
      const ry = y + i * this.rowH - this.scroll;
      if (i === this.selected) {
        c.fillStyle = 'rgba(255,45,126,.18)';
        c.fillRect(x, ry, w, this.rowH);
        c.fillStyle = THEME.hot;
        c.fillRect(x, ry, 4, this.rowH);
      }
      c.fillStyle = i === this.selected ? THEME.ink : '#c9c2de';
      c.font = '500 16px ui-monospace, monospace';
      c.textBaseline = 'middle';
      c.fillText(truncate(c, it.name || String(it), w - 130), x + 16, ry + this.rowH / 2);

      if (it.size != null) {
        c.fillStyle = THEME.dim;
        c.font = '400 13px ui-monospace, monospace';
        c.textAlign = 'right';
        c.fillText(mb(it.size), x + w - 14, ry + this.rowH / 2);
        c.textAlign = 'left';
      }
      c.strokeStyle = 'rgba(255,255,255,.04)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x + 12, ry + this.rowH); c.lineTo(x + w - 12, ry + this.rowH); c.stroke();
    }
    c.restore();

    // scrollbar
    if (this.maxScroll > 0) {
      const th = Math.max(30, h * (h / (this.items.length * this.rowH)));
      const ty = y + (h - th) * (this.scroll / this.maxScroll);
      roundRect(c, x + w - 7, ty, 4, th, 2);
      c.fillStyle = THEME.edge; c.fill();
    }
  }
}

// ---------------------------------------------------------------------------

export function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function truncate(c, s, maxW) {
  if (c.measureText(s).width <= maxW) return s;
  while (s.length > 4 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

function mb(bytes) {
  const m = bytes / 1048576;
  return m >= 1024 ? `${(m / 1024).toFixed(1)}G` : `${m.toFixed(0)}M`;
}
