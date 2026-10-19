# bummyWAVES — architecture

A Quest 3 passthrough control surface for **waaave_pool** running on a Raspberry Pi 5.

The project spans four languages that never call each other directly. They meet at
exactly two seams, and every design decision below exists to keep those seams
narrow.

---

## The whole system

```
  ┌────────────────────┐   wss:// JSON     ┌──────────────────┐   ALSA MIDI    ┌──────────────────┐
  │  Quest 3 browser   │ ───────────────►  │  bridge.py       │ ─────────────► │  waaave_pool     │
  │  three.js / WebXR  │ ◄───────────────  │  aiohttp + mido  │   CC 0-127     │  openFrameworks  │
  │  (JavaScript)      │   state, files    │  (Python)        │                │  (C++ / GLSL)    │
  └────────────────────┘                   └────────┬─────────┘                └────────┬─────────┘
           ▲                                        │                                   │
           │ https:// static files                  │ mpv --input-ipc-server            │ HDMI
           └────────────────────────────────────────┤ (JSON over unix socket)           ▼
                                                    ▼                              PROJECTOR
                                           /dev/video0 (v4l2loopback)             ← the actual output
                                                    │
                                                    └──► waaave_pool's ofVideoGrabber
```

Everything runs **on the Pi**. The Mac is an editor and nothing else; there is no
machine in the loop at a venue.

---

## The two seams

### Seam 1 — browser ⇄ bridge: named parameters over JSON

The browser **never sees a MIDI CC number**. It says what it means:

```json
{"t": "set",  "p": "fb_x_displace", "v": 0.62}
{"t": "trig", "p": "mirror",        "v": true}
```

`params/waaave_params.json` is the single source of truth mapping `fb_x_displace`
→ CC 120 → `p_lock[8]` → the `fbXDisplace` shader uniform. The bridge owns that
table and serves it to the client on connect, so a remap is a one-file change
that both sides pick up with no code edits on either.

**Why:** waaave_pool's MIDI map is an implementation detail of a C++ file. If CC
numbers leaked into JavaScript, every remap would be a two-language change, and
the UI would silently drift out of sync with the synth.

### Seam 2 — bridge ⇄ waaave_pool: MIDI CC

waaave_pool requires **no source changes**. It already listens on MIDI and
`midibiz()` already handles 52 CCs. The bridge opens a *virtual* MIDI port and
`aconnect` wires both it and a physical nanoKONTROL2 into the same input, so
hardware and headset drive the synth simultaneously.

**One caveat:** `midiSetup()` hardcodes `midiIn.openPort(1)`, and index 1 shifts
depending on what USB hardware is plugged in. The robust fix is a one-line change
to `midiIn.openVirtualPort("waaave_in")` and letting `aconnect` do the routing.
Until then, port order matters — verify with `aconnect -l`.

---

## Why WebXR and not Unity

| | WebXR | Unity + Meta XR SDK |
|---|---|---|
| Iteration | edit, save, refresh headset | rebuild, sideload, relaunch |
| Toolchain | none | Unity 6 + Android SDK + adb |
| Served from | the Pi itself | a signed APK you must install |
| Passthrough, hands, anchors | all supported | all supported |
| Headset cameras as a video source | **not available** | available (Passthrough Camera API) |

The only capability WebXR gives up is using the Quest's own cameras as input to
the pool — and the CRT-plus-camera optical feedback loop is a better answer to
that anyway, because it closes in hardware where the aesthetic actually lives.

### TLS is not optional

WebXR only exists in a **secure context**. On a plain `http://192.168.1.x` origin
`navigator.xr` is `undefined` — not an error, just absent. The Pi therefore serves
HTTPS with a self-signed cert (`bridge/make_cert.sh`, IP in subjectAltName). The
Quest browser warns once; tap Advanced → Proceed.

---

## Latency, and where the warp actually happens

**The projector is the product.** A mesh deformed inside the headset is a puppet
show only the performer sees. So the warp is applied *on the Pi*, in the synth,
and the audience sees it at HDMI latency with nothing added.

```
hand moves ──► 1 frame ──► WS ──► bridge ──► MIDI ──► waaave_pool ──► HDMI ──► PROJECTOR
                                                                                (audience: live)

                                    └──► x264 ──► WHEP ──► headset  (performer: ~150-250ms late)
```

Only the performer's confidence monitor is delayed. That inverts the usual
tradeoff and is why streaming quality barely matters — 540p30 is fine for a
monitor, and it sidesteps the Pi 5 having **no hardware H.264 encoder**.

