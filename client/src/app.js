/**
 * XR session: passthrough, controllers, hands, and grabbable panels.
 *
 * Quest reserves the physical Menu button for Horizon OS — WebXR never receives
 * it — so the menu is bound to Y on the left controller, with a both-hands
 * pinch as the hand-tracking equivalent.
 */

import * as THREE from '../vendor/three.module.js';
import { MenuPanel, NanoPanel, VideoPanel, MirrorPanel } from './panels.js';
import { Playfield, Bat } from './stretch.js';

let renderer, scene, camera, session, net;
const panels = new Set();
const pointers = [];
let menuPanel = null;
let playfield = null;
let bat = null;
let _lastT = 0;

// Near-field (poke) interaction. A fingertip counts as touching a panel when
// it is within POKE_REACH of the plane and inside its bounds; the press fires
// as it crosses PRESS_DEPTH going in, with RELEASE_DEPTH giving hysteresis so
// a resting finger doesn't chatter.
const POKE_REACH = 0.06;
const PRESS_DEPTH = 0.012;
const RELEASE_DEPTH = 0.028;

const HAND_MAT = new THREE.MeshBasicMaterial({ color: 0xf2effa });
const HAND_TIP_MAT = new THREE.MeshBasicMaterial({ color: 0xff2d7e });

const _v = new THREE.Vector3();
const _local = new THREE.Vector3();

export async function start({ net: n, preferAR = true }) {
  net = n;
  installErrorReporting(net);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.setClearAlpha(0);          // let passthrough show through
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'position:fixed;inset:0;z-index:-1';

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.6));

  const mode = preferAR ? 'immersive-ar' : 'immersive-vr';
  session = await navigator.xr.requestSession(mode, {
    optionalFeatures: ['hand-tracking', 'local-floor', 'bounded-floor', 'anchors', 'plane-detection', 'layers'],
  });
  await renderer.xr.setSession(session);

  console.log('session features:', [...(session.enabledFeatures || ['(not reported)'])]);

  // In VR fallback there is no passthrough, so give the eye something to rest on
  if (mode === 'immersive-vr') scene.background = new THREE.Color(0x07060b);

  setupInputs();
  session.addEventListener('end', teardown);
  window.addEventListener('resize', onResize);

  renderer.setAnimationLoop(tick);
  openMenu();
  return session;
}

/**
 * Forward client errors to the Pi.
 *
 * There is no console inside a headset. Without this, a crash is reported as
 * "it crashed" and diagnosis is guesswork — with it, the stack lands in
 * `journalctl -u bummywaaave`.
 */
function installErrorReporting(net) {
  if (window.__bwReport) return;
  const send = (tag, err) => {
    try {
      net.send({
        t: 'clienterr', tag,
        msg: String(err && err.message || err),
        stack: String(err && err.stack || '').slice(0, 1200),
      });
    } catch { /* reporting must never throw */ }
  };
  window.__bwReport = send;
  window.addEventListener('error', e => send('window', e.error || e.message));
  window.addEventListener('unhandledrejection', e => send('promise', e.reason));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function setupInputs() {
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    scene.add(controller);

    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 })
    );
    ray.scale.z = 2;
    controller.add(ray);

    const grip = renderer.xr.getControllerGrip(i);
    scene.add(grip);

    const hand = renderer.xr.getHand(i);
    scene.add(hand);

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.008, 12, 12),
      new THREE.MeshBasicMaterial({ color: i ? 0x25e0d0 : 0xff2d7e })
    );
    dot.visible = false;
    scene.add(dot);

    const p = {
      index: i, controller, grip, hand, ray, dot,
      raycaster: new THREE.Raycaster(),
      active: false,          // trigger / pinch held
      gripping: false,
      grabbed: null,
      grabOffset: new THREE.Matrix4(),
      hoverPanel: null,
      pinching: false,
      prevY: false,
    };
    pointers.push(p);

    controller.addEventListener('selectstart', () => onSelectStart(p));
    controller.addEventListener('selectend',   () => onSelectEnd(p));
    controller.addEventListener('squeezestart', () => onSqueezeStart(p));
    controller.addEventListener('squeezeend',   () => onSqueezeEnd(p));

    // three.js already does pinch detection with hysteresis (0.02m ± 0.005),
    // so use its events rather than re-deriving them from joint positions.
    hand.addEventListener('pinchstart', () => { p.pinching = true; onSelectStart(p); });
    hand.addEventListener('pinchend',   () => { p.pinching = false; onSelectEnd(p); });
  }
}

