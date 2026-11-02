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
    payload += f"|{CODE_FONT}|{CODE_SIZE}|{LINE_H}|{BODY_Y0}|{W}x{H_CODE}|v3-grad"
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

    def typed_upto(t, ln):
        """Trả về (chuỗi hiển thị, đang_gõ_không) — nhịp theo TỪ: gõ nhanh trong từ,
        nghỉ 0.1s giữa các từ (đọc mượt như người gõ)."""
        words = ln["full"].split(" ")
        tt = ln["t0"]
        shown_parts = []
        for w in words:
            need = max(len(w) / 40.0, 0.03)
            if t >= tt + need:
                shown_parts.append(w)
                tt += need + 0.10
            else:
                frac = max(min((t - tt) / need, 1.0), 0.0)
                shown_parts.append(w[:max(int(round(len(w) * frac)), 0)])
                return " ".join(shown_parts), True
        return " ".join(shown_parts), False

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
        line_no = 0
        y = BODY_Y0
        flash_until = 0.0
        for ln in lines:
            line_no += 1
            d.text((BODY_X - 38, y + 8), f"{line_no:02d}", font=tab_f, fill=(48, 54, 61))
            if t < ln["t0"]:
                d.text((BODY_X, y), ln["full"], font=f, fill=(61, 68, 77))  # ghost
                y += LINE_H
                continue
            shown, typing = typed_upto(t, ln)
            key_len = len(ln["key"]) if ln.get("kind") == "key" else 0
            x_end = BODY_X + d.textlength(shown, font=f)
            if typing:
                # highlight nền dòng đang gõ
                d.rounded_rectangle([BODY_X - 16, y - 9, BODY_X + 900, y + 50], 10, fill=(26, 33, 41))
                if ln["kind"] == "comment":
                    d.text((BODY_X, y), shown, font=f, fill=GREEN)
                else:
                    d.text((BODY_X, y), shown[:key_len], font=f, fill=(121, 192, 255))
                    if len(shown) > key_len:
                        d.text((BODY_X + d.textlength(shown[:key_len], font=f), y),
                               shown[key_len:], font=f, fill=TXT)
                cursor_pos = (x_end + 4, y)
            else:
                if ln["kind"] == "comment":
                    d.text((BODY_X, y), shown, font=f, fill=GREEN)
                else:
                    d.text((BODY_X, y), shown[:key_len], font=f, fill=(121, 192, 255))
                    if len(shown) > key_len:
                        d.text((BODY_X + d.textlength(shown[:key_len], font=f), y),
                               shown[key_len:], font=f, fill=TXT)
                cursor_pos = (x_end + 6, y)
                # flash viền 0.25s khi dòng vừa hoàn thành
                words = ln["full"].split(" ")
                done_t = ln["t0"] + sum(max(len(w) / 40.0, 0.03) + 0.10 for w in words)
                flash_until = max(flash_until, done_t + 0.25) if done_t <= t <= done_t + 0.25 else flash_until
            y += LINE_H
        if t <= flash_until <= t + 0.25 and flash_until > 0:
            d.rounded_rectangle([6, 6, W - 7, H_CODE - 7], 14, outline=LIME, width=3)

        # con trỏ nhấp nháy (mặc định tại chỗ sẽ gõ tiếp)
        if cursor_pos is None:
            cursor_pos = (BODY_X, BODY_Y0)
        if (i // 7) % 2 == 0:
            d.rectangle([cursor_pos[0], cursor_pos[1] + 2, cursor_pos[0] + 16, cursor_pos[1] + 46], fill=LIME)

        # gradient phân tầng: mép dưới khung code chuyển dần sang lime
        for gy in range(H_CODE - 14, H_CODE):
            k = (gy - (H_CODE - 14)) / 14.0
            col = tuple(int(BG[c] * (1 - k) + LIME[c] * k * 0.85) for c in range(3))
            d.line([0, gy, W, gy], fill=col)

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
Style: CTA,Segoe UI,54,&H00111111,&H00111111,&H0035E6A3,&H00000000,-1,0,0,0,100,100,0,0,3,16,0,2,60,60,185,1
Style: Hook,Segoe UI,74,&H0035E6A3,&H00FFFFFF,&H00101010,&H00000000,-1,0,0,0,100,100,0,0,3,6,2,8,60,60,760,1
Style: Outro,Segoe UI,58,&H00FFFFFF,&H00FFFFFF,&H50141414,&H00000000,-1,0,0,0,100,100,0,0,3,12,0,5,60,60,560,1

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


LIME_TAG = "{\\c&H35E6A3&}"
WHITE_TAG = "{\\c&HFFFFFF&}"


def fmt_inline(text: str) -> str:
    """'chia **5 thành phần**' → từ khóa màu lime trong pill."""
    text = text.replace("\\N", "\n")
    text = re.sub(r"\*\*(.+?)\*\*", lambda m: LIME_TAG + m.group(1) + WHITE_TAG, text)
    return text.replace("\n", "\\N")


def build_ass(v: dict, dur: float) -> str:
    ev = []
    outro_t0 = dur - float(v.get("outro", {}).get("secs", 3)) if v.get("outro") else dur
    for s in v["subs"]:
        t1 = min(s["t1"], outro_t0 - 0.2)          # subs không lấn vào outro
        if t1 - s["t0"] < 0.4:
            continue
        txt = fmt_inline(s["text"])
        ev.append(f"Dialogue: 0,{fmt_ass(s['t0'])},{fmt_ass(t1)},Pill,,0,0,0,,{txt}")
    cta = v["cta"]
    ev.append(
        f"Dialogue: 1,{fmt_ass(cta['t0'])},{fmt_ass(dur)},CTA,,0,0,0,,"
        f"{cta['line1']}\\N{{\\fs44}}{cta['line2']}"
    )
    if v.get("hook_intro"):
        ev.insert(0, f"Dialogue: 2,0:00:00.00,{fmt_ass(min(1.8, dur / 4))},Hook,,0,0,0,,"
                     f"{{\\fad(160,220)}}{v['hook_intro']}")
    if v.get("outro"):
        o = v["outro"]
        t0 = dur - float(o.get("secs", 3))
        ev.append(f"Dialogue: 3,{fmt_ass(t0)},{fmt_ass(dur)},Outro,,0,0,0,,"
                  f"{{\\fad(240,0)}}{o['text']}")
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
    show_wave = bool(v.get("waveform"))
    show_music = bool(v.get("music"))

    # 3) ghép
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(mp4),
        "-framerate", str(FPS), "-i", str(code_dir / "%05d.png"),
        "-f", "lavfi", "-i", "color=c=0x0D1117:s=1080x1920:r=25",
    ]
    if badge:
        cmd += ["-i", str(badge)]
    if show_music:
        # pad ambient tự synth (hợp âm C3-G3-E4, LFO sóng) — không bản quyền, duck theo giọng
        pad = (
            "aevalsrc="
            "0.07*sin(2*PI*130.81*t)*(0.6+0.4*sin(2*PI*0.11*t))"
            "+0.05*sin(2*PI*196.00*t)*(0.6+0.4*sin(2*PI*0.07*t+1.5))"
            "+0.04*sin(2*PI*329.63*t)*(0.6+0.4*sin(2*PI*0.05*t+3))"
            f":s=48000:d={dur:.2f}"
        )
        cmd += ["-f", "lavfi", "-i", pad]

    chain = (
        "[0:v]split=2[bgsrc][fgsrc];"
        "[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,"
        "crop=1080:1920,boxblur=30:2,eq=brightness=-0.28:saturation=0.65,"
        "crop=1080:1120:0:400[bg];"
    )
    if v.get("kenburns"):
        # zoom chậm (ken burns) trên footage: 1.0 -> ~1.07 trong suốt clip
        chain += (
            "[fgsrc]scale=2200:-2,"
            "zoompan=z='min(1+0.00045*in,1.07)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
            ":d=1:s=1080x608:fps=25[fg];"
        )
    else:
        chain += "[fgsrc]scale=1080:-2[fg];"
    chain += (
        "[2:v][1:v]overlay=0:0[c1];"
        "[c1][bg]overlay=0:800[c2];"
        "[c2][fg]overlay=(W-w)/2:1080[c3];"
    )
    last = "c3"
    if badge:
        chain += f"[{last}][3:v]overlay=170:832[c4];"
        last = "c4"
    mid_clean = bool(v.get("mid_clean"))
    if mid_clean:
        chain += f"[{last}]drawbox=x=0:y=800:w=1080:h=280:color=0x0D1117@0.82:t=fill[mc];"
        last = "mc"
    if show_wave:
        wave_y = int(v.get("waveform_y", 986))
        chain += f"[{last}]drawbox=x=90:y={wave_y - 6}:w=900:h=56:color=0x0D1117@0.45:t=fill[wbg];"
        last = "wbg"

    # audio: asplit MỘT lần, các nhánh dùng [aw] (waveform), [ak] (duck key), [al] (giọng)
    n_split = 1 + (1 if show_wave else 0) + (1 if show_music else 0)
    audio_tail = "[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
    if n_split == 3:
        idx_music = 3 + (1 if badge else 0)   # pad luôn là input sau canvas + (badge)
        voice_fade = ""
        if v.get("outro"):
            voice_fade = f"afade=t=out:st={dur - 2.5:.2f}:d=2.5,"
        chain += f"[0:a]asplit=3[aw][al0][ak];[al0]{voice_fade}asetpts=PTS-STARTPTS[al];"
        chain += "[aw]showwaves=s=900x44:mode=cline:colors=0xFFFFFF:rate=25[wave];"
        chain += f"[{last}][wave]overlay=x=(W-w)/2:y={int(v.get('waveform_y', 986))}:shortest=1[wv];"
        last = "wv"
        chain += (
            f"[{idx_music}:a]volume=0.45,afade=t=in:d=2,afade=t=out:st={dur - 3:.2f}:d=3[mus];"
            f"[mus][ak]sidechaincompress=threshold=0.035:ratio=8:attack=80:release=600[md];"
            "[md]lowpass=f=1200,aresample=48000,aformat=channel_layouts=stereo[mdf];"
            "[mdf][al]amix=inputs=2:duration=first:normalize=0[amx];"
        )
        audio_tail = "[amx]loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
    elif show_wave:
        chain += "[0:a]asplit=2[aw][al];"
        chain += "[aw]showwaves=s=900x44:mode=cline:colors=0xFFFFFF:rate=25[wave];"
        chain += f"[{last}][wave]overlay=x=(W-w)/2:y={int(v.get('waveform_y', 986))}:shortest=1[wv];"
        last = "wv"
        audio_tail = "[al]loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
    if v.get("gradient"):
        chain += f"[{last}]drawbox=x=0:y=1079:w=1080:h=3:color=0xa3e635@0.85:t=fill[gb];"
        last = "gb"
    chain += f"[{last}]ass={ass_path.relative_to(out_buoi).as_posix()}[vout];{audio_tail}"
    cmd += ["-filter_complex", chain, "-map", "[vout]", "-map", "[aout]",
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
