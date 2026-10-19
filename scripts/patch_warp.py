#!/usr/bin/env python3
"""
Add a hand-driven warp stage to waaave_pool.

WHY: waaave_pool's displacement parameters act on the *feedback* coordinate
once per iteration (c_x = c_y = .01), so they set how fast the field drifts —
they cannot express "this part of the picture moved to there", which is what a
hand grabbing the image means. This adds a real warp applied to
texCoordVarying before anything samples it, so the live input, the temporal
filter and the feedback all deform together, with a range chosen for visible
effect rather than borrowed from a drift constant.

Three effects, all centred on the grab point with a gaussian falloff:
  pull   — drag the image toward/away from where your hand went
  twist  — swirl around the grab point
  bulge  — local zoom, so a pinch can push the picture away or suck it in

Driven over MIDI CC 80-86, which the stock app leaves unused (it handles
16-23, 32-39, 41-46, 48-55, 58-62, 64-71, 120-127). No ofxOsc needed.

  CC 80  centre X          0..1 across the frame
  CC 81  centre Y
  CC 82  pull X            bipolar, 64 = none, full scale = +-0.75 frames
  CC 83  pull Y
  CC 84  amount + radius   0 = off
  CC 85  twist             bipolar, +-2.2 rad at the centre
  CC 86  bulge             bipolar, +-0.8 local zoom

Deliberately NOT routed through p_lock/soft-takeover: a warp has to track the
hand immediately, and pickup semantics would make the first move of every
gesture do nothing at all.

Handles CRLF files and tab indentation — the Pi's sources are CRLF, which is
what defeated the first version of this script.

Idempotent: running it twice is a no-op.
"""

import re
import shutil
import sys
from pathlib import Path

MARK = "BUMMYWAVES_WARP"


def read(path):
    raw = path.read_bytes()
    crlf = b"\r\n" in raw
    return raw.decode("utf-8", "replace").replace("\r\n", "\n"), crlf


def write(path, text, crlf):
    shutil.copy2(path, path.with_suffix(path.suffix + ".prewarp"))
    if crlf:
        text = text.replace("\n", "\r\n")
    path.write_bytes(text.encode("utf-8"))


SHADER_FUNC = f"""
//{MARK} ------------------------------------------------------------------
uniform vec2  warpCenter;
uniform vec2  warpPull;
uniform float warpAmt;
uniform float warpRadius;
uniform float warpTwist;
uniform float warpBulge;

vec2 bwWarp(in vec2 c){{
    if(warpAmt<=0.002) return c;
    float r=max(warpRadius,0.03);
    vec2 d=c-warpCenter;
    float w=exp(-dot(d,d)/(2.0*r*r))*warpAmt;

    //drag the image with the hand
    c-=warpPull*w;

    //swirl about the grab point
    float a=warpTwist*w;
    if(abs(a)>0.0005){{
        float s=sin(a), co=cos(a);
        vec2 q=c-warpCenter;
        c=warpCenter+vec2(q.x*co-q.y*s, q.x*s+q.y*co);
    }}

    //local zoom: push away or suck in
    c=warpCenter+(c-warpCenter)*(1.0-warpBulge*w);
    return c;
}}
//{MARK} ------------------------------------------------------------------
"""


def patch_shader(path: Path) -> bool:
    src, crlf = read(path)
    if MARK in src:
        print(f"  {path.name}: already patched")
        return True

    m = re.search(r"^uniform float temporalFilterResonance;\s*$", src, re.M)
    if not m:
        print(f"  {path.name}: FAILED — no uniform anchor", file=sys.stderr)
        return False
    src = src[:m.end()] + "\n" + SHADER_FUNC + src[m.end():]

    m = re.search(r"^void\s+main\s*\(\s*\)\s*\n?\s*\{", src, re.M)
    if not m:
        print(f"  {path.name}: FAILED — no main()", file=sys.stderr)
        return False
    inject = "\n    vec2 texCoord=bwWarp(texCoordVarying);"
    src = src[:m.end()] + inject + src[m.end():]

    head, sep, body = src.partition(inject)
    body = body.replace("texCoordVarying", "texCoord")
    src = head + sep + body

    write(path, src, crlf)
    print(f"  {path.name}: patched ({'CRLF' if crlf else 'LF'})")
    return True


