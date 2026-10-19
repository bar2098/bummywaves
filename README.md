# bummyWAVES

A Quest 3 passthrough control surface for **waaave_pool** on a Raspberry Pi 5.

Put the headset on, look at your gear through passthrough, and a nanoKONTROL2
appears floating in the room. Grab it, put it where you want it, and play the
synth. You can also grab the image itself and pull, twist and bulge it with
your hands. The output still goes out the Pi's HDMI to a projector, so the
headset is the controller and the projector is the picture.

For the story behind it and demo clips, see the blog post:
**[BummyTunes, BummyWAVES, and a Dying CPU Fan](https://levibar.com/blogs/bummytunes-and-bummywaves/)**

For how the pieces fit and why, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Prerequisites

### Hardware

| Item | Notes |
|---|---|
| Raspberry Pi 5 | Running the waaave_pool image for Pi 5 (Ubuntu 24.04, `waavepool.service`). See [WAAAVE-POOL-RP5-PORT](https://github.com/bar2098/WAAAVE-POOL-RP5-PORT). |
| Meta Quest 3 | On the same network as the Pi. The Pi's own hotspot works fine at a venue. |
| Projector or monitor on HDMI | This is the real output. |
| USB HDMI capture card | Optional, for live video input. |
| Korg nanoKONTROL2 | Optional. The hardware and the headset can drive the synth at the same time. |

### Software on the Pi

```bash
sudo apt install -y python3-aiohttp python3-mido python3-rtmidi ffmpeg openssl
```

Optional, for playing video files from a USB stick into the pool:

```bash
sudo apt install -y v4l2loopback-dkms
sudo modprobe v4l2loopback video_nr=0 exclusive_caps=1
```

Or with pip instead of apt: `pip install -r bridge/requirements.txt`.

### Image warp (optional)

Grabbing and stretching the image needs a small warp stage added to
waaave_pool. `scripts/patch_warp.py` adds it to the mixer shader and
`ofApp.cpp`, driven by MIDI CC 80 to 86, which stock waaave_pool leaves unused.
It keeps a `.prewarp` backup of every file it touches and is safe to run twice.

```bash
python3 scripts/patch_warp.py <path/to/shader_mixer.frag> <path/to/ofApp.cpp>
```

Rebuild waaave_pool afterwards. Without the patch everything else still works.

---

## Quick start

Everything runs on the Pi. No dev machine at a gig, no internet.

```bash
# on the Pi
cd ~/bummyWAVES
./bridge/make_cert.sh            # self-signed cert with this Pi's IP
python3 bridge/bridge.py
```

Then on the Quest, open the browser and go to:

```
https://<pi-ip>:8443/
```

Tap **Advanced → Proceed** on the certificate warning (once), then
**ENTER PASSTHROUGH**.

### Why https

WebXR only exists in a secure context. Over plain `http://` on a LAN address
`navigator.xr` is simply `undefined`, and the landing page will tell you so. A
self-signed cert is the only way to get a secure context with no internet and
no dev machine in the loop.

### Bridge options

| Flag | Default | Does |
|---|---|---|
| `--port` | `8443` | HTTPS port |
| `--midi-port` | `waaave_in` | MIDI port waaave_pool listens on |
| `--loopback` | `/dev/video0` | v4l2loopback device for the video player |
| `--token` | off | Require a token on the WebSocket. Bare `--token` generates one. |
| `--no-tls` | | Plain http. Fine for `/status`, but no XR session. |
| `--no-midi` / `--no-video` | | Run without MIDI or the video player |
| `-v` | | Verbose logging |

---

## Controls

| Input | Does |
|---|---|
| **Any face button** (X/Y/A/B, either controller) | open / close the menu |
| **Both hands pinched** | open / close the menu |
| **Trigger** / **pinch** | operate knobs, faders, buttons |
| **Drag the title bar** | move a panel and place it in 3D |
| **Grip** | grab a panel from anywhere on its face |

The physical Menu button is reserved by Horizon OS and never reaches WebXR,
which is why it's the face buttons.

**It works with no controllers at all.** Quest 3 hand tracking needs no
batteries. Pinch to press, drag a panel by its title bar to move it, pinch
both hands to open the menu. It also works with a single controller in either
hand, since nothing is bound to a specific side.

### Panels and tools

- **Waaave Pool Controls**: the full nanoKONTROL2 surface. Eight channels of
  knob / S / M / R / fader, mapped to the same CCs the hardware controller
  uses, plus global switches for toroid, mirror, lumakey invert, wet/dry and
  aspect.
- **Video Player**: browses video files on a mounted USB stick and plays one
  into the pool's input, r_e_c_u_r style.
- **Output Mirror**: shows the projector output inside the headset.
- **Playfield**: the projector feed as a sheet in the room. Grab it to pull,
  twist and bulge the image (needs the warp patch).
- **Bat**: spawn it from the menu and hit the playfield with it.

---

## Development

Edit on a laptop, run on the Pi:

```bash
PI=user@192.168.1.100 ./scripts/deploy.sh
```

Run headless to check the bridge without a headset:

```bash
python3 bridge/bridge.py --no-tls --no-midi -v
curl -s localhost:8443/status | python3 -m json.tool
```

### Autostart

`scripts/bummywaaave.service` assumes the user `miapi` and the repo at
`/home/miapi/bummyWAVES`. Edit those two lines for your Pi, then:

```bash
sudo cp scripts/bummywaaave.service /etc/systemd/system/
sudo systemctl enable --now bummywaaave
```

---

## Repo layout

```
bridge/                  Python: HTTPS + WebSocket + MIDI + video player
client/                  three.js WebXR app the Quest loads
client/vendor/           three.js, vendored because a venue has no internet
params/waaave_params.json   parameter → MIDI CC map, read by both sides
scripts/                 deploy, systemd unit, waaave_pool warp patch
docs/ARCHITECTURE.md     how it fits together and why
docs/IDEAS.md            design notes for things not built yet
```

---

## Status

Working: control surface, video player, panel grab-and-place, passthrough,
hand tracking, MIDI out to waaave_pool, output mirror, grab-and-stretch warp.

Next: using the headset's camera as a live input into the pool. See
[docs/IDEAS.md](docs/IDEAS.md).

---

## Credits

**waaave_pool** by Andrei Jay (ex-zee-ex): <https://github.com/ex-zee-ex/waaaave_pool>
· Pi 5 port: [WAAAVE-POOL-RP5-PORT](https://github.com/bar2098/WAAAVE-POOL-RP5-PORT)
· **r_e_c_u_r** by cyberboy666 / langolierz, whose video backend is the model
for the video player · three.js · openFrameworks

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Use it, change it, share it, but
don't make money off it. three.js in `client/vendor/` is MIT and keeps its own
license.
