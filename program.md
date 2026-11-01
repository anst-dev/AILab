# PROGRAM — loop cải tiến video (triết lý karpathy/autoresearch)

Áp triết lý autoresearch: **1 file để sửa · 5 phút khóa cứng · 1 metric · giữ nếu cao hơn**.

## Luật không được phá

1. **prepare/ CỐ ĐỊNH** — variant_baseline.json (đoạn S06, 50s, BH1593477) + đường dẫn nguồn mp4/vtt. Không ai sửa, kể cả agent. Mọi thí nghiệm chấm trên CÙNG đoạn này.
2. **Mỗi vòng đúng 5 phút wall-clock** (`timeout 300` bọc lệnh render). Hết giờ dù dở: chấm trên phần có, ghi log, mở vòng mới. Không vòng nào vượt 5 phút.
3. **Một metric duy nhất**: điểm rubric 100 (10 tiêu chí × 10) trong `rubric.md`. Điểm ghi trong `diem/diem_log.md` kèm bằng chứng (frames). Không có metric phụ — không "nhìn có vẻ đẹp hơn".
4. **Giữ nếu cao hơn best hiện tại, bỏ nếu không**: vòng thắng → commit + tag `vN`. Vòng thua → vẫn commit (lịch sử thí nghiệm) nhưng best không đổi; renderer/variant quay về bản best cho vòng kế.
5. **Không dùng Grok CLI** trong mọi vòng. Được phép: Z.ai (phiên này), claude (cly), antigravity (agy — gia hạn token bằng cách chạy `agy` một lần).
6. Render vòng thử dùng `-preset ultrafast`; chỉ vòng final thắng mới render lại `-preset faster` để đăng.
7. Nếu agent đẻ ra ý tưởng cần sửa `prepare/` → viết thành thí nghiệm KHÔNG ĐƯỢC: ghi vào `backlog.md` chờ người thật quyết.

## Vòng làm việc (mỗi vòng 5 phút)

1. Chọn 1 cải tiến duy nhất từ backlog (mục `backlog.md`).
2. Sửa **một** trong: `improve/variant_N.json` hoặc `render_code_variant.py` (ghi rõ trong log).
3. Render + chấm trong timeout 300s.
4. Ghi `diem/diem_log.md`: vòng, cải tiến, điểm từng mục, tổng, keep/discard, bằng chứng.
5. Commit. Tag `vN` nếu là best mới.

## Trạng thái phiên CLI (kiểm bằng quota.py trước phiên mới)

```bash
python /d/KENH_AI/_hermes-notes/products/ai-cli-quota/scripts/quota.py
```

## Kênh nhận kết quả "cải tiến đặc biệt"

Chưa cấu hình Telegram. Vòng thắng mới → render `-preset faster` + copy sang
`output/best.mp4` (luôn giữ bản best mới nhất để người dùng mở xem trực tiếp).
Khi user cung cấp bot token + chat_id sau này → thêm gửi `sendVideo` Telegram.

## Tiếp nối phiên sau

Đọc `diem/diem_log.md` (best hiện tại + tag), đọc `backlog.md`, làm tiếp từ vòng kế.
