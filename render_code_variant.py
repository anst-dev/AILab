#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_code_variant.py — Variant 3 tầng kiểu "code-to-video" (tham khảo fb2/fb3):

  TẦNG TRÊN (0-980px)   : màn hình code dark, các dòng typing dần (PIL render)
  TẦNG GIỮA (~990-1110) : sub pill lớn VIẾT TAY (ASS, nền pill mờ)
  TẦNG DƯỚI (980-1920)  : video dạy (blur-fill + video fit), CTA pill xanh neon đáy

Dùng: python render_code_variant.py <mp4> <vtt> --variant <json> [--out NAME]
Output: clips/CODE05_<slug>.mp4 + frames duyệt.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BG = (13, 17, 23)          # #0d1117 nền code
TAB_BG = (22, 27, 34)      # #161b22 tab bar
TXT = (230, 237, 243)      # #e6edf3
GREEN = (126, 231, 135)    # #7ee787 comment
LIME = (163, 230, 53)      # #a3e635 nhấn
W, H_CODE = 1080, 800
TAB_H = 56
FPS = 25
CODE_FONT = "C:/Windows/Fonts/consolab.ttf"
CODE_SIZE = 38
LINE_H = 68
BODY_X = 50
BODY_Y0 = 110
TYPE_SPEED = 30  # chars/giây


def font_code(size=CODE_SIZE):
    return ImageFont.truetype(CODE_FONT, size)


def code_config_hash(v: dict) -> str:
    payload = json.dumps({"tab": v.get("tab"), "lines": v["code_lines"]}, ensure_ascii=False, sort_keys=True)
    payload += f"|{CODE_FONT}|{CODE_SIZE}|{LINE_H}|{BODY_Y0}|{W}x{H_CODE}"
    return hashlib.sha1(payload.encode()).hexdigest()[:12]


