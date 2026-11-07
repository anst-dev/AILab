# HƯỚNG ĐI — vòng lặp cải tiến AI Lab

> Cập nhật 07/11/2026 sáng, sau phiên chạy đêm 06→07/11. Nguồn: `knowledge/improvements_log.jsonl`,
> `git log`, TASK.md, LOG.md. Giờ trong file là giờ VN (UTC+7); JSONL ghi UTC.

## 1. Đêm qua đã làm được gì

**Kết quả:** 72 keep được merge vào `main`, hết sạch backlog TASK.md (23/23 mục [x]), 3 nhánh ZCode (zc1–zc3) cùng zc5/zc6 đã merge, EVAL PASS ở mọi lần merge.

| Giờ (VN) | Chuyện gì xảy ra | Số liệu |
|---|---|---|
| 00:21 | Snapshot lab-dev + `evaluate.js` pass-gate + backlog 5 mục | baseline `5a72441` |
| 00:24–01:53 | **Đợt 1**: agy×3 + ZCode làm hết backlog 1–7, rồi tự đề xuất (chat CLI, chart, harvest) | ~48 keep |
| 01:53–04:56 | **Hết quota agy (429 RESOURCE_EXHAUSTED)** — 3 agent quay vòng rỗng ~3 giờ | ~4.000 dòng no-change, ~40 commit `auto-log` vô nghĩa |
| 04:57–05:46 | **Đợt 2** sau khi quota reset: mục 8–23 (xóa phiên, diff, copy, lọc/tìm kiếm, export) | ~24 keep |
| ~05:47 | Hết quota lần 2 (reset khoảng **09:57** sáng nay) | |
| 06:30 | Phiên chính: thêm **circuit breaker** `noChangeLimit=15`, dọn JSONL còn 228 dòng, viết lại README | `13fa6ef` |
| 06:33 | ⚠️ Cron `auto-log` **ghi lại 4.392 dòng rác** vào JSONL ngay sau khi dọn | `aea1f2d` |
| 06:35 | SETUP.md + HUONG_DI.md bản đầu | `ab05878` |

**Tỷ lệ trong JSONL hiện tại (4.620 dòng):** keep 72 · conflict 42 · committed 102 · error 4 · **no-change 4.392 (95%)**.

Tính năng bot tự viết: rebaseline, export CSV/JSON/JSONL, SVG score chart (baseline, best, legend, avg, click → log), knowledge viewer + tìm kiếm, diff/log modal có copy, xóa phiên, ~20 lệnh `chat.js`, `logImprovement()`, `harvest.js` (stats/list/lọc/export). Chi tiết: README mục "Tính năng do bot tự thêm".

## 2. Bài học rút ra

1. **Quota là nút thắt, không phải ý tưởng.** Chỉ ~2,5 giờ trong ~6 giờ là làm việc thật; thời gian còn lại agent chỉ nhận lỗi 429. Circuit breaker (đã thêm 06:30) phải chặn được đúng việc này.
2. **Pipeline log tự làm bẩn chính nó.** `harvest`/`auto-log` đưa lại các dòng no-change (không có commit nên dedupe `commit+iter+status` không bắt được) → dọn xong 3 phút là bẩn lại. Commit `auto-log` mỗi 5 phút cũng làm rác git history.
3. **Bão hòa giá trị biên.** Đợt 2 toàn là "thêm filter/option/export" cho thứ đã có (harvest.js, chat CLI, web UI). Bot cứ chạy tiếp thì chỉ sinh thêm biến thể của cùng một thứ.
4. **72 keep, 0 regression test.** Ở repo gốc không có `test/` (chỉ còn trong `agent-swarm/test/`). `evaluate.js` chỉ smoke test → không ai bảo đảm các tính năng cũ còn chạy.
5. **42 conflict.** Chống trùng ý tưởng có hoạt động, nhưng 3 agent cùng sửa `chat.js`/`app.js`/`server.js` nên vẫn đụng nhau nhiều.

## 3. Cần làm tiếp (ưu tiên giảm dần)

