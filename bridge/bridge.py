#!/usr/bin/env python3
"""
bummyWAVES bridge — runs on the Pi, next to waaave_pool.

Serves the WebXR client over HTTPS (WebXR refuses to start on a plain-http LAN
origin) and exposes a WebSocket that translates named parameter messages into
MIDI CC on a virtual port. waaave_pool listens on MIDI and needs no changes.

    browser (JS)  --wss/JSON-->  bridge (Python)  --ALSA MIDI-->  waaave_pool (C++)

The browser never sees a CC number. It sends {"t":"set","p":"fb_x_displace",...}
and this process owns the mapping, which lives in params/waaave_params.json.
"""

import argparse
import asyncio
import json
import logging
import os
import re
import socket
import secrets
import signal
import ssl
import subprocess
import time
from pathlib import Path

from aiohttp import web, WSMsgType

log = logging.getLogger("bridge")

ROOT = Path(__file__).resolve().parent.parent
PARAMS_FILE = ROOT / "params" / "waaave_params.json"
CLIENT_DIR = ROOT / "client"

# Directories scanned for video samples, in order. Mirrors how r_e_c_u_r picks
# up a USB stick.
MEDIA_DIRS = ["/media", "/mnt", str(Path.home() / "videos"), str(Path.home() / "Videos")]
STATE_FILE = Path.home() / ".bummywaaave-state.json"
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg"}


# --------------------------------------------------------------------------
# MIDI
# --------------------------------------------------------------------------

class MidiOut:
    """Virtual MIDI port. CoreMIDI on macOS, ALSA on Linux — mido handles both.

    Values arrive normalised 0..1 and are quantised to 7-bit here. Repeated
    sends of the same 7-bit value are dropped: hand tracking runs at 72-90Hz
    and would otherwise flood the port with duplicates the synth can't use.
    """

    def __init__(self, port_name="waaave_in", enabled=True):
        self.port_name = port_name
        self.enabled = enabled
        self.port = None
        self._last = {}          # cc -> last 7-bit value sent
        self.sent = 0
        self.deduped = 0

        if not enabled:
            log.warning("MIDI disabled (--no-midi); running dry")
            return

        try:
            import mido
            self.mido = mido
            self.port = mido.open_output(port_name, virtual=True)
            log.info("opened virtual MIDI port %r", port_name)
        except Exception as e:
            self.port = None
            log.error("could not open virtual MIDI port: %s", e)
            log.error("running without MIDI — the UI will work, the synth won't move")

    def send_cc(self, cc, value01, channel=1):
        v = max(0, min(127, int(round(float(value01) * 127.0))))
        if self._last.get(cc) == v:
            self.deduped += 1
            return False
        self._last[cc] = v
        self.sent += 1
        if self.port is None:
            return True
        try:
            msg = self.mido.Message("control_change", channel=channel - 1, control=cc, value=v)
            self.port.send(msg)
        except Exception as e:
            log.error("MIDI send failed cc=%s v=%s: %s", cc, v, e)
            return False
        return True

    def autoconnect(self):
        """Subscribe waaave_pool's ALSA input to our port, and keep it that way.

        ofxMidi calls midiIn.openPort(1) once at startup and never retries. Our
        virtual port is destroyed and recreated on every bridge restart, which
        silently drops that subscription for good — the UI keeps working and
        the synth simply stops receiving, which is a miserable thing to debug
        mid-set. Re-asserting the link costs nothing when it already exists.
        """
        if self.port is None:
            return False
        try:
            listing = subprocess.run(["aconnect", "-l"], capture_output=True,
                                     text=True, timeout=4).stdout
        except Exception:
            return False

        src = dst = None
        linked = False
        client = None
        for line in listing.splitlines():
            m = re.match(r"client (\d+): '([^']*)'", line)
            if m:
                client = m.group(1)
                continue
            if self.port_name in line and "RtMidiOut" not in line and src is None:
                src = client
            if "ofxMidi Input" in line:
                dst = client
            if src and "Connecting To:" in line and dst:
                linked = True

        if not (src and dst):
            return False
        if linked:
            return True
        try:
            subprocess.run(["aconnect", f"{src}:0", f"{dst}:0"],
                           capture_output=True, timeout=4)
            log.info("linked MIDI %s:0 -> %s:0 (waaave_pool)", src, dst)
            return True
        except Exception as e:
            log.error("aconnect failed: %s", e)
            return False

    def close(self):
        if self.port:
            try:
                self.port.close()
            except Exception:
                pass