def render_code_frames(v: dict, out_dir: Path, dur: float, reuse: bool = True):
    """Render chuỗi frame PNG code typing — cache theo hash cấu hình code."""
    out_dir.mkdir(parents=True, exist_ok=True)
    need = int(dur * FPS)
    meta_path = out_dir / "_meta.json"
    if reuse and meta_path.exists():
        try:
            m = json.loads(meta_path.read_text(encoding="utf-8"))
            have = len(list(out_dir.glob("[0-9]*.png")))
            if m.get("hash") == code_config_hash(v) and have >= need:
                print(f"[cache] {have} frame khớp hash — bỏ qua vẽ lại")
                return need
        except Exception:
            pass
    f = font_code()
    tab_f = font_code(28)

    # trạng thái dòng: list dict {kind, text (full), t0, prefix_key}
    lines = []
    for cl in v["code_lines"]:
        full = cl["text"] + cl.get("val", "")
        lines.append({"t0": float(cl["t"]), "kind": cl["kind"], "key": cl["text"], "full": full})

    n = int(dur * FPS)
    for i in range(n):
        t = i / FPS
        img = Image.new("RGB", (W, H_CODE), BG)
        d = ImageDraw.Draw(img)
        # tab bar
        d.rectangle([0, 0, W, TAB_H], fill=TAB_BG)
        for k, c in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
            d.ellipse([28 + k * 34, TAB_H // 2 - 8, 44 + k * 34, TAB_H // 2 + 8], fill=c)
        d.text((150, TAB_H // 2), v.get("tab", "session"), font=tab_f, fill=TXT)
        d.line([0, TAB_H, W, TAB_H], fill=(48, 54, 61))

        # các dòng code typing (tăng dần theo t0); dòng chưa tới giờ hiện ghost mờ
        cursor_pos = None
        typing_y = None
        y = BODY_Y0
        for ln in lines:
            if t < ln["t0"]:
                d.text((BODY_X, y), ln["full"], font=f, fill=(61, 68, 77))  # ghost
                y += LINE_H
                continue
            chars = int((t - ln["t0"]) * TYPE_SPEED)
            shown = ln["full"][:chars]
            x_end = BODY_X + d.textlength(shown, font=f)
            if chars < len(ln["full"]):
                # highlight nền dòng đang gõ
                d.rounded_rectangle([BODY_X - 16, y - 9, BODY_X + 900, y + 50], 10, fill=(26, 33, 41))
                typing_y = y
                color = GREEN if ln["kind"] == "comment" else TXT
                d.text((BODY_X, y), shown, font=f, fill=color)
                cursor_pos = (x_end + 4, y)
            else:
                color = GREEN if ln["kind"] == "comment" else TXT
                d.text((BODY_X, y), shown, font=f, fill=color)
                cursor_pos = (x_end + 6, y)
            y += LINE_H

        # con trỏ nhấp nháy (mặc định tại chỗ sẽ gõ tiếp)
        if cursor_pos is None:
            cursor_pos = (BODY_X, BODY_Y0)
        if (i // 7) % 2 == 0:
            d.rectangle([cursor_pos[0], cursor_pos[1] + 2, cursor_pos[0] + 16, cursor_pos[1] + 46], fill=LIME)

        img.save(out_dir / f"{i:05d}.png")
    meta_path.write_text(json.dumps({"hash": code_config_hash(v), "frames": n}, ensure_ascii=False), encoding="utf-8")
    return n


ASS_HEAD = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Pill,Segoe UI,62,&H00FFFFFF,&H00FFFFFF,&H501C1C1C,&H00000000,-1,0,0,0,100,100,0,0,3,14,0,2,70,70,970,1
Style: CTA,Segoe UI,54,&H00111111,&H00111111,&H0035E6A3,&H00000000,-1,0,0,0,100,100,0,0,3,16,0,2,60,60,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def fmt_ass(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def make_badge(v: dict, work: Path) -> Path | None:
    """Badge tròn bên trái pill (vd chữ 'AN') — trả về PNG hoặc None."""
    b = v.get("badge")
    if not b:
        return None
    img = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, 95, 95], fill=(31, 31, 31, 216), outline=(163, 230, 53, 255), width=3)
    fnt = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 34)
    txt = b.get("text", "AN")
    tw = d.textlength(txt, font=fnt)
    d.text(((96 - tw) / 2, 27), txt, font=fnt, fill=(255, 255, 255, 255))
    p = work / "badge.png"
    img.save(p)
    return p


def build_ass(v: dict, dur: float) -> str:
    ev = []
    for s in v["subs"]:
        txt = s["text"].replace("\n", "\\N")
        ev.append(f"Dialogue: 0,{fmt_ass(s['t0'])},{fmt_ass(s['t1'])},Pill,,0,0,0,,{txt}")
    cta = v["cta"]
    ev.append(
        f"Dialogue: 1,{fmt_ass(cta['t0'])},{fmt_ass(dur)},CTA,,0,0,0,,"
        f"{cta['line1']}\\N{{\\fs44}}{cta['line2']}"
    )
    return ASS_HEAD + "\n".join(ev) + "\n"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("mp4")
    p.add_argument("vtt")
    p.add_argument("--variant", required=True)
    p.add_argument("--out")
    p.add_argument("--no-reuse-code", action="store_true")
    p.add_argument("--preset", default="ultrafast", help="x264 preset (loop mặc định ultrafast)")
    a = p.parse_args()

    mp4, vtt = Path(a.mp4), Path(a.vtt)
    v = json.loads(Path(a.variant).read_text(encoding="utf-8"))
    src = v["nguon"]
    start, end = float(src["start"]), float(src["end"])
    dur = end - start

    out_buoi = Path(a.variant).resolve().parent             # tuyệt đối — tránh double-relative khi cwd đổi
    work = out_buoi / "_work" / f"variant_{src['segment_id']}"
    title_ascii = "".join(c for c in (src.get("title") or "clip").lower() if not 0x80 <= ord(c) <= 0xFFFF or c.isascii())
    slug = re.sub(r"[^a-z0-9]+", "-", title_ascii).strip("-")[:30] or "clip"
    clip_path = out_buoi / "clips" / (a.out or f"CODE{src['segment_id']}_{slug}.mp4")
    clip_path.parent.mkdir(parents=True, exist_ok=True)

    # 1) frames code
    code_dir = work / "code"
    n = render_code_frames(v, code_dir, dur, reuse=not a.no_reuse_code)
    print(f"[1/3] {n} frame code -> {code_dir}")

    # 2) ASS sub tay + CTA
    ass_path = work / "overlay.ass"
    ass_path.write_text(build_ass(v, dur), encoding="utf-8")

    badge = make_badge(v, work)

    # 3) ghép
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(mp4),
        "-framerate", str(FPS), "-i", str(code_dir / "%05d.png"),
        "-f", "lavfi", "-i", "color=c=0x0D1117:s=1080x1920:r=25",
    ]
    if badge:
        cmd += ["-i", str(badge)]
    chain = (
        "[0:v]split=2[bgsrc][fgsrc];"
        "[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,"
        "crop=1080:1920,boxblur=30:2,eq=brightness=-0.28:saturation=0.65,"
        "crop=1080:1120:0:400[bg];"
        "[fgsrc]scale=1080:-2[fg];"
        "[2:v][1:v]overlay=0:0[c1];"
        "[c1][bg]overlay=0:800[c2];"
        "[c2][fg]overlay=(W-w)/2:1080[c3];"
    )
    last = "c3"
    if badge:
        chain += f"[{last}][3:v]overlay=170:832[c4];"
        last = "c4"
    chain += f"[{last}]ass={ass_path.relative_to(out_buoi).as_posix()}[vout];[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
    cmd += ["-filter_complex", chain,
        "-map", "[vout]", "-map", "[aout]",
        "-t", f"{dur:.3f}",
        "-c:v", "libx264", "-preset", a.preset, "-crf", "20",
        "-r", "25", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(clip_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=out_buoi)
    if proc.returncode != 0:
        print("[LỖI] ffmpeg:", proc.stderr[-2500:])
        return 1

    # 4) frame duyệt
    frames_dir = out_buoi / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for tag, tt in (("d", 2.0), ("g", dur / 2), ("c", dur - 2)):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{tt:.2f}", "-i", str(clip_path),
                        "-frames:v", "1", str(frames_dir / f"CODE{src['segment_id']}_{tag}.png")],
                       capture_output=True)
    size = clip_path.stat().st_size / 1e6
    print(f"[xong] {clip_path.name}.mp4  {size:.1f}MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
