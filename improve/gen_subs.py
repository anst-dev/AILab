#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gen_subs.py — auto-sinh subs pill từ VTT (thay viết tay).

Gom cue mentor trong khoảng clip thành câu 12-40 ký tự/dòng, tối đa 2 dòng,
bỏ câu < 1.2s và filler ("Dạ", "Ừm"...). Đầu ra: mảng subs gắn thẳng vào variant.
Người duyệt chỉ sửa từ sai — không gõ lại từ đầu.

Dùng: python gen_subs.py <vtt> <variant.json> -o out.json [--max-chars 34]
"""
import argparse
import json
import sys
import textwrap
from pathlib import Path

sys.path.insert(0, r"D:\KENH_AI\tools")
from shorts_pipeline import apply_term_fixes, load_term_fixes, parse_vtt, is_mentor  # noqa: E402

FILLER = {"dạ", "da", "ừm", "um", "ờ", "ơ", "rồi", "okay", "ô kê", "đấy", "vâng"}


def clean(text: str) -> str:
    t = " ".join(text.split()).strip(" ,.!")
    words = t.split()
    # bỏ filler đầu/cuối câu
    while words and words[0].lower().strip(",.") in FILLER:
        words.pop(0)
    while words and words[-1].lower().strip(",.") in FILLER:
        words.pop()
    return " ".join(words)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("vtt")
    p.add_argument("variant")
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--max-chars", type=int, default=34)
    p.add_argument("--min-dur", type=float, default=1.2)
    p.add_argument("--mentor", default="Tuan Anh")
    a = p.parse_args()

    v = json.loads(Path(a.variant).read_text(encoding="utf-8"))
    src = v["nguon"]
    s0, s1 = float(src["start"]), float(src["end"])
    fixes = load_term_fixes()

    cues = [c for c in parse_vtt(Path(a.vtt))
            if c["end"] > s0 and c["start"] < s1 and is_mentor(c["speaker"], a.mentor)
            and c["end"] - c["start"] >= a.min_dur]

    subs = []
    for c in cues:
        t = clean(apply_term_fixes(c["text"], fixes))
        if len(t) < 8:
            continue
        t0 = round(max(c["start"] - s0, 0.0), 1)
        t1 = round(min(c["end"] - s0, s1 - s0), 1)
        if subs and t0 - subs[-1]["t1"] < 0.4 and len(subs[-1]["text"]) + len(t) <= a.max_chars:
            subs[-1]["text"] += " " + t
            subs[-1]["t1"] = t1
            continue
        subs.append({"t0": t0, "t1": t1, "text": t})

    # xuống dòng ≤ max-chars, tối đa 2 dòng; câu dài hơn → tách thành 2 subs liên tiếp
    out2 = []
    for s in subs:
        words = s["text"].split()
        if len(s["text"]) <= a.max_chars * 2:
            lines = textwrap.wrap(s["text"], width=a.max_chars)
            s["text"] = "\n".join(lines[:2]) if len(lines) > 1 else s["text"]
            out2.append(s)
            continue
        # chia theo từ thành 2 nửa, thời gian chia tỉ lệ số ký tự
        half = max(1, len(words) // 2)
        w1, w2 = " ".join(words[:half]), " ".join(words[half:])
        ratio = len(w1) / max(len(w1) + len(w2), 1)
        mid = round(s["t0"] + (s["t1"] - s["t0"]) * ratio, 1)
        for txt, t0, t1 in ((w1, s["t0"], mid), (w2, mid, s["t1"])):
            lines = textwrap.wrap(txt, width=a.max_chars)
            if len(lines) > 2:
                lines = lines[:1] + [" ".join(lines[1:])]
            out2.append({"t0": t0, "t1": t1, "text": "\n".join(lines)})
    subs = out2

    v["subs"] = subs
    Path(a.out).write_text(json.dumps(v, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[xong] {len(subs)} subs auto -> {a.out}")
    for s in subs:
        print(f"  [{s['t0']:5.1f}-{s['t1']:5.1f}] {s['text'].replace(chr(10), ' / ')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