# --------------------------------------------------------------------------
# Video source (ffmpeg -> v4l2loopback, so waaave_pool sees files as camera input)
# --------------------------------------------------------------------------

class VideoSource:
    """Plays a file into a v4l2loopback device that waaave_pool grabs from.

    waaave_pool has no file playback of its own — it is a live-input synth that
    opens a V4L2 camera. Feeding it a file therefore means impersonating a
    camera, which is what v4l2loopback is for.

    Without a loopback device configured this degrades to a no-op that still
    reports state to the UI.
    """

    def __init__(self, loopback="/dev/video0", enabled=True,
                 width=1920, height=1080, fps=30):
        self.loopback = loopback
        self.enabled = enabled
        self.proc = None
        self.current = None
        self.paused = False
        # Must match what waaave_pool asks its grabber for, or GStreamer
        # cannot negotiate and the app logs "ofGstVideoUtils not loaded"
        # forever. ofApp.cpp has width=1920/height=1080 globally, and
        # scaleswitch=1 skips the 960x540 reassignment (that branch is
        # commented out), so cameraSetup passes 1920x1080 through.
        self.width, self.height, self.fps = width, height, fps

    def available(self):
        return self.enabled and Path(self.loopback).exists()

    def kill_strays(self):
        """Reap ffmpeg processes still writing to our loopback.

        A bridge restart orphans its ffmpeg rather than killing it, and the
        orphan keeps the device open. v4l2loopback holds the pixel format set
        by the *first* producer for as long as any producer is attached, so a
        stray silently forces every later stream through a colour conversion —
        and two producers interleaving frames looks like a corrupted feed.
        """
        try:
            out = subprocess.run(
                ["pgrep", "-f", f"(ffmpeg|gst-launch).*{self.loopback}"],
                capture_output=True, text=True, timeout=3).stdout
        except Exception:
            return 0
        killed = 0
        for pid in out.split():
            if self.proc is not None and str(self.proc.pid) == pid:
                continue
            try:
                os.kill(int(pid), signal.SIGKILL)
                killed += 1
            except (ProcessLookupError, ValueError, PermissionError):
                pass
        if killed:
            log.warning("reaped %d stray ffmpeg holding %s", killed, self.loopback)
        return killed

    def _roots(self):
        """Resolved media roots. Anything playable must live under one of these."""
        roots = []
        for base in MEDIA_DIRS:
            try:
                r = Path(base).resolve(strict=True)
                if r.is_dir():
                    roots.append(r)
            except (OSError, RuntimeError):
                continue
        return roots

    def resolve_playable(self, path):
        """Validate a client-supplied path.

        The bridge listens on a LAN — and at a venue, on an open hotspot — so a
        path coming off the socket is untrusted. It must resolve (following
        symlinks) to a real file with a video extension underneath a configured
        media root. Returns the resolved Path or None.
        """
        if not path or not isinstance(path, str):
            return None
        try:
            p = Path(path).resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        if not p.is_file() or p.suffix.lower() not in VIDEO_EXTS:
            return None
        if self._is_junk(p.name):
            return None
        for root in self._roots():
            if p == root or root in p.parents:
                return p
        return None

    @staticmethod
    def _is_junk(name):
        # A stick that has been near a Mac is full of AppleDouble stubs: 4KB
        # "._clip.mp4" files that pass an extension check and then kill mpv.
        return name.startswith("._") or name in (".DS_Store", "Thumbs.db")

    def list_files(self):
        out = []
        for root in self._roots():
            try:
                for f in sorted(root.rglob("*")):
                    if not f.is_file() or f.suffix.lower() not in VIDEO_EXTS:
                        continue
                    if self._is_junk(f.name):
                        continue
                    # a symlink inside the stick must not point outside it
                    try:
                        real = f.resolve(strict=True)
                    except (OSError, RuntimeError):
                        continue
                    if not (real == root or root in real.parents):
                        continue
                    try:
                        size = real.stat().st_size
                    except OSError:
                        continue
                    out.append({"path": str(real), "name": f.name, "size": size})
                    if len(out) >= 300:
                        return out
            except (PermissionError, OSError):
                continue
        return out

    def autostart(self):
        """Put *something* on the loopback before waaave_pool looks at it.

        waaave_pool crashes outright if /dev/video0 exists with no producer:
        ofGstVideoGrabber enumerates the loopback, finds a device with no
        format negotiated, and takes the X server down with it. It exits 0, so
        systemd's Restart=on-failure correctly leaves it dead — meaning a cold
        boot came up with no visuals at all until someone manually started a
        clip. Feeding the loopback here, before the synth is ordered to start,
        is what makes the box boot straight into working.
        """
        if not self.available():
            return None
        last = None
        try:
            last = json.loads(STATE_FILE.read_text()).get("last")
        except Exception:
            pass
        candidate = self.resolve_playable(last) if last else None
        if candidate is None:
            files = self.list_files()
            if not files:
                log.warning("no videos found; loopback will stay empty "
                            "and waaave_pool will not survive startup")
                return None
            candidate = files[0]["path"]
        ok, detail = self.play(str(candidate))
        log.info("autostart feed: %s (%s)", Path(str(candidate)).name, detail)
        return candidate if ok else None

    def _remember(self, path):
        try:
            STATE_FILE.write_text(json.dumps({"last": str(path)}))
        except Exception as e:
            log.debug("could not save state: %s", e)

    def play(self, path):
        safe = self.resolve_playable(path)
        if safe is None:
            return False, "not a playable file under a media directory"
        path = str(safe)
        self.stop()
        self.kill_strays()
        if not self.available():
            self.current = path
            return False, f"no loopback device at {self.loopback} (file selected but not playing)"

        # ffmpeg, not mpv: mpv cannot write into a v4l2loopback device. Its
        # --o/--vo=image path is an encode-to-file mode that produces image
        # files, which is a different job to presenting as a camera.
        #
        # -re paces at native frame rate (without it ffmpeg races through the
        # file as fast as it can decode), -stream_loop -1 loops forever, and
        # the scale matches waaave_pool's cam1.initGrabber(960, 540).
        # Pass yuv420p straight through. Nearly every H.264 file is already
        # yuv420p, so this is a genuine zero-conversion path: measured on a
        # Pi 5, forcing yuyv422 instead cost an extra ~138% CPU for the colour
        # conversion alone (273% total vs 123%). waaave_pool's GStreamer
        # grabber negotiates I420 without complaint.
        #
        # The scale stays: waaave_pool asks for exactly 1920x1080 and will not
        # negotiate anything else, and a scale filter whose input already
        # matches costs nothing measurable.
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-re", "-stream_loop", "-1",
            "-i", path,
            "-an",
            "-vf", f"scale={self.width}:{self.height}",
            "-r", str(self.fps),
            "-f", "v4l2", "-pix_fmt", "yuv420p", self.loopback,
        ]
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.PIPE)
            self.current = path
            self.paused = False
            self._remember(path)
            # give it a moment to fail loudly rather than silently
            try:
                self.proc.wait(timeout=1.2)
                err = (self.proc.stderr.read() or b"").decode(errors="replace").strip()
                self.proc = None
                return False, f"ffmpeg exited: {err[:160] or 'unknown error'}"
            except subprocess.TimeoutExpired:
                pass          # still running, which is what we want
            return True, "playing"
        except FileNotFoundError:
            return False, "ffmpeg not installed"
        except Exception as e:
            return False, str(e)

    def set_pause(self, paused):
        """ffmpeg has no IPC channel, so pause by stopping the process itself.

        SIGSTOP freezes it mid-stream; the loopback simply stops receiving
        frames and waaave_pool keeps chewing on the last one, which for a
        feedback synth is a perfectly reasonable freeze.
        """
        if not self.proc or self.proc.poll() is not None:
            return
        try:
            self.proc.send_signal(signal.SIGSTOP if paused else signal.SIGCONT)
            self.paused = bool(paused)
        except Exception as e:
            log.error("pause failed: %s", e)

    def stop(self):
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=1)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        self.proc = None
        self.current = None

    def state(self):
        return {
            "available": self.available(),
            "loopback": self.loopback,
            "current": self.current,
            "playing": self.proc is not None and self.proc.poll() is None,
            "paused": self.paused,
        }


