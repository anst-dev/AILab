#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gen_timing.py — auto-sync t0 của code_lines từ phụ đề VTT (thay hand-tune).

Mỗi code_line khai "sync": [từ khóa]. Script tìm utterance MENTOR đầu tiên
trong khoảng clip chứa từ khóa (đã khôi phục thuật ngữ) và đặt t0 = đầu utterance
trừ lead nhẹ (0.4s). Dòng không khớp giữ t0 cũ.

Dùng: python gen_timing.py <vtt> <variant.json> -o <variant_out.json>
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, r"D:\KENH_AI\tools")
from shorts_pipeline import apply_term_fixes, load_term_fixes, parse_vtt, is_mentor  # noqa: E402


def norm(s: str) -> str:
    return " ".join(s.lower().split())


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("vtt")
    p.add_argument("variant")
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--mentor", default="Tuan Anh")
    a = p.parse_args()

    v = json.loads(Path(a.variant).read_text(encoding="utf-8"))
    src = v["nguon"]
    s0, s1 = float(src["start"]), float(src["end"])
    fixes = load_term_fixes()

    cues = [c for c in parse_vtt(Path(a.vtt))
            if c["end"] > s0 and c["start"] < s1 and is_mentor(c["speaker"], a.mentor)]
    # cửa sổ match: cue đơn + cặp cue liền kề (gap <= 2s) — tránh khối khổng lồ
    windows = []
    for i, c in enumerate(cues):
        t1 = apply_term_fixes(c["text"], fixes)
        windows.append((c["start"], t1))
        if i + 1 < len(cues) and cues[i + 1]["start"] - c["end"] <= 2.0:
            windows.append((c["start"], t1 + " " + apply_term_fixes(cues[i + 1]["text"], fixes)))
    windows.sort(key=lambda w: w[0])
    utts = [[st, st, txt] for st, txt in windows]

    hits = 0
    STAGGER = 2.5  # giây giữa các dòng cùng khớp một cửa sổ
    used_windows: dict[float, int] = {}
    for ln in v.get("code_lines", []):
        kws = ln.get("sync")
        if not kws:
            continue
        for st, en, text in utts:
            if any(norm(k) in norm(text) for k in ([kws] if isinstance(kws, str) else kws)):
                base = round(max(st - s0 - 0.4, 0.0), 1)
                k = used_windows.get(base, 0)
                used_windows[base] = k + 1
                old = ln["t"]
                ln["t"] = round(base + k * STAGGER, 1)
                ln["_sync_hit"] = f"{old} -> {ln['t']} (win {base}#{k + 1})"
                hits += 1
                break

    Path(a.out).write_text(json.dumps(v, ensure_ascii=False, indent=2), encoding="utf-8")
    for ln in v.get("code_lines", []):
        if ln.get("_sync_hit"):
            print(f"  line '{ln['text'][:24]}': {ln['_sync_hit']}")
    print(f"[xong] sync {hits}/{sum(1 for l in v.get('code_lines', []) if l.get('sync'))} dòng -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