The open design question: deform the local plane too (instant, but diverges from
what the projector shows) or stay strictly WYSIWYG-with-delay. Currently the
client sends parameters only and draws no local deformation.

---

## Rate control

Hand tracking runs at 72–90 Hz; MIDI CC is 7-bit and waaave_pool samples it at
60 fps. Sending every hand frame would flood the port with values the synth
cannot distinguish. Two stages of throttling:

1. **Client** (`net.js`) coalesces all writes into one bundle per `requestAnimationFrame`.
2. **Bridge** (`MidiOut.send_cc`) drops any CC whose quantised 7-bit value is
   unchanged. `/status` reports `sent` vs `deduped` so you can see it working.

---

## The parameter map

Extracted from `WAAAVE-POOL-RP5-PORT/src/ofApp.cpp` — CC → `p_lock` slot →
shader uniform. The eight knobs and eight faders of a nanoKONTROL2:

| CC | slot | uniform | | CC | slot | uniform |
|---|---|---|---|---|---|---|
| 16 | 0 | `lumakey` | | 120 | 8 | **`fbXDisplace`** |
| 17 | 1 | `fbMix` | | 121 | 9 | **`fbYDisplace`** |
| 18 | 2 | `fbHue` | | 122 | 10 | **`fbZDisplace`** |
| 19 | 3 | `fbSaturation` | | 123 | 11 | **`fbRotate`** |
| 20 | 4 | `fbBright` | | 124 | 12 | `fbHuexMod` |
| 21 | 5 | `temporalFilterMix` | | 125 | 13 | `fbHuexOff` |
| 22 | 6 | `temporalFilterResonance` | | 126 | 14 | `fbHuexLfo` |
| 23 | 7 | `sharpenAmount` | | 127 | 15 | `frameDelay` |

**CC 120–123 are the whole reason this project is feasible.** X, Y, Z displacement
and rotation of the feedback field are already exposed and already wired to shader
uniforms — which is exactly what two hands grabbing an image produce. Driving
those four from a grab gesture needs *zero* changes to the C++.

Button rows follow the nanoKONTROL2 grid: S = 32–39, M = 48–55, R = 64–71, plus
globals (toroid 46, mirror 61, lumakey invert 60, wet/dry 71, aspect 62).

---

## What needs C++ changes, and what doesn't

**Works today, no changes:** the entire control surface, global warp from hand
gestures, every toggle, the video browser.

**Needs a one-line change:** `openVirtualPort()` instead of `openPort(1)`, for
stable MIDI routing.

**Needs real work (phase 2):** true per-point lattice warp — grab one corner and
only that corner moves. MIDI can't carry a lattice (7 bits, one value per CC), so
that path wants an `ofxOsc` receiver in the app and a new displacement-map pass in
the shader. Deliberately deferred; the global warp is expressive enough to be
worth playing first.

---

## Repo layout

```
params/waaave_params.json   the contract — both languages read this
bridge/bridge.py            HTTPS + WebSocket + MIDI + mpv control
bridge/make_cert.sh         self-signed cert with the Pi's IP in SAN
client/index.html           landing page; capability probe + launch button
client/src/net.js           WebSocket, write coalescing
client/src/panel.js         canvas-textured panels, widgets, hit-testing
client/src/panels.js        menu / nanoKONTROL / video browser
client/src/app.js           XR session, controllers, hands, grab-and-place
client/src/stretch.js       playfield (grab-and-stretch) and the bat
client/src/feed.js          shared projector feed for the mirror and playfield
client/vendor/three.module.js   vendored — a venue has no internet
scripts/deploy.sh           rsync Mac → Pi
scripts/bummywaaave.service systemd unit
scripts/patch_warp.py       adds the warp stage (CC 80-86) to waaave_pool
```

### UI conventions

Panels are 2D canvases mapped onto quads. A controller ray hits the quad, the UV
becomes canvas pixels, the pixel picks a widget. Flat controls drawn flat — easier
than 3D widgets and truer to the hardware being modelled.

- **Any face button** on **either** controller toggles the menu (indices 4 and 5
  in the xr-standard mapping). The physical Menu button is reserved by Horizon OS
  and never reaches WebXR. Edge state is keyed by handedness, not controller
  index, because index follows connection order — with one controller paired it
  is 0 regardless of which hand it belongs to.
- **Grip** grabs a panel anywhere on its face.
- **Trigger** / **pinch** operates widgets, and dragging the **title bar** moves
  the panel. That second path exists because hands have no grip button: without
  it, a controller-free session could press buttons but never place a panel.
- **Both hands pinched** toggles the menu.

Nothing is bound to a specific hand, so the whole surface is operable with one
controller, or with none at all.