# --------------------------------------------------------------------------
# Output mirror (X11 grab -> MJPEG, so the headset can see the synth)
# --------------------------------------------------------------------------

class OutputMirror:
    """Streams what the projector is showing, as MJPEG over HTTP.

    MJPEG rather than WebRTC on purpose: the Pi 5 has no hardware H.264
    encoder, so an H.264 stream would be a software encode competing with the
    synth for cores. JPEG-per-frame is cheaper, has no negotiation, and a
    browser can consume it from a plain <img>. At a confidence-monitor
    resolution the quality is irrelevant — the projector is the real output.
    """

    def __init__(self, display=":0", width=960, height=540, fps=15, quality=7):
        self.display = display
        self.width, self.height, self.fps, self.quality = width, height, fps, quality
        self.proc = None
        self.frame = None            # latest complete JPEG
        self.seq = 0
        self._task = None
        self._waiters = set()
        self.error = None

    @property
    def running(self):
        return self.proc is not None and self.proc.returncode is None

    async def start(self):
        if self.running:
            return True
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "x11grab", "-framerate", str(self.fps),
            "-video_size", "1920x1080", "-i", self.display,
            "-vf", f"scale={self.width}:{self.height}",
            "-q:v", str(self.quality),
            "-f", "mjpeg", "pipe:1",
        ]
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except FileNotFoundError:
            self.error = "ffmpeg not installed"
            return False
        self.error = None
        self._task = asyncio.create_task(self._reader())
        log.info("output mirror started (%dx%d @%dfps)", self.width, self.height, self.fps)
        return True

    async def _reader(self):
        """Split the MJPEG byte stream into whole frames on SOI/EOI markers."""
        buf = bytearray()
        try:
            while self.proc and self.proc.stdout:
                chunk = await self.proc.stdout.read(65536)
                if not chunk:
                    break
                buf += chunk
                # a JPEG runs from FFD8 to FFD9; keep only the last complete one
                while True:
                    start = buf.find(b"\xff\xd8")
                    if start < 0:
                        buf.clear()
                        break
                    end = buf.find(b"\xff\xd9", start + 2)
                    if end < 0:
                        del buf[:start]
                        break
                    self.frame = bytes(buf[start:end + 2])
                    self.seq += 1
                    del buf[:end + 2]
                    for fut in list(self._waiters):
                        if not fut.done():
                            fut.set_result(self.seq)
                    self._waiters.clear()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.error("mirror reader died: %s", e)
            self.error = str(e)

    async def wait_frame(self, last_seq):
        """Block until a frame newer than last_seq exists."""
        if self.seq > last_seq and self.frame:
            return self.seq
        fut = asyncio.get_event_loop().create_future()
        self._waiters.add(fut)
        try:
            return await asyncio.wait_for(fut, timeout=5)
        except asyncio.TimeoutError:
            self._waiters.discard(fut)
            return self.seq

    async def stop(self):
        if self._task:
            self._task.cancel()
            self._task = None
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
                await asyncio.wait_for(self.proc.wait(), timeout=2)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        self.proc = None
        self.frame = None
        log.info("output mirror stopped")

    def state(self):
        return {"running": self.running, "fps": self.fps,
                "size": [self.width, self.height], "error": self.error}


