# RUBRIC — metric duy nhất của loop (100 điểm)

Chấm bằng 3 frame (đầu/giữa/cuối) + ffprobe + review diff. Mỗi mục 0-10, không làm tròn.

| # | Tiêu chí | 10 điểm khi | Trừ điểm khi |
|---|---|---|---|
| 1 | Layout 3 tầng cân bằng | mỗi vùng dùng hết, trống vô ích ≤ 15% vùng | vùng code/footage trống lớn, lệch tỉ lệ |
| 2 | Sub pill viết tay | ≤2 dòng, ≤32 ký tự/dòng, đè đúng ranh giới, đọc nét | sai dấu, tràn, che nội dung chính |
| 3 | Code typing đồng bộ lời nói | dòng xuất hiện đúng lúc mentor nhắc ý đó (±2s) | lệch xa, xuất hiện trước khi nhắc |
| 4 | Font tiếng Việt | đủ dấu mọi chữ, mono thống nhất | ô vuông, dấu lỗi, lẫn font |
| 5 | CTA nổi + safe zone | pill xanh đọc rõ trong 0.3s, đáy chừa ≥150px | chìm, sát mép, bị UI TikTok che |
| 6 | KHÔNG lộ học viên (loại ngay nếu lộ) | chỉ mentor | thấy mặt/tên học viên rõ → tổng điểm = 0 |
| 7 | Kỹ thuật render | 1080x1920, duration ±0.5s chuẩn, không viền/méo | lệch chuẩn, band bẩn, viền đen |
| 8 | Giữ chân / sáng tạo | ≥1 hiệu ứng nhịp (typing, waveform, highlight…) | tĩnh lặng, đơn điệu |
| 9 | Audio | loudnorm I=-16, giọng rõ, không clipping | nhỏ/lớn bất thường, vỡ tiếng |
| 10 | Đóng gói tái sử dụng | 1 file json điều khiển, lệnh 1 dòng tái tạo | hard-code rải rác, không tái tạo được |

**Tổng = cộng 10 mục.** Mục 6 lộ = 0 toàn bài.

## Chấm điểm bằng chứng bắt buộc

- 3 frame đọc trực tiếp (d/g/c) — không chấm mù.
- `ffprobe` width/height/duration ghi vào log.
- Mục trừ phải viết lý do 1 câu trong `diem_log.md`.

## MỞ RỘNG v2 (02/11 — user ủy quyền "làm tới khi limit"): 4 tiêu chí mới

| # | Tiêu chí | 10 điểm khi | Trừ khi |
|---|---|---|---|
| 11 | Nhạc nền + duck giọng | pad/nhạc volume thấp, tự nhỏ khi mentor nói (sidechain), không đè lời | đè lời, tắt hẳn, lặp nhàm |
| 12 | Hook intro 3s đầu | chữ to fade-in nêu lợi ích, khán giả hiểu xem để làm gì trong 3s | không có, che nội dung |
| 13 | Chuyển động khung hình | zoom/pan nhẹ (ken burns) trên footage hoặc code, không tĩnh hoàn toàn | rung, zoom quá mức |
| 14 | Kết clip có chủ đích | outro riêng (fade + lời hẹn/CTA nhắc lại), không đứt đột ngột | cắt đen sỗ sàng |

**Trần mới: 140 điểm.** Best v10 chấm lại theo thang mới làm điểm khởi đầu.

## MỞ RỘNG v3 (E19): +1 tiêu chí — trần 150

| 15 | Code đa sắc + số dòng | key xanh dương #79c0ff, nội dung trắng, comment xanh lá, số dòng mờ bên trái | đơn sắc trắng |

## MỞ RỘNG v4 (E20): +M16 typing nhịp từ + flash viền hoàn thành (trần 160)

## MỞ RỘNG v5 (E21): +M17 gradient phân tầng (trần 170)

## MỞ RỘNG v6 (E22): +M18 chip tiến trình n/5 (trần 180)

## MỞ RỘNG v7 (E23): +M19 badge pulse nhịp 2s (trần 190)

## MỞ RỘNG v8 (E24): +M20 pill pop-in scale 82→100 (trần 200)

## MỞ RỘNG v9 (E25): +M21 chấm REC nhấp nháy (trần 210)

## MỞ RỘNG v10 (E26b): +M22 checklist tick 5 phần (trần 220)

## MỞ RỘNG v11 (E27): +M23 chip pop khi tăng phần (trần 230)

## MỞ RỘNG v12 (E28): +M24 watermark kênh (trần 240)

## MỞ RỘNG v13 (E29): +M25 gói publish SRT + poster + meta (trần 250)

## MỞ RỘNG v14 (E30): +M26 final render medium + verify full (trần 260)

## MỞ RỘNG v15 (E31): +M27 ken burns hai pha in/out (trần 260)

## MỞ RỘNG v16 (E32): +M28 bộ A/B hook 2 biến thể (trần 270)

## MỞ RỘNG v17 (E33): +M29 tick SFX 880Hz decay (trần 280)

## MỞ RỘNG v18 (E34): +M30 mid-card Lưu lại (trần 290)

## MỞ RỘNG v19 (E35): +M31 countdown 3-2-1 trước outro (trần 310)

## MỞ RỘNG v20 (E36): +M32 final render + publish pack chu kỳ (trần 320)

## MỞ RỘNG v21 (E37): +M33 ticker status bar trong khung code (trần 330)

## MỞ RỘNG v22 (E39): +M35 zoom breathe theo LFO pad (trần 350)

## MỞ RỘNG v23 (E40): +M36 story cut-down 15s (trần 360)