/**
 * Any face button on any controller opens the menu — X/Y on the left, A/B on
 * the right (indices 4 and 5 in the xr-standard mapping). Deliberately not
 * fussy about handedness: with one dead controller you still need a way in,
 * and Horizon OS reserves the real Menu button so it never reaches WebXR.
 *
 * Edge state is keyed by handedness rather than controller index, because
 * index depends on connection order — with a single controller paired it is 0
 * whichever hand it belongs to.
 */
const _btnPrev = new Map();

function pollButtons() {
  for (const src of session.inputSources) {
    if (!src.gamepad || src.targetRayMode !== 'tracked-pointer') continue;
    const key = src.handedness || 'none';
    const pressed = !!(src.gamepad.buttons[4]?.pressed || src.gamepad.buttons[5]?.pressed);
    if (pressed && !_btnPrev.get(key)) toggleMenu();
    _btnPrev.set(key, pressed);
  }
}

/**
 * Draw the tracked hand as geometry.
 *
 * Passthrough is composited *under* every WebXR layer, so a real hand held in
 * front of an opaque panel is still hidden by it — the panel has no idea the
 * hand is closer. Rendering a sphere per joint puts something in the depth
 * buffer at the hand's actual position, so it occludes panels correctly and
 * the hand reads as being in the room rather than behind the UI.
 */
function ensureHandMeshes(p) {
  const joints = p.hand?.joints;
  if (!joints) return;
  if (!p.handMeshes) p.handMeshes = new Map();
  for (const name of Object.keys(joints)) {
    if (p.handMeshes.has(name)) continue;
    const joint = joints[name];
    if (!joint) continue;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 10, 8),
      name.endsWith('-tip') ? HAND_TIP_MAT : HAND_MAT
    );
    // jointRadius arrives with the pose; fall back to something sane
    mesh.scale.setScalar(joint.jointRadius || 0.008);
    joint.add(mesh);
    p.handMeshes.set(name, mesh);
  }
}

/**
 * Closed fist?
 *
 * Fingertips curled in toward the palm. three.js puts every joint's position
 * in the same reference space, so plain distances between them are valid —
 * this is the same basis its own pinch test uses. Hysteresis on the way out so
 * a fist doesn't flicker open mid-drag.
 */
