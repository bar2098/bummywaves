/**
 * One MJPEG connection, shared.
 *
 * The playfield and the mirror panel both want the projector feed. Opening a
 * stream each doubles the bandwidth and doubles the decode, on a headset that
 * is also rendering the scene — and it made the Pi hold two x11grab consumers
 * alive. One <img>, reference counted, is enough for any number of consumers.
 */

let img = null;
let refs = 0;
let ready = false;
let error = null;
const listeners = new Set();

function ensure() {
  if (img) return img;
  img = new Image();
  img.onload = () => {
    if (!ready) { ready = true; notify(); }
  };
  img.onerror = () => {
    ready = false;
    error = 'stream unavailable';
    notify();
  };
  return img;
}

function notify() {
  for (const fn of listeners) {
    try { fn({ ready, error }); } catch (e) { console.error('feed listener', e); }
  }
}

export const Feed = {
  /** Take a reference; the stream opens on the first one. */
  acquire(net) {
    ensure();
    refs++;
    if (refs === 1) {
      error = null;
      net?.send({ t: 'mirror', v: true });
      img.src = `/stream.mjpg?t=${Date.now()}`;
    }
    return img;
  },

  /** Drop a reference; the stream closes when the last consumer goes. */
  release(net) {
    refs = Math.max(0, refs - 1);
    if (refs === 0 && img) {
      img.src = '';
      ready = false;
      net?.send({ t: 'mirror', v: false });
    }
  },

  get image() { return img; },
  get ready() { return ready && !!img && img.naturalWidth > 0; },
  get error() { return error; },
  get refs() { return refs; },

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
