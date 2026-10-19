/**
 * The playfield — the synth's output on a mesh you can grab and deform.
 *
 * This is the Mario 64 face mechanic: pinch a point, pull, and the surface
 * follows with a falloff around your grip. Two things make it more than a toy:
 *
 *  1. The deformation is a real vertex displacement in a shader, so the image
 *     stretches rather than sliding.
 *  2. The net gesture is sent back down to the Pi as CC, so the *synth's*
 *     feedback field bends too — and the projector shows it. Without that the
 *     warp is a puppet show only the performer sees.
 *
 * See docs/ARCHITECTURE.md "Latency, and where the warp actually happens".
 */

import * as THREE from '../vendor/three.module.js';
import { Feed } from './feed.js';

const _sp = new THREE.Vector3();
const _b1 = new THREE.Vector3();
const _b2 = new THREE.Vector3();
const _b3 = new THREE.Vector3();
const _bm = new THREE.Matrix4();

const MAX_GRABS = 4;
const MAX_HITS = 6;

const VERT = /* glsl */`
  // Scan-processing displacement, after Andrei Jay's Spectral Mesh (which is
  // itself after Scanimate and Rutt-Etra): sample the video's luminance in the
  // VERTEX stage and push the vertex by it. Spectral Mesh displaces in X and Y
  // rather than Z, which gives an isometric shear instead of the familiar
  // heightfield — so that is what these do, with Z available as a third axis.
  //
  // This is why the surface writhes on its own: every vertex is being moved by
  // whatever the synth is painting at that point, before your hands touch it.
  uniform sampler2D uTex;
  uniform int   uHasTex;
  uniform float uLumaX;
  uniform float uLumaY;
  uniform float uLumaZ;
  uniform float uLumaGamma;

  // three independent LFOs, waveshape-selectable, with ring modulation
  uniform vec3  uLfoAmp;     // per axis
  uniform vec3  uLfoFreq;
  uniform float uLfoPhase;
  uniform int   uLfoShape;   // 0 sine 1 square 2 saw 3 noise
  uniform float uRingMod;

  uniform vec3  uGrabNow[${MAX_GRABS}];
  uniform vec3  uGrabFrom[${MAX_GRABS}];
  uniform float uGrabAmt[${MAX_GRABS}];
  uniform float uRadius;
  uniform float uTime;
  uniform float uWobble;

  // Bat strikes. Each is a damped radial wave expanding from the impact
  // point — a sustained grab pulls the surface, a hit rings it.
  uniform vec3  uHitPos[${MAX_HITS}];   // xy = where, z = amplitude
  uniform float uHitAge[${MAX_HITS}];   // seconds since impact, <0 = unused

  varying vec2  vUv;
  varying float vStretch;
  varying float vLuma;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

  float wave(float x, int shape){
    if (shape == 1) return sign(sin(x));
    if (shape == 2) return fract(x / 6.2831853) * 2.0 - 1.0;
    if (shape == 3) {
      float i = floor(x); float f = fract(x);
      return mix(hash(vec2(i, 1.0)), hash(vec2(i + 1.0, 1.0)), f * f * (3.0 - 2.0 * f)) * 2.0 - 1.0;
    }
    return sin(x);
  }

  void main() {
    vUv = uv;
    vec3 pos = position;
    float stretch = 0.0;

    // --- luma-driven scan displacement ------------------------------------
    float luma = 0.0;
    if (uHasTex == 1) {
      vec3 c = texture2D(uTex, uv).rgb;
      luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      luma = pow(clamp(luma, 0.0, 1.0), uLumaGamma);
      pos.x += (luma - 0.5) * uLumaX;
      pos.y += (luma - 0.5) * uLumaY;
      pos.z += (luma - 0.5) * uLumaZ;
    }
    vLuma = luma;

    // --- LFO ripple, ring-modulated against the luma ----------------------
    float t = uTime + uLfoPhase;
    float lx = wave(position.y * uLfoFreq.x + t * 1.7, uLfoShape);
    float ly = wave(position.x * uLfoFreq.y + t * 1.3, uLfoShape);
    float lz = wave((position.x + position.y) * uLfoFreq.z + t, uLfoShape);
    float ring = mix(1.0, (luma - 0.5) * 2.0, uRingMod);
    pos.x += lx * uLfoAmp.x * ring;
    pos.y += ly * uLfoAmp.y * ring;
    pos.z += lz * uLfoAmp.z * ring;

    // Each grab drags the surface toward it, weighted by a gaussian in the
    // vertex's *rest* position — so the falloff stays anchored to the material
    // rather than sliding with the deformation.
    for (int i = 0; i < ${MAX_GRABS}; i++) {
      float amt = uGrabAmt[i];
      if (amt <= 0.001) continue;
      vec3 delta = uGrabNow[i] - uGrabFrom[i];
      float d = distance(position.xy, uGrabFrom[i].xy);
      float w = exp(-(d * d) / (2.0 * uRadius * uRadius)) * amt;
      pos += delta * w;
      stretch += length(delta) * w;
    }

    for (int i = 0; i < ${MAX_HITS}; i++) {
      float age = uHitAge[i];
      if (age < 0.0) continue;
      float d = distance(position.xy, uHitPos[i].xy);
      float amp = uHitPos[i].z;
      // wavefront travels outward at ~1.6 m/s, rings at ~14Hz, decays in ~1.4s
      float front = d - age * 1.6;
      float ring  = sin(front * 26.0) * exp(-abs(front) * 5.0);
      float decay = exp(-age * 2.2);
      float w = ring * decay * amp;
      pos.z += w * 0.45;
      pos.xy += normalize(position.xy - uHitPos[i].xy + 1e-5) * w * 0.10;
      stretch += abs(w) * 0.8;
    }

    // idle breathing so the surface never looks like a dead quad
    pos.z += sin(position.x * 3.0 + uTime * 0.7) *
             cos(position.y * 4.0 - uTime * 0.5) * uWobble;

    vStretch = stretch;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uTex;
  uniform float uTime;
  uniform float uAberration;
  uniform float uScan;
  uniform float uFeedback;
  uniform float uOpacity;
  uniform int   uHasTex;

  varying vec2  vUv;
  varying float vStretch;
  varying float vLuma;

  void main() {
    // THREE.Texture defaults to flipY = true, which already orients an <img>
    // correctly against standard plane UVs — the extra 1.0-vUv.y I had here
    // flipped it a second time and stood the picture on its head.
    //
    // The mesh is DoubleSide so it stays visible if you spin it around, but
    // the back of a plane shows a mirror image; flipping x when we are not
    // front-facing keeps the video readable from either side.
    vec2 uv = vUv;
    if (!gl_FrontFacing) uv.x = 1.0 - uv.x;

    if (uHasTex == 0) {
      // placeholder while the stream connects — still reacts to your hands
      float g = 0.06 + 0.5 * vStretch;
      gl_FragColor = vec4(g * 1.2, g * 0.3, g * 1.6, uOpacity);
      return;
    }

    // Chromatic split scaled by how hard this part of the surface is being
    // pulled: the harder you stretch, the more the channels come apart. This
    // is the analogue-video idiom the pool itself trades in.
    float a = uAberration * (0.004 + vStretch * 0.10);
    vec2 dir = normalize(uv - 0.5 + 1e-5);
    float r = texture2D(uTex, uv - dir * a).r;
    float g = texture2D(uTex, uv).g;
    float b = texture2D(uTex, uv + dir * a).b;
    vec3 col = vec3(r, g, b);

    // scanline shimmer, drifting
    float scan = sin((uv.y + uTime * 0.05) * 900.0) * 0.5 + 0.5;
    col *= 1.0 - uScan * 0.18 * scan;

    // stretched regions bloom hot, like a CRT being overdriven
    col += vec3(0.9, 0.25, 0.6) * vStretch * uFeedback;

    gl_FragColor = vec4(col, uOpacity);
  }
`;

