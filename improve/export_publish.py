#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""export_publish.py — xuất gói đăng tải từ variant best:
   caption.srt (phụ đề riêng cho nền tảng) + poster.jpg (khung đại diện).
Dùng: python export_publish.py <variant.json> <clip.mp4> -o <thu_muc_xuat>
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path


def fmt_srt(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("variant")
    p.add_argument("clip")
    p.add_argument("-o", "--out", required=True)
    a = p.parse_args()

    v = json.loads(Path(a.variant).read_text(encoding="utf-8"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    # 1) SRT từ subs (bỏ marker **, xuống dòng thànhSpace)
    srt_lines = []
    for i, s in enumerate(v["subs"], 1):
        txt = s["text"].replace("**", "").replace("\n", " ")
        srt_lines.append(f"{i}\n{fmt_srt(s['t0'])} --> {fmt_srt(s['t1'])}\n{txt}\n")
    (out / "caption.srt").write_text("\n".join(srt_lines), encoding="utf-8")

    # 2) poster từ giây 1.2 (sau hook, code hiện header)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "1.2", "-i", a.clip,
                    "-frames:v", "1", "-q:v", "2", str(out / "poster.jpg")], check=True)

    # 3) metadata đăng
    meta = {
        "title": v["nguon"].get("title", ""),
        "caption_tiktok": v["cta"]["line1"] + " " + v["cta"]["line2"],
        "duration_s": round(v["nguon"]["end"] - v["nguon"]["start"], 2),
        "resolution": "1080x1920",
        "khung_gio_dang": "19h00-21h30 TikTok / 20h00 FB Reels",
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[xong] {out}/: caption.srt + poster.jpg + meta.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