function updateFist(p) {
  const j = p.hand?.joints;
  const palm = j?.['middle-finger-metacarpal'];
  if (!palm || palm.visible === false) { p.fist = false; return false; }

  // A pinch curls middle, ring and pinky while the index reaches for the
  // thumb. Counting "3 or more curled" therefore classified every pinch as a
  // fist, which stole the stretch gesture and made the playfield get carried
  // instead of deformed. A fist requires ALL FOUR curled — index included —
  // and is never a fist while three.js reports an active pinch.
  const tips = ['index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];
  const near = p.fist ? 0.075 : 0.058;
  let curled = 0;
  for (const name of tips) {
    const tip = j[name];
    if (tip && tip.position.distanceTo(palm.position) < near) curled++;
  }
  p.fist = !p.hand?.inputState?.pinching && curled >= 4;
  return p.fist;
}

/** Palm centre in world space — the anchor for fist drags and punches. */
function palmWorld(p, out) {
  const palm = p.hand?.joints?.['middle-finger-metacarpal'];
  if (palm && palm.visible !== false) return palm.getWorldPosition(out);
  return out.setFromMatrixPosition(p.controller.matrixWorld);
}

/** Nearest panel the index fingertip is touching, in panel pixel coords. */
function pokeHit(p) {
  const tip = p.hand?.joints?.['index-finger-tip'];
  if (!tip || tip.visible === false) return null;
  tip.getWorldPosition(_v);

  let best = null;
  for (const panel of panels) {
    _local.copy(_v);
    panel.mesh.worldToLocal(_local);
    if (Math.abs(_local.z) > POKE_REACH) continue;
    const u = _local.x / panel.worldW + 0.5;
    const v = _local.y / panel.worldH + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    if (!best || Math.abs(_local.z) < Math.abs(best.z)) {
      const px = panel.uvToPx(u, v);
      best = { panel, x: px.x, y: px.y, z: _local.z };
    }
  }
  return best;
}

function onSelectStart(p) { p.active = true; }

function onSelectEnd(p) {
  p.active = false;
  if (p.hoverPanel) {
    const hit = p.lastHit;
    if (hit) p.hoverPanel.pointerUp(p.index, hit.x, hit.y);
  }
  p.downPanel = null;
  // a title-bar drag ends when the trigger/pinch is released
  if (p.grabViaSelect) { p.grabbed = null; p.grabViaSelect = false; }
}

/** Latch a panel to a pointer so it rides along until released. */
function startGrab(p, panel, viaSelect) {
  p.grabbed = panel;
  p.grabViaSelect = !!viaSelect;
  panel.mesh.updateMatrixWorld();
  p.controller.updateMatrixWorld();
  p.grabOffset.copy(p.controller.matrixWorld).invert().multiply(panel.mesh.matrixWorld);
}

function onSqueezeStart(p) {
  p.gripping = true;
  // grip grabs from anywhere on the panel
  const hit = rayHitPanel(p);
  if (hit) startGrab(p, hit.panel, false);
}

function onSqueezeEnd(p) {
  p.gripping = false;
  if (!p.grabViaSelect) p.grabbed = null;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function placeInFront(panel, distance = 0.85, yOffset = -0.05) {
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  camera.getWorldPosition(camPos);
  camera.getWorldDirection(camDir);
  camDir.y *= 0.35;                       // keep panels near eye level
  camDir.normalize();

  panel.mesh.position.copy(camPos).addScaledVector(camDir, distance);
  panel.mesh.position.y += yOffset;
  panel.mesh.lookAt(camPos);
}

function addPanel(panel, distance) {
  placeInFront(panel, distance);
  scene.add(panel.object3D);
  panels.add(panel);
  return panel;
}

function removePanel(panel) {
  scene.remove(panel.object3D);
  panels.delete(panel);
  panel.dispose();
}

function openMenu() {
  if (menuPanel) return;
  menuPanel = new MenuPanel(key => { openPanel(key); closeMenu(); });
  addPanel(menuPanel, 0.75);
}

/** Spawn a panel by name, focusing an existing one rather than duplicating. */
const PANEL_KINDS = {
  nano:   { Cls: NanoPanel,   dist: 1.0  },
  video:  { Cls: VideoPanel,  dist: 0.85 },
  mirror: { Cls: MirrorPanel, dist: 1.25 },
};

function openPanel(key) {
  if (key === 'playfield') return openPlayfield();
  if (key === 'bat')       { toggleBat(); return null; }
  const kind = PANEL_KINDS[key];
  if (!kind) return null;
  for (const p of panels) {
    if (p instanceof kind.Cls) { placeInFront(p, kind.dist); return p; }
  }
  return addPanel(new kind.Cls(net, openPanel), kind.dist);
}

function openPlayfield() {
  if (playfield) { placeInFront({ mesh: playfield.mesh }, 1.3, -0.02); return playfield; }
  playfield = new Playfield(net, { width: 1.7, height: 0.96, segments: 72 });
  scene.add(playfield.object3D);
  placeInFront({ mesh: playfield.mesh }, 1.3, -0.02);
  return playfield;
}

function closePlayfield() {
  if (!playfield) return;
  scene.remove(playfield.object3D);
  playfield.dispose();
  playfield = null;
}

function toggleBat() {
  if (bat && bat.attached) { bat.detach(); return false; }
  if (!bat) bat = new Bat();
  // prefer the hand/controller that isn't currently holding a panel
  const p = pointers.find(x => !x.grabbed) || pointers[0];
  if (p) bat.attach(scene, p);
  return true;
}

function closeMenu() {
  if (!menuPanel) return;
  removePanel(menuPanel);
  menuPanel = null;
}

function toggleMenu() { menuPanel ? closeMenu() : openMenu(); }

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

const _tmpMat = new THREE.Matrix4();

function rayHitPanel(p) {
  const meshes = [...panels].map(x => x.mesh);
  if (!meshes.length) return null;

  _tmpMat.identity().extractRotation(p.controller.matrixWorld);
  p.raycaster.ray.origin.setFromMatrixPosition(p.controller.matrixWorld);
  p.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_tmpMat);

  const hits = p.raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const hit = hits[0];
  const panel = hit.object.userData.panel;
  const { x, y } = panel.uvToPx(hit.uv.x, hit.uv.y);
  return { panel, x, y, distance: hit.distance };
}

/**
 * Both hands on the same panel = scale it, pulling apart to grow.
 *
 * Runs before the per-pointer pass so a two-handed hold takes precedence over
 * either hand's single-handed drag.
 */
let _twoHand = null;

function heldBy(p) {
  return p.gripping || (p.grabViaSelect && (p.active || p.poking));
}

function twoHandTransform() {
  const [a, b] = pointers;
  if (!a || !b) { _twoHand = null; return false; }

  // Engaged = pinching or gripping. Deliberately not requiring a title-bar
  // grab: that strip is ~4.6cm tall in world space, and asking someone to land
  // two simultaneous pinches inside it is not a gesture, it's a dexterity test.
  const engagedA = a.pinching || a.gripping;
  const engagedB = b.pinching || b.gripping;
  if (!engagedA || !engagedB) { _twoHand = null; return false; }

  // Whatever each hand is holding, touching or pointing at — from last frame,
  // which is close enough for a continuous gesture.
  const pa = a.grabbed || a.hoverPanel;
  const pbTarget = b.grabbed || b.hoverPanel;
  if (!pa || pa !== pbTarget) { _twoHand = null; return false; }

  const panel = pa;
  a.controller.updateMatrixWorld();
  b.controller.updateMatrixWorld();
  const handA = new THREE.Vector3().setFromMatrixPosition(a.controller.matrixWorld);
  const handB = new THREE.Vector3().setFromMatrixPosition(b.controller.matrixWorld);
  const dist = Math.max(1e-4, handA.distanceTo(handB));
  const mid = handA.clone().add(handB).multiplyScalar(0.5);

  if (!_twoHand || _twoHand.panel !== panel) {
    for (const p of [a, b]) {
      if (p.downPanel) { p.downPanel.pointerUp(p.index, p.lastHit?.x ?? 0, p.lastHit?.y ?? 0); }
      p.downPanel = null;
      p.poking = false;
    }
    _twoHand = {
      panel, dist0: dist, mid0: mid.clone(),
      scale0: panel.mesh.scale.x,
      pos0: panel.mesh.position.clone(),
    };
    return true;
  }

  const s = Math.max(0.35, Math.min(3.5, _twoHand.scale0 * (dist / _twoHand.dist0)));
  panel.mesh.scale.setScalar(s);
  // travel with the midpoint so the panel stays between your hands
  panel.mesh.position.copy(_twoHand.pos0).add(mid.clone().sub(_twoHand.mid0));
  return true;
}

function tick(time, frame) {
  try { frameBody(time, frame); }
  catch (e) {
    console.error('frame failed:', e);
    window.__bwReport?.('frame', e);
    try { renderer.render(scene, camera); } catch { /* give up on this frame */ }
  }
}

function frameBody(time, frame) {
  if (frame) pollButtons(frame);

  const nowS = time * 0.001;
  const dt = Math.min(0.1, _lastT ? nowS - _lastT : 0.016);
  _lastT = nowS;

  // Push queued parameter writes. The window's requestAnimationFrame is
  // suspended during an immersive session, so this is the only reliable
  // flush point while the headset is on.
  net.flush();

  if (twoHandTransform()) {
    for (const p of pointers) { p.ray.visible = false; p.dot.visible = false; }
    for (const panel of panels) panel.update();
    renderer.render(scene, camera);
    return;
  }

  for (const p of pointers) {
    // carry a grabbed panel with the pointer — held by grip, or by
    // trigger/pinch if the grab started on the title bar
    if (p.grabbed && (p.gripping || (p.grabViaSelect && p.active))) {
      p.controller.updateMatrixWorld();
      p.grabbed.mesh.matrix.copy(p.controller.matrixWorld).multiply(p.grabOffset);
      p.grabbed.mesh.matrix.decompose(
        p.grabbed.mesh.position, p.grabbed.mesh.quaternion, p.grabbed.mesh.scale);
      continue;
    }

    ensureHandMeshes(p);

    // Near field wins over the ray: if a finger is at the panel, you are
    // touching it, and a laser pointer at that range is just noise.
    const poke = pokeHit(p);
    if (poke) {
      p.ray.visible = false;
      p.dot.visible = false;
      p.lastHit = poke;

      const inside = poke.z <= PRESS_DEPTH;
      if (inside && !p.poking) {
        p.poking = true;
        if (poke.panel.isTitleBar(poke.y)) startGrab(p, poke.panel, true);
        else { p.downPanel = poke.panel; poke.panel.pointerDown(p.index, poke.x, poke.y); }
      } else if (p.poking && poke.z > RELEASE_DEPTH) {
        p.poking = false;
        if (p.downPanel) poke.panel.pointerUp(p.index, poke.x, poke.y);
        p.downPanel = null;
        if (p.grabViaSelect) { p.grabbed = null; p.grabViaSelect = false; }
      } else if (p.poking && p.downPanel === poke.panel) {
        poke.panel.pointerMove(p.index, poke.x, poke.y);
      }
      p.hoverPanel = poke.panel;
      continue;
    }
    if (p.poking) {                       // finger withdrawn entirely
      p.poking = false;
      if (p.downPanel && p.lastHit) p.downPanel.pointerUp(p.index, p.lastHit.x, p.lastHit.y);
      p.downPanel = null;
      if (p.grabViaSelect) { p.grabbed = null; p.grabViaSelect = false; }
    }
    p.ray.visible = true;

    const hit = rayHitPanel(p);
    p.ray.scale.z = hit ? hit.distance : 2;
    p.ray.material.opacity = hit ? 0.9 : 0.35;

    if (hit) {
      p.dot.visible = true;
      p.dot.position.copy(p.raycaster.ray.origin)
        .addScaledVector(p.raycaster.ray.direction, hit.distance);
      p.lastHit = hit;

      if (p.active && !p.downPanel && !p.grabbed) {
        if (hit.panel.isTitleBar(hit.y)) {
          // dragging the title bar moves the panel — the only way to place
          // one when there is no grip button, i.e. with hand tracking
          startGrab(p, hit.panel, true);
        } else {
          p.downPanel = hit.panel;
          hit.panel.pointerDown(p.index, hit.x, hit.y);
        }
      } else if (p.active && p.downPanel === hit.panel) {
        hit.panel.pointerMove(p.index, hit.x, hit.y);
      }
      p.hoverPanel = hit.panel;
    } else {
      p.dot.visible = false;
      p.hoverPanel = null;
    }
  }

  // Both hands pinched = menu — unless they're holding a panel, in which
  // case the pinch is a resize and must not also toggle the UI.
  const resizing = pointers.length === 2 && pointers[0].grabbed &&
                   pointers[0].grabbed === pointers[1].grabbed;
  const bothPinching = !resizing && pointers.length === 2 &&
    pointers.every(p => p.hand?.inputState?.pinching);
  if (bothPinching && !_bothPrev) toggleMenu();
  _bothPrev = bothPinching;

  // --- playfield ----------------------------------------------------------
  // pinch on the surface = stretch      pinch the corner handle = move
  // two pinches          = resize       fist                    = punch
  //
  // Fist no longer carries the surface: a fist is how you punch it, and the
  // two gestures were competing on every swing.
  if (playfield) {
    const pinchers = [];
    for (const p of pointers) {
      updateFist(p);
      palmWorld(p, p._palm || (p._palm = new THREE.Vector3()));

      // punch — a fist crossing the plane with speed behind it
      const l = playfield.toLocal(p._palm);
      const side = Math.sign(l.z);
      if (p.fist) {
        const v = p._prevPalm ? p._palm.distanceTo(p._prevPalm) / Math.max(dt, 1e-3) : 0;
        const crossed = p._pfSide !== undefined && p._pfSide !== 0 && side !== 0 && side !== p._pfSide;
        const onFace = Math.abs(l.x) < playfield.w * 0.6 && Math.abs(l.y) < playfield.h * 0.6;
        if (crossed && onFace && v > 0.7) playfield.hit(p._palm, v);
      }
      p._pfSide = side;
      (p._prevPalm || (p._prevPalm = new THREE.Vector3())).copy(p._palm);

      p._tip = p.hand?.joints?.['index-finger-tip'];
      p._src = (p._tip && p._tip.visible !== false)
        ? p._tip.getWorldPosition(p._srcV || (p._srcV = new THREE.Vector3()))
        : (p._srcV || (p._srcV = new THREE.Vector3())).setFromMatrixPosition(p.controller.matrixWorld);

      if ((p.pinching || p.gripping || p.active) && !p.fist) pinchers.push(p);
    }

    // Two pinches ON THE FACE are a two-point stretch — the best thing in
    // here and not something to spend on a resize. Resize only when both
    // pinches are out on the border, where there is nothing to deform.
    const bothOnBorder = pinchers.length === 2 &&
      pinchers.every(p => !playfield.nearSurface(p._src) || playfield.isBorder(p._src));

    if (bothOnBorder) {
      const [a, b] = pinchers;
      const d = Math.max(1e-4, a._src.distanceTo(b._src));
      const mid = a._src.clone().add(b._src).multiplyScalar(0.5);
      if (!playfield._two) {
        for (const p of pinchers) if (p.pfGrab) { playfield.endGrab(`pf${p.index}`); p.pfGrab = false; }
        playfield._two = { d0: d, mid0: mid.clone(),
                           s0: playfield.mesh.scale.x,
                           p0: playfield.mesh.position.clone() };
      } else {
        const t = playfield._two;
        playfield.mesh.scale.setScalar(Math.max(0.3, Math.min(4, t.s0 * (d / t.d0))));
        playfield.mesh.position.copy(t.p0).add(mid.clone().sub(t.mid0));
      }
    } else {
      playfield._two = null;

      for (const p of pointers) {
        const engaged = (p.pinching || p.gripping || p.active) && !p.fist;
        const id = `pf${p.index}`;

        // corner handle carries the whole surface
        if (engaged && !p.pfGrab && (p.pfMove || playfield.isHandle(p._src))) {
          if (!p.pfMove) { p.pfMove = true; p._moveOff = playfield.mesh.position.clone().sub(p._src); }
          playfield.mesh.position.copy(p._src).add(p._moveOff);
          continue;
        }
        if (!engaged) p.pfMove = false;
        if (p.pfMove) continue;

        // otherwise pinch on the face stretches it
        if (engaged && !p.pfGrab && playfield.nearSurface(p._src)) {
          if (playfield.beginGrab(id, p._src)) p.pfGrab = true;
        } else if (engaged && p.pfGrab) {
          playfield.moveGrab(id, p._src);
        } else if (!engaged && p.pfGrab) {
          playfield.endGrab(id);
          p.pfGrab = false;
        }
      }
    }

    if (bat && bat.attached) {
      bat.update(dt);
      const strike = bat.checkStrike(playfield);
      if (strike) playfield.hit(strike.point, strike.speed);
    }

    playfield.update(dt, nowS);
  }

  for (const panel of panels) panel.update();
  renderer.render(scene, camera);
}
let _bothPrev = false;

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function teardown() {
  renderer.setAnimationLoop(null);
  window.removeEventListener('resize', onResize);
  for (const p of [...panels]) removePanel(p);
  closePlayfield();
  if (bat) { bat.dispose(); bat = null; }
  menuPanel = null;
  pointers.length = 0;
}
