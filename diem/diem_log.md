# DIEM LOG — loop cải tiến video (thang mở rộng 140 từ E13)

Metric duy nhất: rubric.md (100 điểm). Best hiện tại ghi đầu bảng.

| Vòng | Cải tiến | Điểm | Keep? | Best |
|---|---|---|---|---|
| E0 | Baseline (video S06 đã duyệt 01/11) | 86 | ✔ | 86 |
| E1 | Badge "AN" tròn viền lime mép trái pill | 87 | ✔ | 87 |
| E2 | Ghost lines + highlight dòng đang gõ | 90 | ✔ | 90 |
| E3 | Waveform đè slide footage (y=1520) | 90 | ✗ discard | 90 |
| E3b | Waveform vào dải mờ giữa (y=986) | 91 | ✔ | 91 |
| E4 | Nền đặc #0d1117 dải giữa — hết chữ nhòe | 92 | ✔ | 92 |
| E5 | CTA MarginV 185 — hết đè chrome video | 93 | ✔ | 93 |
| E6 | Auto-sync v1: mọi dòng dồn t0=0.5 (khối gộp lớn) | 93 | ✗ discard | 93 |
| E6b | Cửa sổ trượt: 5 dòng key dồn cùng 11.2 | 93 | ✗ discard | 93 |
| E6c | Auto-sync + stagger 2.5s tự dàn trải | 95 | ✔ | 95 |
| E8 | Verify audio ebur128: I=-15.9 LUFS, LRA 5.6 | 97 | ✔ | 97 |
| E9 | Auto-subs v1: từ méo + dòng tràn | 94 | ✗ discard | 97 |
| E10 | gen_subs tách câu + 4 term mới | 95 | ✗ discard | 97 |
| E11 | LLM polish subs (claude haiku, giữ timing) | 98 | ✔ | 98 |
| E12 | Window sync: nhóm 5 phần ép vào 18.9-25.0 | 100/100 | ✔ | 100 |
| — | THANG MỞ RỘNG 140 (M11-M14) — v10 chấm lại: M11:2 M12:3 M13:4 M14:3 => 112/140 | 112 | ✔ | 112 |
| E13 | Nhạc nền synth C3-G3-E4 + sidechain duck (I=-16.0 LUFS) | 120 | ✔ | 120 |
| E14b | Hook intro lime 1.8s đầu fade-in nêu lợi ích | 127 | ✔ | 127 |
| E15 | Ken burns zoom footage 1.0→1.07 (M13) | **133** | ✔ best | **133** |

## E0 — Baseline: 86 điểm (tag v0)

Chấm trên diem/E0_baseline/ (ffprobe: 1080x1920, 50.00s — chuẩn).

| # | Tiêu chí | Điểm | Lý do trừ |
|---|---|---|---|
| 1 | Layout cân bằng | 9 | vùng code y 400-800 trống ~18% (4 dòng xong sớm) |
| 2 | Sub pill | 9 | ok 2 dòng, đè ranh đẹp; badge thiếu (so mẫu fb2) |
| 3 | Code sync lời nói | 7 | timing hand-tune khớp ý chính, lệch ±3-5s từng câu |
| 4 | Font tiếng Việt | 10 | Consolas đủ dấu, không lỗi |
| 5 | CTA + safe zone | 9 | pill rõ; đè 28px chrome video dạy |
| 6 | Không lộ học viên | 10 | đã zoom xác nhận webcam = mentor |
| 7 | Kỹ thuật render | 9 | dải blur giữa còn chữ mờ nhòe |
| 8 | Giữ chân/sáng tạo | 7 | typing đơn điệu, không hiệu ứng khác |
| 9 | Audio loudnorm | 8 | loudnorm có trong filter; chưa nghe trực tiếp (unverified) |
| 10 | Đóng gói | 8 | json điều khiển; subs vẫn phải viết tay từng vòng |
| | **Tổng** | **86** | |

## E1 — Badge "AN": 87 điểm (tag v1, ffprobe 50.00s)

- Mục 2 sub pill: 9 → 10 (badge tròn viền lime đúng mẫu fb2, không che chữ).
- Còn lại giữ nguyên E0. Bằng chứng: diem/E1/CODES06_{d,g,c}.png.
- Best → `output/best.mp4`.

## E2 — Ghost lines + highlight: 90 điểm (tag v2, ffprobe 50.00s)

- Mục 1 layout: 9 → 10 (ghost lấp vùng code trống, khuôn 8 dòng đầy).
- Mục 8 giữ chân: 7 → 9 (ghost + highlight + typing 3 lớp nhịp).
- Lỗi nhỏ ghi nhận: highlight rỗng 0.3s đầu mỗi dòng (chars=0) — chấp nhận.
- Best → output/best.mp4.

## E3/E3b — Waveform: E3 90 discard; E3b 91 keep (tag v3, ffprobe 50.00s)

- E3: waveform đè slide NotebookLM → mục 7 trừ; đồng điểm → discard theo luật.
- E3b: dời y=986 vào dải mờ — mục 8: 9 → 10 (4 lớp nhịp: typing+highlight+ghost+waveform).
- **Cải tiến đặc biệt đầu tiên → output/best.mp4** (Telegram chưa cấu hình).

## E4 — Mid clean: 92 điểm (tag v4, decode kiểm tra sạch)