# --------------------------------------------------------------------------
# Server
# --------------------------------------------------------------------------

class Bridge:
    def __init__(self, params, midi, video, mirror=None):
        self.params = params
        self.midi = midi
        self.video = video
        self.mirror = mirror
        self.clients = set()
        # Start at 0, not 0.5, and arm the synth explicitly below.
        #
        # waaave_pool uses MIDI soft-takeover: p_lockClear() zeroes every
        # stored value at startup, and a control only becomes live once an
        # incoming CC lands within CONTROL_THRESHOLD (0.04) of that stored
        # value. A UI that starts its knobs at 0.5 therefore does nothing at
        # all until the user happens to sweep past the bottom of the range.
        self.values = {p["id"]: 0.0 for p in params["continuous"]}
        self.toggles = {t["id"]: False for t in params["toggles"]}
        self.cc_of = {p["id"]: p["cc"] for p in params["continuous"]}
        self.toggle_cc = {t["id"]: t["cc"] for t in params["toggles"]}
        self.channel = params.get("midi_channel", 1)

    def neutralise_warp(self):
        """Return the warp stage to rest. Safe to call at any time."""
        rest = {"warp_amount": 0.0, "warp_pull_x": 0.5, "warp_pull_y": 0.5,
                "warp_twist": 0.5, "warp_bulge": 0.5,
                "warp_center_x": 0.5, "warp_center_y": 0.5}
        n = 0
        for pid, v in rest.items():
            cc = self.cc_of.get(pid)
            if cc is None:
                continue
            self.values[pid] = v
            self.midi.send_cc(cc, v, self.channel)
            n += 1
        if n:
            log.info("warp neutralised (%d params)", n)

    def arm(self):
        """Latch every continuous control by matching the synth's stored zero.

        Sending 0 gives |0 - 0| = 0 < CONTROL_THRESHOLD, which sets
        midiActiveFloat for that control. It stays latched afterwards, so one
        pass at startup makes the whole surface responsive immediately.
        """
        bipolar = {"warp_pull_x", "warp_pull_y", "warp_twist",
                   "warp_bulge", "warp_center_x", "warp_center_y"}
        for p in self.params["continuous"]:
            # The warp params are bipolar: 0 is "hard over", not "off". Only
            # warp_amount gates the stage, so rest the rest at centre.
            v = 0.5 if p["id"] in bipolar else 0.0
            self.values[p["id"]] = v
            self.midi.send_cc(p["cc"], v, self.channel)
        log.info("armed %d continuous controls (soft-takeover pickup at 0)",
                 len(self.params["continuous"]))

    # -- outbound ---------------------------------------------------------
    async def broadcast(self, payload, exclude=None):
        dead = []
        for ws in self.clients:
            if ws is exclude:
                continue
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    # -- inbound ----------------------------------------------------------
    async def handle(self, ws, msg):
        t = msg.get("t")

        if t == "hello":
            await ws.send_json({
                "t": "params",
                "continuous": self.params["continuous"],
                "toggles": self.params["toggles"],
                "hand_map": self.params.get("hand_map", {}),
                "values": self.values,
                "toggle_values": self.toggles,
                "video": self.video.state(),
                "mirror": self.mirror.state() if self.mirror else None,
                "midi": {"port": self.midi.port_name, "live": self.midi.port is not None},
            })

        elif t == "set":
            pid, v = msg.get("p"), msg.get("v")
            if pid not in self.cc_of:
                return await ws.send_json({"t": "err", "m": f"unknown param {pid}"})
            v = max(0.0, min(1.0, float(v)))
            self.values[pid] = v
            self.midi.send_cc(self.cc_of[pid], v, self.channel)
            await self.broadcast({"t": "val", "p": pid, "v": v}, exclude=ws)

        elif t == "setmany":
            # hand tracking sends a bundle per frame; one pass, one broadcast
            updates = msg.get("vals", {})
            applied = {}
            for pid, v in updates.items():
                if pid not in self.cc_of:
                    continue
                v = max(0.0, min(1.0, float(v)))
                self.values[pid] = v
                self.midi.send_cc(self.cc_of[pid], v, self.channel)
                applied[pid] = v
            if applied:
                await self.broadcast({"t": "vals", "vals": applied}, exclude=ws)

        elif t == "trig":
            tid, on = msg.get("p"), bool(msg.get("v"))
            if tid not in self.toggle_cc:
                return await ws.send_json({"t": "err", "m": f"unknown toggle {tid}"})
            self.toggles[tid] = on
            # waaave_pool treats 127 as on and 0 as off
            self.midi.send_cc(self.toggle_cc[tid], 1.0 if on else 0.0, self.channel)
            await self.broadcast({"t": "tog", "p": tid, "v": on}, exclude=ws)

        elif t == "raw_cc":
            cc, v = int(msg.get("cc")), int(msg.get("v"))
            self.midi.send_cc(cc, max(0, min(127, v)) / 127.0, self.channel)

        elif t == "ls":
            await ws.send_json({"t": "files", "files": self.video.list_files()})

        elif t == "play":
            ok, detail = self.video.play(msg.get("path", ""))
            await self.broadcast({"t": "video", "ok": ok, "detail": detail, **self.video.state()})

        elif t == "pause":
            self.video.set_pause(msg.get("v", True))
            await self.broadcast({"t": "video", **self.video.state()})

        elif t == "stop":
            self.video.stop()
            await self.broadcast({"t": "video", **self.video.state()})

        elif t == "reset":
            # Back to the synth's own baseline: p_lockClear() zeroes every
            # stored value, so 0 is both "off" and the point where a
            # soft-takeover control re-latches.
            for p in self.params["continuous"]:
                self.values[p["id"]] = 0.0
                self.midi.send_cc(p["cc"], 0.0, self.channel)
            for tg in self.params["toggles"]:
                self.toggles[tg["id"]] = False
                self.midi.send_cc(tg["cc"], 0.0, self.channel)
            await self.broadcast({"t": "reset",
                                  "values": self.values,
                                  "toggle_values": self.toggles})
            log.info("reset all controls to 0")

        elif t == "mirror":
            if not self.mirror:
                return await ws.send_json({"t": "err", "m": "mirror unavailable"})
            if msg.get("v"):
                await self.mirror.start()
            else:
                await self.mirror.stop()
            await self.broadcast({"t": "mirrorstate", **self.mirror.state()})

        elif t == "clienterr":
            # There is no console in a headset; this is how a crash becomes
            # something readable in journalctl.
            log.error("CLIENT [%s] %s", msg.get("tag"), msg.get("msg"))
            for line in (msg.get("stack") or "").splitlines()[:12]:
                log.error("CLIENT     %s", line)

        elif t == "ping":
            await ws.send_json({"t": "pong", "ts": msg.get("ts"), "server_ts": time.time() * 1000})

        else:
            await ws.send_json({"t": "err", "m": f"unknown message type {t!r}"})


