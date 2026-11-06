# TASK — 3 bot tự cải tiến phần mềm agent-swarm

Bạn đang trong 1 worktree. Mỗi lượt 5 phút: **implement ĐÚNG 1 tính năng backlog** dưới đây,
theo thứ tự ưu tiên, sao cho `node evaluate.js` vẫn PASS (app phải chạy được).

## Backlog (làm lần lượt, đánh dấu [x] vào file này khi xong — commit kèm)

1. [x] **publishCommand** — tùy chọn mới trong swarm.js normalizeOptions (`raw.publishCommand`,
   string, rỗng mặc định). Khi 1 agent được KEEP và `this.best` cập nhật (nơi set
   `this.best = { score, ... }` trong `integrate()`), chạy publishCommand 1 lần
   (runCommand fire-and-forget, timeout 60s, env thêm SWARM_BEST_SCORE). Đừng chờ kết quả.
2. [x] **Re-baseline** — route POST `/api/runs/:id/rebaseline` trong server.js: gọi
   `run.evaluateBaseline()` (tách logic baseline hiện có thành method nếu chưa có) → chấm lại
   best commit hiện tại, cập nhật best mới (điểm có thể khác khi rubric/command đổi).
3. [x] **Export CSV** — route GET `/api/runs/:id/export.csv` trả results.tsv dạng CSV
   (cột time,agent,iter,commit,score,status,description; escape dấu phẩy bằng dấu ").
4. [x] **UI biểu đồ điểm** — public/app.js + index.html: trong tab phiên đang chạy, vẽ biểu đồ
   điểm theo vòng (SVG inline, trục X = iter, Y = score, điểm keep màu xanh, discard đỏ).
   Không thêm thư viện ngoài.
5. [x] **RENDER_CACHE passthrough** — swarm.js: tùy chọn `envExtra` (object) trong
   normalizeOptions, merge vào env khi chạy agent + evalCommand (dùng chung cho cache render).
6. [x] **Auto-log keep** — swarm.js: hàm `logImprovement(agent, desc, commit, score)` append 1
   dòng JSONL vào `knowledge/improvements_log.jsonl` ở repo root sau mỗi KEEP thành công
   (gọi trong integrate() khi evalMode 'score' cập nhật best, và tại record 'keep' với evalMode
   khác 'score'). Orchestrator ghi trực tiếp bằng fs nên không bị protectedFiles chặn
   (cơ chế đó chỉ hoàn tác file trong worktree agent); lỗi ghi bỏ qua im lặng.
7. [x] **harvest.js gom results.tsv → JSONL** — harvest.js đọc mọi `.swarm/runs/*/results.tsv`
   + `git log` các nhánh `swarm/*`, gộp vào `knowledge/improvements_log.jsonl`
   (kind="swarm-row", note=id run; dedupe commit+iter+status — chạy lại không nhân đôi).
8. [x] **Xóa phiên trên Web UI** — nút "Xóa phiên" trong chi tiết phiên đã dừng/lịch sử, xác nhận trước khi gọi DELETE /api/runs/:id và làm mới danh sách.
9. [x] **Copy git checkout & Diff UI** — nút chép lệnh `git checkout <branch>` và xem diff/diff stat nhánh trung tâm trên Web UI.
10. [x] **Xem commit diff trên Web UI** — hỗ trợ xem git show / diff của commit cụ thể khi bấm vào commit hash trong Git log hoặc bảng kết quả.
11. [x] **Nút sao chép Log & Diff trên Web UI** — thêm nút "Sao chép" vào modal `logDlg` để sao chép nhanh toàn bộ nội dung log hoặc git diff vào clipboard kèm thông báo trực quan.
12. [x] **Xem commit diff trong Kho tri thức trên Web UI** — hỗ trợ bấm vào commit hash trong bảng Kho tri thức (knowledge viewer) để xem chi tiết git show / diff của commit.
13. [x] **Hỗ trợ commit diff và branch checkout trong coordinator** — thêm hành động diff theo commit và branch/checkout vào coordinator để agent điều phối có thể tra cứu chi tiết commit và lệnh git checkout của phiên.
14. [x] **Xem commit diff trong CLI chat.js** — thêm tùy chọn --commit cho lệnh --diff trong chat.js để xem chi tiết git show / diff của commit cụ thể.
15. [x] **Hỗ trợ tra cứu kho tri thức trong coordinator** — thêm hành động knowledge vào coordinator để agent điều phối có thể tra cứu các cải tiến mới nhất từ improvements_log.jsonl.
16. [x] **Tìm kiếm kho tri thức theo từ khóa** — hỗ trợ tham số query/filter cho kho tri thức trong API server, coordinator và CLI chat.js (--knowledge -q <từ khóa>).
17. [x] **Tìm kiếm kết quả các lượt trên Web UI** — thêm ô tìm kiếm thời gian thực theo từ khóa (agent, commit, mô tả) vào bảng kết quả các lượt của phiên trên Web UI.
18. [x] **Xuất CSV và JSON từ CLI harvest.js** — thêm tùy chọn --export-csv và --export-json cho CLI harvest.js để xuất tri thức đã gom ra file CSV/JSON độc lập.

## Luật

- Mỗi lượt CHỈ làm 1 mục. Xong thì:
  `node evaluate.js` (phải PASS — chạy nhanh, được phép) → đánh dấu [x] trong TASK.md →
  ghi .swarm_note.md (tên tính năng vừa làm) → orchestrator tự commit + chấm.
- KHÔNG sửa evaluate.js. KHÔNG refactor ngoài phạm vi mục đang làm. KHÔNG thêm thư viện npm.
- Backup không cần — git là nguồn chân lý, lượt hỏng bị vứt.
- Nếu mục trước đã [x] bởi agent khác: làm mục KẾ TIẾP chưa [x]. Hết backlog: cải tiến nhỏ
  tự đề xuất (hiệu năng, thông báo lỗi tiếng Việt rõ hơn, edge case) — 1 thứ mỗi lượt.
