# HƯỚNG ĐI — vòng lặp cải tiến AI Lab (cập nhật mỗi 30 phút bằng cron)

## Phân tích data lúc 07/11 sáng (từ 228 dòng JSONL sạch)

| Nhận định | Bằng chứng |
|---|---|
| **Bão hòa chi phí thấp** | 10 keep cuối toàn là "thêm filter/option/export" cho thứ đã có (chat-cli 34 keep, web-ui 20) — giá trị biên giảm |
| **Nợ chất lượng nguy hiểm** | `test/` không tồn tại trong lab-dev (chỉ ở parent) — **72 keep merge bằng 0 regression test**; evaluate.js chỉ smoke test |
| **4 nhánh rescue bỏ quên** | `swarm/*-rescue-agent-{1-4,2-3,2-8,3-4}` chứa công việc dở có ý tưởng tốt |
| Điểm nghẽn sản phẩm thật | Flow end-to-end "1 lệnh → video mới" (lab-video) chưa nối qua chat CLI — đây là demo SaaS thật |

## Hướng hiện tại (ưu tiên giảm dần)

### H1 — TRẢ NỢ CHẤT LƯỢNG (đang làm — ưu tiên cao nhất)
Mục tiêu: `npm test` trong lab-dev phải CHẠY VÀ PASS, evaluate.js gọi test suite.
- H1a: copy `test/` từ parent (`AILab/agent-swarm/test/`) vào lab-dev, sửa import theo cấu trúc hiện tại, chạy pass.
- H1b: nâng `evaluate.js`: sau smoke test, chạy `node test/e2e.js` (exit 0 mới PASS).
- H1c: soi 4 nhánh rescue — cái nào salvage được thì cherry-pick, không thì xóa nhánh (ghi JSONL).

### H2 — FLOW SẢN PHẨM END-TO-END (sau khi H1 xong)
"node src/chat.js 'lam video moi tu buoi BH1593477 chu de X'" → tự gọi lab-video pipeline (gen_timing → render → export_publish) → trả đường dẫn gói publish. Đây là demo SaaS thật cho spec.

### H3 — DASHBOARD DỮ LIỆU (rảnh thì làm)
Thống kê JSONL: tỷ lệ keep theo bot, keep/giờ, chủ đề bão hòa — vẽ lên web UI bằng chart sẵn có.

## Luật vòng lặp 30 phút (cron)

1. Chạy harvest, đọc keep mới trong 30 phút qua.
2. Nếu ≥3 keep mới cùng nhóm đã bão hòa (chat-cli/web-ui filter...) → hạ ưu tiên nhóm đó, ghi vào đây.
3. Nếu H hiện tại xong (đánh dấu DONE) → chuyển ưu tiên cao nhất còn lại.
4. Spawn 1-2 sub-agent `quick` làm việc cụ thể của H ưu tiên.
5. KHÔNG dùng claude/grok. Mỗi việc 1 worktree riêng, commit, KHÔNG tự merge main (để phiên chính gộp).
