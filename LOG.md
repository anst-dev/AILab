# LOG CẢI TIẾN — lab-dev (agent-swarm)

> File này + `knowledge/improvements_log.jsonl` là **nhật ký vĩnh viễn** mọi thay đổi của các bot.
> Mục đích: dữ liệu thô để sau này train/đánh giá bot tốt hơn (pattern nào hay keep, pattern nào hay discard).
> Quy ước JSONL: `{"ts","bot","kind","feature","commit","score","status","note"}` — append-only, không sửa dòng cũ.

## Trạng thái backlog

| # | Tính năng | Trạng thái | Ai làm |
|---|---|---|---|
| 1 | publishCommand | ✅ xong | agy agent-1 (run 20261107-002225, keep) |
| 2 | Re-baseline route | ✅ xong | ZCode bot Z1 (nhánh zcode-zc1) |
| 3 | Export CSV | ✅ xong | ZCode bot Z2 (nhánh zcode-zc2) |
| 4 | UI biểu đồ điểm | ✅ xong | ZCode bot Z3 (nhánh zcode-zc3) |
| 5 | envExtra passthrough | ✅ xong | agy agent-3 (commit eb99c82, keep) |

## Dòng thời gian

- **2026-11-06 17:22** — Run swarm `20261107-002225` (agy×6): baseline 5a72441, keep #1
  publishCommand (86cc541), agent-2 trùng ý tưởng → conflict discard (cơ chế chống trùng OK).
- **2026-11-07 00:26** — Merge zc2 (export CSV 843f39d) + zc3 (UI chart 0f9b9bc) vào main. EVAL PASS.
- **2026-11-07 00:30** — Merge zc1 (rebaseline 13f71e0) vào main. EVAL PASS. FEATURES:
  publishCommand, sharedCache, rebaseline.
- **2026-11-07 00:32** — Run swarm `20261107-002657` (agy×3) khởi chạy, tiếp tục mục 5 + cải tiến tự đề xuất.

## Kế hoạch log tự động (việc tiếp theo)

- Vá `publishCommand` của mỗi version sau trỏ vào script ghi JSONL này → mọi keep/discard
  tự vào log không cần tay (publishCommand hiện hỗ trợ env SWARM_BEST_SCORE).
- agy results.tsv mỗi run → script gom vào JSONL cuối phiên.