export class Playfield {
  /**
   * @param {Net} net        bridge connection — receives the warp as CC
   * @param {object} opts
   */
  constructor(net, { width = 1.6, height = 0.9, segments = 64 } = {}) {
    this.net = net;
    this.w = width;
    this.h = height;
    this.sendToSynth = true;

    // MJPEG straight into a texture. No canvas in between: this is a plain
    // image element that keeps repainting itself, so the GPU upload is the
    // only per-frame cost.
    this.img = Feed.acquire(net);
    this.hasTex = false;

    this.texture = new THREE.Texture(this.img);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.uniforms = {
      uTex:        { value: this.texture },
      uHasTex:     { value: 0 },
      uTime:       { value: 0 },
      uRadius:     { value: 0.30 },
      uWobble:     { value: 0.004 },
      uAberration: { value: 1.0 },
      uScan:       { value: 0.55 },
      uFeedback:   { value: 0.65 },
      uOpacity:    { value: 1.0 },
      uLumaX:      { value: 0.0 },
      uLumaY:      { value: 0.0 },
      uLumaZ:      { value: 0.16 },
      uLumaGamma:  { value: 1.0 },
      uLfoAmp:     { value: new THREE.Vector3(0, 0, 0.02) },
      uLfoFreq:    { value: new THREE.Vector3(9, 7, 5) },
      uLfoPhase:   { value: 0 },
      uLfoShape:   { value: 0 },
      uRingMod:    { value: 0.0 },
      uGrabNow:    { value: Array.from({ length: MAX_GRABS }, () => new THREE.Vector3()) },
      uGrabFrom:   { value: Array.from({ length: MAX_GRABS }, () => new THREE.Vector3()) },
      uGrabAmt:    { value: new Array(MAX_GRABS).fill(0) },
      uHitPos:     { value: Array.from({ length: MAX_HITS }, () => new THREE.Vector3()) },
      uHitAge:     { value: new Array(MAX_HITS).fill(-1) },
    };

    const geo = new THREE.PlaneGeometry(width, height,
                                        segments, Math.round(segments * height / width));
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      side: THREE.DoubleSide,
    }));
    this.mesh.userData.playfield = this;

    // A visible frame, so "grab the edge to move it" is discoverable rather
    // than folklore. Slightly proud of the surface so it reads as a handle.
    const fw = width * 1.04, fh = height * 1.07;
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(fw, fh)),
      new THREE.LineBasicMaterial({ color: 0x25e0d0, transparent: true, opacity: 0.5 })
    );
    frame.position.z = 0.002;
    this.mesh.add(frame);
    this.frame = frame;

    // Move handle, top right — the same idea as a panel's title bar. Fist-carry
    // used to do this job, but a fist is also how you punch the surface, so the
    // two gestures fought each other constantly.
    this.handleW = Math.min(0.26, width * 0.17);
    this.handleH = this.handleW * 0.42;
    const hx = width * 0.5 - this.handleW * 0.5;
    const hy = height * 0.5 + this.handleH * 0.62;
    const handle = new THREE.Mesh(
      new THREE.PlaneGeometry(this.handleW, this.handleH),
      new THREE.MeshBasicMaterial({ color: 0x25e0d0, transparent: true, opacity: 0.85 })
    );
    handle.position.set(hx, hy, 0.003);
    handle.userData.playfieldHandle = this;
    this.mesh.add(handle);
    this.handle = handle;
    this.handleCenter = new THREE.Vector2(hx, hy);

    // one slot per pointer, released slots decay back to rest
    this.grabs = new Map();
    this._tmp = new THREE.Vector3();
    this.start();
  }

  get object3D() { return this.mesh; }

  start() {
    this.primeSynth();
  }

  /**
   * Close the feedback loop so the warp is actually visible.
   *
   * fbXDisplace/Y have a range of 0..0.01 (c_x = c_y = .01 in ofApp.cpp) —
   * they nudge a *feedback field*, and tiny nudges compound over iterations.
   * But d_mix = jm + c_mix*p_lock[1] with jm = 0, and lumakey likewise: with
   * everything at 0 nothing recirculates, so displacing it does nothing at
   * all. Grabbing felt dead for exactly this reason.
   *
   * These are a live-but-tame starting point, not an opinion about taste —
   * every one is still a fader you can move afterwards.
   */
  primeSynth() {
    if (!this.net?.params) return;
    const base = {
      fb_mix:        0.62,   // feedback actually mixed back in
      lumakey:       0.34,   // something for the key to bite on
      tfilter_mix:   0.45,
      tfilter_res:   0.38,
      fb_bright:     0.55,
      fb_saturation: 0.60,
      fb_hue:        0.50,
      fb_x_displace: 0.50,   // centred — grabs move away from here
      fb_y_displace: 0.50,
      fb_z_displace: 0.50,
      fb_rotate:     0.50,
    };
    this.baseline = { ...base, huex_off: 0.0, frame_delay: 0.0 };
    for (const [id, v] of Object.entries(base)) this.net.set(id, v);
    this.net.flush();
  }

  /**
   * A strike has to be *seen on the projector*, not just felt in the headset.
   *
   * fb_z_displace was the wrong target: c_z is .05, a 5% zoom, invisible. The
   * parameters with real range are lumakey (c = 1.01), fb_mix (c = 2),
   * fb_rotate (c = .314) and frame_delay, which jumps the feedback buffer and
   * reads as a hard glitch. Punch those as a transient and decay back to the
   * baseline, so a hit lurches the image and then settles.
   */
  _applyHitEnvelope(dt) {
    if (!this._hitEnv || this._hitEnv <= 0 || !this.baseline || !this.net?.params) return;
    this._hitEnv = Math.max(0, this._hitEnv - dt / 0.55);
    const e = this._hitEnv * this._hitEnv;          // sharp attack, soft tail
    const g = e * Math.min(1, (this._lastHitAmp || 0.2) / 0.42);
    const b = this.baseline;
    const c = v => Math.max(0, Math.min(1, v));
    this.net.set('frame_delay', c(b.frame_delay + g * 0.85));
    this.net.set('lumakey',     c(b.lumakey     + g * 0.42));
    this.net.set('fb_mix',      c(b.fb_mix      + g * 0.33));
    this.net.set('fb_rotate',   c(b.fb_rotate   + g * 0.40));
    this.net.set('huex_off',    c(b.huex_off    + g * 0.70));
    this.net.set('tfilter_res', c(b.tfilter_res + g * 0.45));

    // and punch the warp stage: a dent at the impact point that springs out,
    // with a twist kick, so a strike deforms the actual picture
    const ring = Math.sin(this._hitEnv * Math.PI * 2.0) * e;
    this.net.set('warp_center_x', this._hitU ?? 0.5);
    this.net.set('warp_center_y', this._hitV ?? 0.5);
    this.net.set('warp_amount',   c(g * 1.2));
    this.net.set('warp_bulge',    c(0.5 - ring * 0.55));
    this.net.set('warp_twist',    c(0.5 + ring * 0.30));

    if (this._hitEnv === 0) {
      for (const [id, v] of Object.entries(b)) this.net.set(id, v);
      this.net.set('warp_amount', 0);
      this.net.set('warp_bulge', 0.5);
      this.net.set('warp_twist', 0.5);
    }
  }

  /** World point -> local mesh space, for grab bookkeeping. */
  toLocal(worldPoint) {
    return this.mesh.worldToLocal(this._tmp.copy(worldPoint)).clone();
  }

  /**
   * Is this point on the outer frame rather than the image?
   * The frame moves the whole surface; the interior deforms it.
   */
  /** Is this world point on the move handle? */
  isHandle(worldPoint) {
    const l = this.toLocal(worldPoint);
    return Math.abs(l.z) < 0.10 &&
           Math.abs(l.x - this.handleCenter.x) < this.handleW * 0.8 &&
           Math.abs(l.y - this.handleCenter.y) < this.handleH * 1.4;
  }

  isBorder(worldPoint) {
    const l = this.toLocal(worldPoint);
    return Math.abs(l.x) > this.w * 0.40 || Math.abs(l.y) > this.h * 0.36;
  }

  /** Is this world point close enough to the surface to grab it? */
  nearSurface(worldPoint, reach = 0.09) {
    const l = this.toLocal(worldPoint);
    return Math.abs(l.z) < reach &&
           Math.abs(l.x) < this.w * 0.55 &&
           Math.abs(l.y) < this.h * 0.55;
  }

  beginGrab(id, worldPoint) {
    if (this.grabs.size >= MAX_GRABS) return false;
    const local = this.toLocal(worldPoint);
    let slot = 0;
    const used = new Set([...this.grabs.values()].map(g => g.slot));
    while (used.has(slot)) slot++;
    if (slot >= MAX_GRABS) return false;
    this.grabs.set(id, {
      slot, from: local.clone(), now: local.clone(), amt: 1,
      handVel: new THREE.Vector3(), vel: new THREE.Vector3(),
    });
    return true;
  }

  moveGrab(id, worldPoint) {
    const g = this.grabs.get(id);
    if (!g) return;
    const next = this.toLocal(worldPoint);
    // remember how fast the hand was moving so a flick releases with real
    // momentum rather than every release looking the same
    g.handVel.copy(next).sub(g.now);
    g.now.copy(next);
  }

  endGrab(id) {
    const g = this.grabs.get(id);
    if (!g) return;
    g.releasing = true;
    // launch the spring with whatever speed the hand had — a slow release
    // settles gently, a flick overshoots and rings
    g.vel.copy(g.handVel).multiplyScalar(52);
  }

  /**
   * Register a bat strike at a world point.
   * @param {number} speed  tip speed in m/s — sets how hard it rings
   */
  hit(worldPoint, speed = 1) {
    const l = this.toLocal(worldPoint);
    if (Math.abs(l.x) > this.w * 0.6 || Math.abs(l.y) > this.h * 0.6) return false;
    const ages = this.uniforms.uHitAge.value;
    let slot = ages.findIndex(a => a < 0);
    if (slot < 0) {                       // all busy — recycle the oldest
      slot = ages.indexOf(Math.max(...ages));
    }
    const amp = Math.min(0.42, 0.06 + speed * 0.10);
    this.uniforms.uHitPos.value[slot].set(l.x, l.y, amp);
    ages[slot] = 0;
    // remember where it landed, in frame coords, so the warp can dent the
    // projected image at exactly the point you struck
    this._hitU = Math.max(0, Math.min(1, l.x / this.w + 0.5));
    this._hitV = Math.max(0, Math.min(1, 1 - (l.y / this.h + 0.5)));
    this._lastHitAmp = amp;
    this._hitEnv = 1;
    return true;
  }

  /** Aggregate the live grabs into synth parameters and push them down. */
  _pushToSynth() {
    if (!this.sendToSynth || !this.net?.params) return;
    if (this._hitEnv > 0.05) return;   // let a strike ring out uncontested
    let dx = 0, dy = 0, dz = 0, n = 0;
    for (const g of this.grabs.values()) {
      dx += g.now.x - g.from.x;
      dy += g.now.y - g.from.y;
      dz += g.now.z - g.from.z;
      n++;
    }
    if (!n) return;
    dx /= n; dy /= n; dz /= n;

    // Bipolar around 0.5, scaled so a comfortable arm movement covers the
    // range. These land on CC 120-123, which are already wired to the
    // fbXDisplace / fbYDisplace / fbZDisplace uniforms in ofApp.cpp.
    const k = 1.9;
    this.net.set('fb_x_displace', 0.5 + dx * k);
    this.net.set('fb_y_displace', 0.5 + dy * k);
    this.net.set('fb_z_displace', 0.5 + dz * k * 1.5);

    // c_rotate is .314 against c_x/c_y of .01, so rotation is by far the most
    // visible thing a hand can drive — lean on it. Vertical drag twists.
    this.net.set('fb_rotate', Math.max(0, Math.min(1, 0.5 + dy * 1.2)));
    // and let a hard pull open up the hue chaos, which is very legible
    const pull = Math.min(1, Math.hypot(dx, dy) * 2.2);
    this.net.set('huex_off', Math.max(0, Math.min(1, pull)));

    this._pushWarp();

    // two hands twisting = rotation
    const two = [...this.grabs.values()].filter(g => !g.releasing);
    if (two.length >= 2) {
      const a = two[0], b = two[1];
      const a0 = Math.atan2(b.from.y - a.from.y, b.from.x - a.from.x);
      const a1 = Math.atan2(b.now.y - a.now.y, b.now.x - a.now.x);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.net.set('fb_rotate', 0.5 + (d / Math.PI) * 0.5);
    }
  }

  /**
   * Drive the bummyWAVES warp stage (CC 80-86, added by scripts/patch_warp.py).
   *
   * This is the one that actually moves the picture. The stock displacement
   * params set a drift *rate* on the feedback coordinate, so no amount of
   * scaling makes them track a hand; this warp is applied to the sampling
   * coordinate itself, before anything reads it, with a range picked to be
   * seen rather than inherited from c_x = .01.
   */
  _pushWarp() {
    // Include RELEASING grabs. The spring is what makes a release feel like
    // elastic rather than a switch, and if the warp is cut the instant you let
    // go, the headset wobbles while the projector — the thing the audience is
    // watching — just snaps flat. Driving the warp from the spring means the
    // projected image overshoots and rings its way back too.
    const live = [...this.grabs.values()];
    const c = v => Math.max(0, Math.min(1, v));

    if (!live.length) {
      if (this._warpWasOn) {
        this.net.set('warp_amount', 0);
        this._warpWasOn = false;
      }
      return;
    }
    this._warpWasOn = true;

    // centre on the first grab, in 0..1 frame coords
    const g = live[0];
    const u = g.from.x / this.w + 0.5;
    const v = g.from.y / this.h + 0.5;

    const px = (g.now.x - g.from.x) / this.w;
    const py = (g.now.y - g.from.y) / this.h;
    const pz = (g.now.z - g.from.z);

    this.net.set('warp_center_x', c(u));
    this.net.set('warp_center_y', c(1 - v));            // GL samples y-up
    // fade with the grab's own influence so a settling spring eases the warp
    // out rather than dropping it
    const inf = g.amt ?? 1;
    this.net.set('warp_pull_x',   c(0.5 + px * 1.15 * inf));
    this.net.set('warp_pull_y',   c(0.5 - py * 1.15 * inf));
    this.net.set('warp_amount',   c((0.45 + Math.hypot(px, py) * 2.0) * inf));
    this.net.set('warp_bulge',    c(0.5 + pz * 2.2 * inf));

    // two hands twisting -> swirl about the grab point
    if (live.length >= 2) {
      const a = live[0], b = live[1];
      const a0 = Math.atan2(b.from.y - a.from.y, b.from.x - a.from.x);
      const a1 = Math.atan2(b.now.y - a.now.y, b.now.x - a.now.x);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.net.set('warp_twist', c(0.5 + (d / Math.PI) * 0.6));
    }
  }

  update(dt, elapsed) {
    this.uniforms.uTime.value = elapsed;
    this.hasTex = Feed.ready;
    this.uniforms.uHasTex.value = this.hasTex ? 1 : 0;
    if (this.hasTex) this.texture.needsUpdate = true;

    const ages = this.uniforms.uHitAge.value;
    for (let i = 0; i < MAX_HITS; i++) {
      if (ages[i] >= 0) {
        ages[i] += dt;
        if (ages[i] > 2.0) ages[i] = -1;   // rung out
      }
    }

    if (this.sendToSynth) this._applyHitEnvelope(dt);

    const amts = this.uniforms.uGrabAmt.value;
    for (let i = 0; i < MAX_GRABS; i++) amts[i] = 0;

    for (const [id, g] of [...this.grabs]) {
      if (g.releasing) {
        // Damped spring back to rest, deliberately underdamped so it
        // overshoots and wobbles. A linear fade just drooped home, which is
        // the least satisfying way for elastic material to behave.
        const K = 118;    // stiffness
        const D = 6.5;    // damping — below critical, so it rings
        _sp.copy(g.now).sub(g.from);
        g.vel.addScaledVector(_sp, -K * dt).addScaledVector(g.vel, -D * dt);
        g.now.addScaledVector(g.vel, dt);

        // done when it has both settled and stopped moving
        if (_sp.lengthSq() < 1e-6 && g.vel.lengthSq() < 1e-5) {
          this.grabs.delete(id);
          continue;
        }
        // fade influence out over a couple of seconds as a backstop
        g.amt = Math.max(0, g.amt - dt * 0.45);
        if (g.amt <= 0) { this.grabs.delete(id); continue; }
      }
      amts[g.slot] = g.amt;
      this.uniforms.uGrabFrom.value[g.slot].copy(g.from);
      this.uniforms.uGrabNow.value[g.slot].copy(g.now);
    }

    this._pushToSynth();
  }

  setEffect(name, v) {
    const u = this.uniforms['u' + name[0].toUpperCase() + name.slice(1)];
    if (u) u.value = v;
  }

  dispose() {
    Feed.release(this.net);
    if (this.frame) { this.frame.geometry.dispose(); this.frame.material.dispose(); }
    if (this.handle) { this.handle.geometry.dispose(); this.handle.material.dispose(); }
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * A bat you can swing at the playfield.
 *
 * Grabbing pulls the surface; hitting it rings. The distinction matters —
 * a sustained pull is a parameter change, a strike is an impulse, and jello
 * only reads as jello when the impact propagates as a wave rather than a dent.
 */
export class Bat {
  constructor() {
    const g = new THREE.Group();

    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.024, 0.30, 12),
      new THREE.MeshBasicMaterial({ color: 0x2a2340 })
    );
    handle.position.y = -0.15;

    const head = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.042, 0.34, 16),
      new THREE.MeshBasicMaterial({ color: 0xff2d7e })
    );
    head.position.y = 0.17;

    const band = new THREE.Mesh(
      new THREE.TorusGeometry(0.052, 0.006, 8, 20),
      new THREE.MeshBasicMaterial({ color: 0x25e0d0 })
    );
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.05;

    g.add(handle, head, band);
    // held pointing forward out of the fist, not straight up
    g.rotation.x = -Math.PI / 2.6;

    this.group = g;
    this.tipLocal = new THREE.Vector3(0, 0.34, 0);
    this.tipWorld = new THREE.Vector3();
    this.prevTip = new THREE.Vector3();
    this.speed = 0;
    this.prevSide = 0;
    this.attachedTo = null;
    this._first = true;
  }

  /**
   * Live in the scene and follow a pose, rather than being parented.
   *
   * Parenting to the controller object put the bat at the *target ray* origin,
   * which for a tracked hand sits out past the index finger — so it sprouted
   * from the wrong place and pointed the wrong way. Following the palm each
   * frame puts it in the fist regardless of hands or controllers.
   */
  attach(scene, pointer) {
    scene.add(this.group);
    this.scene = scene;
    this.pointer = pointer;
    this.attachedTo = pointer;
    this._first = true;
  }

  detach() {
    if (this.scene) this.scene.remove(this.group);
    this.scene = null;
    this.pointer = null;
    this.attachedTo = null;
  }

  get attached() { return !!this.attachedTo; }

  /** Place the bat in the hand: position at the palm, aligned wrist->knuckles. */
  followPose() {
    const p = this.pointer;
    if (!p) return;
    const j = p.hand?.joints;
    const palm = j?.['middle-finger-metacarpal'];
    const wrist = j?.['wrist'];

    if (palm && palm.visible !== false && wrist && wrist.visible !== false) {
      // Build the orientation from joint POSITIONS rather than a joint's own
      // quaternion. Joint-space axis conventions are easy to get backwards —
      // the head was ending up pointing sideways out of the fist — whereas
      // wrist->knuckles is unambiguously "along the hand", and the knuckle
      // span gives the across-palm axis. The bat's geometry runs along +Y, so
      // +Y is mapped to the distal direction.
      const idx = j['index-finger-metacarpal'];
      const pky = j['pinky-finger-metacarpal'];

      palm.getWorldPosition(this.group.position);

      const fwd = _b1.copy(palm.position).sub(wrist.position).normalize();
      let across;
      if (idx && pky) {
        across = _b2.copy(idx.position).sub(pky.position).normalize();
      } else {
        across = _b2.set(1, 0, 0);
      }
      const up = _b3.crossVectors(across, fwd).normalize();      // palm normal
      across.crossVectors(fwd, up).normalize();                  // re-orthogonalise

      // basis columns are the world axes for local X, Y, Z
      _bm.makeBasis(across, fwd, up);
      this.group.quaternion.setFromRotationMatrix(_bm);
      // account for the hand pose being expressed in the reference space
      if (this.group.parent) {
        this.group.parent.updateMatrixWorld();
      }
    } else {
      // controller: use the grip pose if we have one, else the ray origin
      const src = p.grip || p.controller;
      src.updateMatrixWorld();
      this.group.position.setFromMatrixPosition(src.matrixWorld);
      this.group.quaternion.setFromRotationMatrix(src.matrixWorld);
    }
    this.group.updateMatrixWorld(true);
  }

  update(dt) {
    if (!this.attachedTo) return;
    this.followPose();
    this.prevTip.copy(this.tipWorld);
    this.group.updateMatrixWorld();
    this.tipWorld.copy(this.tipLocal).applyMatrix4(this.group.matrixWorld);
    if (this._first) { this.prevTip.copy(this.tipWorld); this._first = false; }
    this.speed = dt > 0 ? this.prevTip.distanceTo(this.tipWorld) / dt : 0;
  }

  /**
   * Did the tip pass through the surface since last frame?
   * Sign change on the local z axis is the crossing test.
   */
  checkStrike(playfield) {
    if (!this.attachedTo) return null;
    const l = playfield.toLocal(this.tipWorld);
    const side = Math.sign(l.z);
    const crossed = this.prevSide !== 0 && side !== 0 && side !== this.prevSide;
    this.prevSide = side;
    const withinFace = Math.abs(l.x) < playfield.w * 0.6 &&
                       Math.abs(l.y) < playfield.h * 0.6;
    // a slow drift through the plane isn't a hit
    if (crossed && withinFace && this.speed > 0.35) {
      return { point: this.tipWorld.clone(), speed: this.speed };
    }
    return null;
  }

  dispose() {
    this.detach();
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
