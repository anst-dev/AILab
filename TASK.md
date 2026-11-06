# TASK — 3 bot tự cải tiến phần mềm agent-swarm

Bạn đang trong 1 worktree. Mỗi lượt 5 phút: **implement ĐÚNG 1 tính năng backlog** dưới đây,
theo thứ tự ưu tiên, sao cho `node evaluate.js` vẫn PASS (app phải chạy được).

## Backlog (làm lần lượt, đánh dấu [x] vào file này khi xong — commit kèm)

1. [x] **publishCommand** — tùy chọn mới trong swarm.js normalizeOptions (`raw.publishCommand`,
   string, rỗng mặc định). Khi 1 agent được KEEP và `this.best` cập nhật (nơi set
   `this.best = { score, ... }` trong `integrate()`), chạy publishCommand 1 lần
   (runCommand fire-and-forget, timeout 60s, env thêm SWARM_BEST_SCORE). Đừng chờ kết quả.
2. [ ] **Re-baseline** — route POST `/api/runs/:id/rebaseline` trong server.js: gọi
   `run.evaluateBaseline()` (tách logic baseline hiện có thành method nếu chưa có) → chấm lại
   best commit hiện tại, cập nhật best mới (điểm có thể khác khi rubric/command đổi).
3. [ ] **Export CSV** — route GET `/api/runs/:id/export.csv` trả results.tsv dạng CSV
   (cột time,agent,iter,commit,score,status,description; escape dấu phẩy bằng dấu ").
4. [ ] **UI biểu đồ điểm** — public/app.js + index.html: trong tab phiên đang chạy, vẽ biểu đồ
   điểm theo vòng (SVG inline, trục X = iter, Y = score, điểm keep màu xanh, discard đỏ).
   Không thêm thư viện ngoài.
5. [ ] **RENDER_CACHE passthrough** — swarm.js: tùy chọn `envExtra` (object) trong
   normalizeOptions, merge vào env khi chạy agent + evalCommand (dùng chung cho cache render).

## Luật

- Mỗi lượt CHỈ làm 1 mục. Xong thì:
  `node evaluate.js` (phải PASS — chạy nhanh, được phép) → đánh dấu [x] trong TASK.md →
  ghi .swarm_note.md (tên tính năng vừa làm) → orchestrator tự commit + chấm.
- KHÔNG sửa evaluate.js. KHÔNG refactor ngoài phạm vi mục đang làm. KHÔNG thêm thư viện npm.
- Backup không cần — git là nguồn chân lý, lượt hỏng bị vứt.
- Nếu mục trước đã [x] bởi agent khác: làm mục KẾ TIẾP chưa [x]. Hết backlog: cải tiến nhỏ
  tự đề xuất (hiệu năng, thông báo lỗi tiếng Việt rõ hơn, edge case) — 1 thứ mỗi lượt.