def patch_app(path: Path) -> bool:
    src, crlf = read(path)
    if MARK in src:
        print(f"  {path.name}: already patched")
        return True

    state = (
        f"\n//{MARK}: hand warp, driven straight from CC 80-86.\n"
        "//Not p_lock'd: a warp must follow the hand with no pickup delay.\n"
        "float warp_cx=0.5f, warp_cy=0.5f;\n"
        "float warp_px=0.0f, warp_py=0.0f;\n"
        "float warp_amt=0.0f, warp_rad=0.30f;\n"
        "float warp_twist=0.0f, warp_bulge=0.0f;\n"
    )
    m = re.search(r"^#define\s+CONTROL_THRESHOLD.*$", src, re.M)
    if not m:
        print(f"  {path.name}: FAILED — no CONTROL_THRESHOLD", file=sys.stderr)
        return False
    src = src[:m.end()] + "\n" + state + src[m.end():]

    handlers = (
        f"\n                //{MARK}\n"
        "                if(message.control==80){warp_cx=message.value/127.0f;}\n"
        "                if(message.control==81){warp_cy=message.value/127.0f;}\n"
        "                if(message.control==82){warp_px=(message.value/127.0f-0.5f)*1.5f;}\n"
        "                if(message.control==83){warp_py=(message.value/127.0f-0.5f)*1.5f;}\n"
        "                if(message.control==84){\n"
        "                    warp_amt=message.value/127.0f;\n"
        "                    warp_rad=0.08f+0.42f*(message.value/127.0f);\n"
        "                }\n"
        "                if(message.control==85){warp_twist=(message.value/127.0f-0.5f)*4.4f;}\n"
        "                if(message.control==86){warp_bulge=(message.value/127.0f-0.5f)*1.6f;}\n"
    )
    m = re.search(r"^[ \t]*//MIDIMAPZONE[ \t]*$", src, re.M)
    if not m:
        print(f"  {path.name}: FAILED — no MIDIMAPZONE", file=sys.stderr)
        return False
    src = src[:m.start()] + handlers + src[m.start():]

    # uniform upload, whitespace-insensitive anchor
    m = re.search(r"^([ \t]*)shader_mixer\.setUniform1f\(\"lumakey\".*$", src, re.M)
    if not m:
        print(f"  {path.name}: FAILED — no lumakey uniform", file=sys.stderr)
        return False
    ind = m.group(1)
    uploads = (
        f"{ind}//{MARK}\n"
        f'{ind}shader_mixer.setUniform2f("warpCenter",warp_cx,warp_cy);\n'
        f'{ind}shader_mixer.setUniform2f("warpPull",warp_px,warp_py);\n'
        f'{ind}shader_mixer.setUniform1f("warpAmt",warp_amt);\n'
        f'{ind}shader_mixer.setUniform1f("warpRadius",warp_rad);\n'
        f'{ind}shader_mixer.setUniform1f("warpTwist",warp_twist);\n'
        f'{ind}shader_mixer.setUniform1f("warpBulge",warp_bulge);\n'
    )
    src = src[:m.start()] + uploads + src[m.start():]

    for needle in ("warp_cx=0.5f", "message.control==80", 'setUniform2f("warpCenter"'):
        if needle not in src:
            print(f"  {path.name}: FAILED — missing {needle}", file=sys.stderr)
            return False

    write(path, src, crlf)
    print(f"  {path.name}: patched ({'CRLF' if crlf else 'LF'})")
    return True


def main():
    targets = [Path(p) for p in sys.argv[1:]]
    if not targets:
        print(__doc__)
        return 1
    ok = True
    for t in targets:
        if not t.is_file():
            print(f"  {t}: MISSING", file=sys.stderr)
            ok = False
        elif t.suffix == ".cpp":
            ok &= patch_app(t)
        else:
            ok &= patch_shader(t)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