def origin_allowed(request):
    """Reject cross-site WebSocket hijacking.

    Without this, any page the performer happens to visit in any browser on the
    network could silently open a socket here and drive the synth. Browsers
    can't forge Origin, so checking it shuts that door; a same-LAN attacker
    with a non-browser client can still forge it, which is what --token is for.
    """
    origin = request.headers.get("Origin")
    if origin is None:
        return True          # non-browser client (curl, the test harness)
    host = request.headers.get("Host", "")
    return origin in (f"https://{host}", f"http://{host}")


async def midi_link_watchdog(app):
    """Re-assert the MIDI subscription periodically.

    Covers the other direction too: if waaave_pool restarts (systemd will
    restart it on a crash) it comes back as a new ALSA client with no link to
    us, and nothing else would ever reconnect it.
    """
    midi = app["bridge"].midi
    try:
        while True:
            midi.autoconnect()
            await asyncio.sleep(10)
    except asyncio.CancelledError:
        pass


async def _start_watchdog(app):
    app["midi_task"] = asyncio.create_task(midi_link_watchdog(app))


async def _stop_watchdog(app):
    t = app.get("midi_task")
    if t:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass


async def ws_handler(request):
    bridge = request.app["bridge"]

    if not origin_allowed(request):
        log.warning("rejected ws upgrade from origin %r", request.headers.get("Origin"))
        raise web.HTTPForbidden(text="bad origin")

    token = request.app.get("token")
    if token and request.query.get("token") != token:
        log.warning("rejected ws upgrade from %s: bad token", request.remote)
        raise web.HTTPForbidden(text="bad token")

    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=4 * 1024 * 1024)
    await ws.prepare(request)
    bridge.clients.add(ws)
    peer = request.remote
    log.info("client connected: %s (%d total)", peer, len(bridge.clients))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    await ws.send_json({"t": "err", "m": "bad json"})
                    continue
                try:
                    await bridge.handle(ws, data)
                except Exception as e:
                    log.exception("handler error")
                    await ws.send_json({"t": "err", "m": str(e)})
            elif msg.type == WSMsgType.ERROR:
                log.error("ws error: %s", ws.exception())
    finally:
        bridge.clients.discard(ws)
        log.info("client gone: %s (%d left)", peer, len(bridge.clients))
        if not bridge.clients:
            # A headset that drops mid-grab never sends the release, which
            # leaves the warp stage pinned at whatever it was holding and the
            # projected image stuck inside out. Neutralise it when the last
            # client goes.
            bridge.neutralise_warp()
    return ws


