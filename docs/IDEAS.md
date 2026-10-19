# Ideas

Design notes for things not built yet. Everything here is filtered through the
one rule that governs this project:

> **The audience sees only the projector.** An AR effect earns its place only if
> it drives the synth so the projected image changes, or if it makes the
> performer faster and more expressive at driving it. Nothing else may cost a
> frame — the Pi runs at ~170% of 400% with everything live.

---

## 0. THE ACTUAL PROJECT — you as a roaming camera

*This surfaced last and it is the headline. Everything below is a side quest.*

The original motivation, in Barr's words: put a camera on people and performers,
walk around with it in one hand and turn knobs with the other — and the headset
was **the solution to needing a third hand**, not the point.

That is a real affordance, not a gimmick. Your head is the camera, it points
where you look, both hands stay free for the synth. A VJ who is simultaneously
the roaming camera operator at their own show, feeding what they see into the
feedback engine they are playing. No controller can do it, because you would
need three hands.

Everything built so far — panels, stretching, the bat — is a side quest next to
this, and the manipulation is the part that felt like a gimmick, correctly.

### The blocker, and the test that decides it

Getting the headset's camera to the Pi. Two routes:

**Route A — Unity + Passthrough Camera API.** Known to work, Horizon OS v74+,
Unity/native only. Meta's docs say WebXR support is "to come" — roadmapped, not
shipped. Costs Unity 6 plus Android tooling, sideloading instead of a refresh,
iteration in minutes instead of seconds.

**Route B — screen capture, no Unity.** Run the WebXR app in passthrough and
capture the *composited* display over wireless adb (scrcpy) into the Pi's
loopback. Hinges on one unanswered question:

> **Does Android display capture on Quest include the passthrough layer, or
> only the app's own layer?**

At least one source describes recording AR passthrough with scrcpy as workable
for creators, which suggests it does. Unverified.

**The test, about five minutes:**

1. `brew install scrcpy`
2. Plug the Quest in — developer mode is already on, adb works
3. Headset on, launch bummyWAVES, enter passthrough
4. Run `scrcpy` on the Mac
5. **Look at the window.** Room visible behind the panels means passthrough is
   included, Route B works, and this happens with the stack already built.
   Panels on black means Unity.

Do this before writing any more code. It decides months of direction.

### What already exists either way

The whole Pi side is unchanged: bridge, protocol, param table, `v4l2loopback`
feeding waaave_pool, the warp stage, MIDI self-healing. Only the client changes.
The camera feed is the reverse of the mirror stream already built, and the
Quest's XR2 has hardware H.264 encode where the Pi 5 has none — so the heavy end
sits on the right device.

### Design notes from the conversation

- **Battery is the real constraint.** Quest 3 runs ~2 hours; cameras plus encode
  plus wifi is less. A set is longer. Battery strap or belt pack.
- **Surveillance vs participation turns on one thing: can people see the
  result?** If the projection shows what you are capturing, transformed,
  immediately, then pointing it at someone is an offer — they watch themselves
  dissolve into the feedback. If the capture is invisible it is a guy scanning
  faces. This makes the audience-sees-the-projector rule load-bearing rather
  than merely aesthetic.
- **Decorate the headset.** Decorated reads as instrument, undecorated reads as
  surveillance tech. Put a **tally light** on it — broadcast convention,
  understood without explanation, makes consent legible for the price of an LED,
  and it can be wired to the bridge so it lights only when the feed is live.
  Mirrors and mylar put the rig inside the aesthetic instead of being a grey
  brick in the middle of it.

---

## 1. The frame cabinet — a Playfield mode

*A button in the Playfield that explodes the single plane into the synth's own
frame buffer, laid out in space.*

**Why this one is different from the cauldron:** it borrows nothing. It is a
literal visualisation of a data structure that already exists and is currently
invisible. `ofApp.cpp`:

```cpp
const int framebufferLength = 60;        // one second, at 60fps
ofFbo pastFrames[framebufferLength];     // a circular ring of past frames
...
int d_delay = (... int((p_lock_smoothed[15]) * (framebufferLength - 1.0)) ...) % framebufferLength;
shader_mixer.setUniformTexture("fb", pastFrames[d_delay].getTexture(), 1);
```

Sixty drawers. One second of the past. `frame_delay` (CC 127) is an index into
it, and it is one of the most violent parameters in the synth because it yanks
the feedback source to a different moment in time.

So: press a button, the plane fans out into a receding row of frames, and you
reach in and pull one. Pulling drawer N *is* setting CC 127. Nothing is
pretending to be anything — you are handling the thing itself.