- Mục 7: 9 → 10 (drawbox @0.82 phủ blur bg; chữ nhòe chỉ còn vệt cực mờ).
- Ghi chú vận hành: file E4 hỏng NAL khi lần render trước bị cancel giữa chừng
  → luật: vòng bị cancel phải xóa output trước khi render lại cùng tên.
- Bảng điểm chi tiết hiện: 1:10 2:10 3:7 4:10 5:9 6:10 7:10 8:10 9:8 10:8.

## E6c — Auto-sync + stagger: 95 điểm (tag v6)

- Mục 3: 7 → 9 (t0 từ lời nói thực, cửa sổ trượt cặp cue + stagger 2.5s).
- Mục 10: 8 → 9 (gen_timing.py tái sử dụng mọi clip sau — khỏi hand-tune).
- 2 vòng fail trước đó là bài học: khối utterance gộp lớn làm keyword match sai;
  cửa sổ trượt + stagger mới đúng.
- Timeline tự sinh: 0.5 / 11.2 / 13.7 / 16.2 / 18.7 / 21.2 / 27.4.

## E8 — Audio verified: 97 điểm (tag v8, không cần render lại)

- ebur128 đo trên E6c: I = -15.9 LUFS (mục tiêu -16, lệch 0.1 LU), LRA 5.6.
- Mục 9: 8 → 10. Best vẫn clip E6c (output/best.mp4).

## E9-E11 — Auto-subs pipeline hoàn chỉnh (tag v9)

- E9 94 discard: verbatim ASR méo + tràn dòng. E10 95 discard: sửa gen_subs + term vẫn thua văn phong tay.
- E11 98 keep: gen_subs → claude haiku polish (GIỮ nguyên timing gốc) → ghép json.
  Pipeline giờ: gen_timing.py (timing) + gen_subs.py (nháp) + 1 lệnh claude -p (polish) — hết viết tay.
- Trần thực tế 98: mục 3 (sync) dừng 9 vì mentor S06 không đọc tên từng phần.

## E12 — Window sync: 100/100 (tag v10, ffprobe 50.00s, decode sạch)

- gen_timing.py --window 18.9:25.0: 5 dòng PCTPR dàn đều đúng câu mentor nói
  "chia lời nhắc thành 5 thành phần"; [R] Rules riêng 27.4 theo câu sau.
- Mục 3: 9 → 10. TẤT CẢ 10 mục = 10 — TRẦN RUBRIC.
- best_final cần render lại từ E12 preset faster khi đưa vào đăng.

## E13 — Nhạc nền + duck: 120/140 (tag v11, integrity + ebur128 verified)

- M11: 2 → 10 (pad aevalsrc tự synth — không bản quyền; sidechain threshold 0.035;
  lowpass 1200; amix normalize=0; loudnorm ra I=-16.0 chính xác).
- Pitfall mới: idx input nhạc phải = 3 + (1 nếu badge) — đếm nhầm là bind error.
- Best → output/best.mp4.

## E14b — Hook intro: 127/140 (tag v12)

- M12: 3 → 10 (chữ Hook 74px lime nền tối, fade 160/220ms, nêu đúng lợi ích 5 phần; code đang ghost nên không che gì).
- Pitfall vận hành: file output bị ffmpeg cũ giữ lock → render bằng tên mới thay vì chờ.

## E15 — Ken burns: 133/140 (tag v13, integrity + 50.00s)

- M13: 4 → 10 (zoompan 2200px nguồn, zoom 1.0→1.07 center, không méo).

## PHIÊN 1 ĐÓNG TẠI ĐÂY (quota zai ~42%)

Best: 97/100 (v8). Tiến trình: 86 → 87 → 90 → (91 fail 90) → 91 → 92 → 93 → 95 → 97.
10 thí nghiệm, 3 discard (E3, E6, E6b). Phiên sau đọc program.md + backlog dưới.

## Backlog vòng kế (1 vòng = 1 cải tiến)

- E1: badge "AN" tròn bên trái pill + nền pill đặc hơn (so mẫu fb2) — mục 2
- E3: [ĐANG LÀM] waveform audio thật (showwaves) trước CTA — mục 8
- E7: intro hook 1.2s fade-in chữ to — mục 8
- E8: verify audio mean_volume + chỉnh loudnorm — mục 9
- E9: subs auto-sinh từ VTT + chỉ duyệt tay — mục 10
- E10: final render winner preset faster — mục 7
- E5: CTA nhấp nháy nhẹ \f + viền pill tương phản — mục 5, 8
- E6: tint viền phân tách 3 tầng, xử dải blur bẩn — mục 7
- E7: auto-sync code_lines từ cue VTT — mục 3, 10
- E8: nhạc nền duck giọng (sidechain) — mục 9
- E9: typing theo cụm từ (word-by-word) — mục 8
- E10: render final winner preset faster — mục 7

---
## CHẤM LẠI best v10 theo thang 140 (điểm khởi đầu E13)

M1-M10 = 100 (giữ nguyên). M11 nhạc nền: 2 (chưa có). M12 hook intro: 3 (không có).
M13 chuyển động: 4 (chỉ typing + waveform, footage tĩnh). M14 kết clip: 3 (đứt đột ngột).
=> **Khởi đầu: 112/140** (tag v10).