async def mirror_handler(request):
    """multipart/x-mixed-replace MJPEG — an <img> can consume this directly."""
    mirror = request.app["bridge"].mirror
    if not mirror:
        raise web.HTTPServiceUnavailable(text="no mirror")
    if not mirror.running and not await mirror.start():
        raise web.HTTPServiceUnavailable(text=mirror.error or "mirror failed to start")

    boundary = "waaaveframe"
    resp = web.StreamResponse(status=200, headers={
        "Content-Type": f"multipart/x-mixed-replace; boundary={boundary}",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
    })
    await resp.prepare(request)
    seq = 0
    try:
        while True:
            seq = await mirror.wait_frame(seq)
            frame = mirror.frame
            if not frame:
                continue
            await resp.write(
                f"--{boundary}\r\nContent-Type: image/jpeg\r\n"
                f"Content-Length: {len(frame)}\r\n\r\n".encode() + frame + b"\r\n")
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    except Exception as e:
        log.debug("mirror client gone: %s", e)
    return resp


async def status_handler(request):
    b = request.app["bridge"]
    return web.json_response({
        "ok": True,
        "clients": len(b.clients),
        "midi": {"port": b.midi.port_name, "live": b.midi.port is not None,
                 "sent": b.midi.sent, "deduped": b.midi.deduped},
        "video": b.video.state(),
        "params": {"continuous": len(b.params["continuous"]), "toggles": len(b.params["toggles"])},
    })