### H0 — VỆ SINH LOG — DONE (07/11, phiên chính)
- [x] `harvest.js` bỏ dòng `no-change` + lỗi quota (429/RESOURCE_EXHAUSTED) khi gom **và** tự dọn chúng khỏi log cũ.
- [x] JSONL về 228 dòng sạch; chạy harvest lần 2: +0 dòng.
- [x] `postmerge.example.json`: chỉ commit/push khi JSONL thực sự đổi. (Cron auto-log trên máy chạy đêm qua không có trong repo → sửa tay theo mẫu này.)
- [x] Circuit breaker có test: fake-agent toàn no-change, `noChangeLimit=4` → dừng sau ~14s.

### H1 — TRẢ NỢ CHẤT LƯỢNG — DONE phần nền (07/11, phiên chính)
- [x] H1a: `test/` ở gốc, `npm test` PASS. Chạy lại bộ test cũ lộ **3 lỗi thật** do bot gây ra, đã sửa:
  - `logImprovement` ghi `knowledge/` vào **dự án của người dùng** → giờ là option `knowledgeLog`, mặc định tắt.
  - Bot bỏ ghi `server.json` khi có `PORT` (để evaluate khỏi đè server thật) → `--background/--status/--stop` hỏng, server nền mồ côi. Khôi phục; evaluate dùng `SWARM_DATA_DIR` tạm.
  - Gợi ý thư mục autoresearch chỉ tìm `../autoresearch` → tìm cả `./autoresearch`.
- [x] H1b: `evaluate.js` chạy `test/*.test.js` + e2e + api + coordinator (~3,5 phút; `EVAL_QUICK=1` để chỉ smoke).
- [x] H1d: 4 nhánh rescue đều đã có bản tương đương trên main (`21bc701`, `ebdaf3d`, `6bcac42`) → không cần cherry-pick, xóa được.
- [ ] H1c (giao bot): test cho route/CLI bot đã viết — rebaseline, export.csv/json/jsonl, DELETE run, chat.js `--diff --commit`, harvest `--list/--stats` lọc. Mỗi lượt 1 file `test/<tên>.test.js`.

### H2 — FLOW SẢN PHẨM END-TO-END — BỊ CHẶN
`lab-video/` và `lab-dev/` trên GitHub chỉ là gitlink (không có `.gitmodules`, không URL) → máy khác clone về rỗng.
Cần đẩy lab-video lên 1 repo riêng rồi `git submodule add <url> lab-video` (hoặc gộp hẳn vào repo này) trước khi làm H2.
`node src/chat.js "lam video moi tu buoi BH1593477 chu de X"` → coordinator gọi pipeline lab-video
(gen_timing → render → export_publish) → trả đường dẫn gói publish. Đây là demo SaaS thật.
Xem `docs/TICH_HOP_LAB_VIDEO.md`.

### H3 — DASHBOARD DỮ LIỆU (rảnh thì làm)
Tỷ lệ keep/conflict theo bot, keep/giờ *thực làm việc*, chủ đề bão hòa — vẽ lên web UI bằng chart sẵn có.

### ĐÓNG BĂNG
Không nhận thêm "filter/option/export" cho harvest.js, chat CLI, knowledge viewer cho tới khi H1c xong.

### Cấu hình phiên bot tiếp theo
`evalCommand=node evaluate.js` · `evalTimeoutMin=8` (test mất ~3,5 phút) · `timeLimitMin=5` · `noChangeLimit=15` ·
`protectedFiles=evaluate.js,test/e2e.js,test/api.js,test/coordinator.js,test/regression.test.js` (bot thêm test mới, không sửa test cũ) ·
`knowledgeLog=knowledge/improvements_log.jsonl` · publishCommand theo `postmerge.example.json`. TASK.md: thay backlog bằng H1c.

## 4. Luật vòng lặp 30 phút (cron)

1. Kiểm tra quota agy trước khi spawn; đang 429 → **không spawn**, ghi 1 dòng "chờ quota tới HH:MM" rồi thôi.
2. Chạy harvest (đã lọc no-change), đọc keep mới trong 30 phút qua.
3. Có ≥3 keep mới thuộc nhóm ĐÓNG BĂNG → bot đang lệch hướng: sửa TASK.md, chỉ để lại mục của H ưu tiên.
4. H hiện tại xong (mọi checkbox [x]) → chuyển sang H kế tiếp và cập nhật file này.
5. Spawn 1–2 sub-agent `quick` làm việc cụ thể của H ưu tiên. KHÔNG dùng claude/grok. Mỗi việc 1 worktree, commit, KHÔNG tự merge main (để phiên chính gộp).
6. Chỉ commit log khi có thay đổi thật.