### The interaction

- **Button in the Playfield** toggles between the single surface and the fan.
- **The row** — 60 planes receding, or an arc so the far end stays reachable.
  Newest nearest, oldest furthest, which makes "reaching back" literal.
- **Grab one** → sets `frame_delay`. The projector immediately starts feeding
  back off that moment instead of the present.
- **Pull it out and move it in X/Y** → drives the warp stage (CC 82/83), so a
  frame you have physically extracted is also displaced. This is the bit Barr
  described: pulling it out *is* moving x and y.
- **Release** → springs back into the row (the release spring already exists).

### The honest compromise

The headset does not have the synth's 60 frames — it receives one MJPEG stream
at ~15fps. So the fan shows a **proxy**: a client-side ring of the last N
received frames. Both are "roughly one second of the past", so mapping drawer
position to `frame_delay` is honest even though the sampling rates differ.

Worth being upfront about that rather than pretending the drawers are exact.

### Practical notes

- **Do not keep 60 full-resolution frames.** 60 × 960×540×4 is ~124 MB of
  texture on a mobile GPU. Downscale the ring to thumbnails (240×135 is ~7.8 MB
  for 60) and only the grabbed frame renders at full size.
- The ring costs nothing to fill — frames are already arriving for the mirror.
- Reuse the existing spring, the existing warp push, and the existing grab
  slots. This is mostly layout plus one button.

### Why it passes the rule

Selecting a drawer sets `frame_delay`, which the audience sees immediately and
dramatically. Moving the extracted frame drives the warp, which they also see.
The fan itself is performer-only, but it is a *control surface* — it makes an
invisible mechanism graspable, which is the second half of the rule.

This is arguably what AR is uniquely for: a temporal array is hard to
understand on a fader and obvious when it is laid out in front of you.

---

## 2. ~~Video soup — the cauldron~~ — rejected

A pot of video you stir with a spoon and drop "ingredients" into.

**Rejected, and the reason is worth keeping.** It dresses the interaction in the
visual language of liquid light shows — oil and dye on overhead projectors —
and the entire value of that craft is that the material does not do what you
want. Heat changes the viscosity, the dye blooms wrong, the glass gets too hot
to hold. The contingency *is* the work. Simulating it produces a deterministic
thing wearing the clothes of an indeterminate one, which is re-enactment, and
you would feel it every time you used it.

Barr has actually run liquid light shows. The objection came from him, not from
theory.

**The obvious inverse — put a real overhead projector, oil and dye in front of
the capture card and let waaave_pool chew on genuine analogue contingency — was
also rejected, on logistics.** A hot plate, clock glasses and an overhead
projector alongside the Pi rig is not a thing you carry to a venue.

What was actually worth keeping from the idea, if anything ever revives it: a
feedback system may want a volumetric, stirrable control surface rather than a
rectangle. That observation is independent of the theming, and does not require
anything to pretend to be oil.

## 3. Port the scan mesh to the Pi

The Spectral Mesh luma displacement is the best-looking thing in the project and
**the audience cannot see any of it** — it runs in the headset shader.

Same move as the warp patch: add it to `shader_mixer.frag` so the projector gets
it. The path is proven now — `scripts/patch_warp.py` shows the pattern, and
CC 87-95 are still free.

Prototype the look in the headset where iteration is a page reload, then bake
the winning parameters into the Pi's shader.

---

## 4. Shards as bound controls

Tear a piece off the surface and it becomes a floating shard that keeps sampling
the live feed. Only worth building if **each shard is bound to a parameter** —
throw it across the room and its distance sets the value. Then it is a spatial
control surface with an audience-visible result rather than decoration.

Rejected in its original form (shards as pretty debris) because the audience
sees nothing.

---

## 5. The CRT feedback loop

Put a CRT in the room showing the pool's output, point a camera at it, feed that
camera into the capture card. Classic optical feedback — phosphor, glare, lens
falloff — with your hands inside it via the warp stage.

Needs an HDMI-to-composite converter; the Pi 5 dropped the analogue A/V jack.

The appeal: this is the one idea where the AR gesture, the digital feedback and
a genuine analogue feedback loop are all in the same circuit.

---

## Explicitly rejected

- **Video crawling onto your real hand.** Headset-only. Costs frames. Delete.
- **Feed projected onto your real wall in AR.** Headset-only.
- **Surface bulging from stream brightness.** Reads *from* the synth and writes
  nothing back, so the audience sees nothing.
