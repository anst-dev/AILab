# DIEM LOG — loop cải tiến video

Metric duy nhất: rubric.md (100 điểm). Best hiện tại ghi đầu bảng.

| Vòng | Cải tiến | Điểm | Keep? | Best |
|---|---|---|---|---|
| E0 | Baseline (video S06 đã duyệt 01/11) | 86 | ✔ | 86 |
| E1 | Badge "AN" tròn viền lime mép trái pill | **87** | ✔ best | **87** |

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

## Backlog vòng kế (1 vòng = 1 cải tiến)

- E1: badge "AN" tròn bên trái pill + nền pill đặc hơn (so mẫu fb2) — mục 2
- E2: ghost lines (dòng mờ trước khi gõ) + highlight dòng đang gõ — mục 1, 8
- E3: waveform audio thật (showwaves) trước CTA — mục 8 (như fb2)
- E4: intro hook 1.2s đầu: chữ to fade-in — mục 8
- E5: CTA nhấp nháy nhẹ \f + viền pill tương phản — mục 5, 8
- E6: tint viền phân tách 3 tầng, xử dải blur bẩn — mục 7
- E7: auto-sync code_lines từ cue VTT — mục 3, 10
- E8: nhạc nền duck giọng (sidechain) — mục 9
- E9: typing theo cụm từ (word-by-word) — mục 8
- E10: render final winner preset faster — mục 7