async def index_handler(request):
    """Serve the landing page for a bare '/'.

    aiohttp's static handler answers 403 for a directory request rather than
    falling back to index.html — and '/' is the one URL a person actually types
    into a headset.
    """
    return web.FileResponse(CLIENT_DIR / "index.html")


def build_app(params, midi, video, token=None, mirror=None):
    app = web.Application()
    app["bridge"] = Bridge(params, midi, video, mirror)
    app["token"] = token
    app.on_startup.append(_start_watchdog)
    app.on_cleanup.append(_stop_watchdog)
    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/stream.mjpg", mirror_handler)
    app.router.add_get("/status", status_handler)
    app.router.add_static("/", CLIENT_DIR, show_index=False, follow_symlinks=False)
    return app


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser(description="bummyWAVES bridge")
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--cert", default=str(ROOT / "bridge" / "certs" / "cert.pem"))
    ap.add_argument("--key", default=str(ROOT / "bridge" / "certs" / "key.pem"))
    ap.add_argument("--no-tls", action="store_true",
                    help="serve plain http — WebXR will NOT start, debugging only")
    ap.add_argument("--no-midi", action="store_true")
    ap.add_argument("--midi-port", default="waaave_in")
    ap.add_argument("--loopback", default="/dev/video0")
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--token", nargs="?", const="generate", default=None,
                    help="require a token on /ws. Bare --token generates one and "
                         "prints the URL to use. Off by default so the headset "
                         "only needs the IP typed in.")
    ap.add_argument("--display", default=":0",
                    help="X display to mirror to the headset")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    if not PARAMS_FILE.is_file():
        raise SystemExit(f"missing param table: {PARAMS_FILE}")
    params = json.loads(PARAMS_FILE.read_text())

    token = None
    if args.token:
        token = secrets.token_urlsafe(12) if args.token == "generate" else args.token

    midi = MidiOut(args.midi_port, enabled=not args.no_midi)
    video = VideoSource(args.loopback, enabled=not args.no_video)
    video.kill_strays()      # a previous run may have orphaned one
    video.autostart()        # the synth cannot start against an empty loopback
    mirror = OutputMirror(display=args.display)
    app = build_app(params, midi, video, token=token, mirror=mirror)
    app["bridge"].arm()

    ssl_ctx = None
    scheme = "http"
    if not args.no_tls:
        if not (Path(args.cert).is_file() and Path(args.key).is_file()):
            raise SystemExit(
                f"no certificate at {args.cert}\n"
                f"run bridge/make_cert.sh first, or pass --no-tls for local debugging\n"
                f"(WebXR will not start without TLS)"
            )
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(args.cert, args.key)
        scheme = "https"

    ip = local_ip()
    print()
    print("  bummyWAVES bridge")
    print(f"  open on the Quest:  {scheme}://{ip}:{args.port}/")
    if scheme == "https":
        print("  (self-signed cert — tap Advanced, then Proceed, once)")
    else:
        print("  !! --no-tls: navigator.xr will be undefined, no immersive session")
    if token:
        print(f"  token required:     {scheme}://{ip}:{args.port}/?token={token}")
    print(f"  MIDI: {'virtual port ' + midi.port_name if midi.port else 'NOT AVAILABLE'}")
    print(f"  {len(params['continuous'])} continuous params, {len(params['toggles'])} toggles")
    print()

    try:
        web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_ctx,
                    print=lambda *a: None)
    finally:
        midi.close()
        video.stop()


if __name__ == "__main__":
    main()
