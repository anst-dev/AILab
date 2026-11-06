# TÍCH HỢP agent-swarm × Loop Video (KENH_AI) — Phương án

> Trạng thái: ĐỀ XUẤT (khung workspace mẫu đã dựng tại `lab-video/`, chạy được với swarm hiện có)
> Nguồn kinh nghiệm: 42 vòng loop thủ công (D:\KENH_AI\loop, tag v0-v39, 86→348 điểm) + spec SaaS (SPEC_AILAB_SAAS.md)

## 1. Vì sao agent-swarm là engine đúng

agent-swarm đã có sẵn **chính xác cơ chế** loop video đang chạy thủ công, chỉ khác lớp vỏ:

| Cơ chế loop video (thủ công, 1 agent nối tiếp) | agent-swarm (có sẵn) |
|---|---|
| 5 phút/vòng, kill cứng | `timeLimitMin=5` + kill cả cây tiến trình |
| Sửa 1 thứ/vòng, git commit + tag | Mỗi agent 1 worktree + commit riêng |
| Chấm điểm keep/discard | `evalMode=score` + `metricRegex` + `minDelta` |
| Merge chỉ khi tốt hơn | Merge dưới khoá + rebase + **re-evaluate** tối đa 3 lần |
| Chống trùng ý tưởng (backlog) | `.swarm_note.md` + bảng "đang làm" |
| Bảo vệ renderer | `protectedFiles` |
| Baseline trước khi lặp | Tự đánh giá baseline commit gốc |

**Điểm cộng lớn nhất: N agent song song.** Loop thủ công chạy 1 nối tiếp (~12 vòng/giờ);
swarm chạy 3-4 agent cùng lúc nhưng **chấm bằng 1 thang chung** — mỗi giờ được 3-4 giả thuyết
cải tiến độc lập, tie/xung đột bị sàng sẵn. Đây là lần đầu cơ chế autoresearch thực sự song song.

## 2. Mô hình tích hợp: video loop = 1 "Lab Workspace"

agent-swarm tối ưu **repo**. Vậy: mỗi video cần tối ưu = 1 workspace git `lab-video/`:

```
lab-video/
├── variant.json          ← MỤC TIÊU agents sửa (bản best hiện tại)
├── rubric.json           ← thang điểm 38 mục (protected; mở rộng qua PR riêng)
├── evaluate.py           ← LỆNH ĐÁNH GIÁ (protected)
│     render variant (timeout 300s trong, temp+atomic)
│   → deterministic: ffprobe 1080x1920, duration ±0.5s, decode toàn file, ebur128 I≈-16
│   → vision: claude-haiku đọc 3 frame chấm các mục rubric (M6 privacy = GATE → 0 điểm)
│   → in "SCORE: <n>" — swarm bắt bằng metricRegex
├── render/               ← renderer PINNED (protected): render_code_variant.py + term_fixes + gen_timing/gen_subs
├── knowledge/pitfalls.md ← 20 pitfalls từ loop thật (agents đọc trước khi chọn cải tiến)
├── TASK.md               ← luật chơi cho agent (1 thứ/lượt, không tự eval, privacy)
├── variant best + .swarm_note.md + output/ (gitignored)
└── .env cấu hình nguồn: AILAB_MP4=<glob>, AILAB_VTT=<glob>, AILAB_VISION=claude-haiku-4-5
```

**Nguyên tắc phân vai:** agents chỉ được sáng tạo trên **nội dung** (variant.json);
hạ tầng render + thang điểm + kiến thức fail là bất biến — đúng như loop thủ công
(renderer/prepare.py không bao giờ sửa giữa loop).

## 3. Cấu hình phiên swarm (chạy được ngay)

```bash
cd AILab/agent-swarm
node src/server.js
# hoặc chat:
node src/chat.js "Tối ưu video trong D:/KENH_AI/AILab/lab-video: \
  3 agent claude, mỗi lượt 5 phút, evalMode score, \
  evalCommand='python evaluate.py', metricRegex='SCORE:\\s*(\\d+)', direction=max, minDelta=1, \
  protectedFiles=render/,evaluate.py,rubric.json, TASK.md là nhiệm vụ. Đọc knowledge/pitfalls.md trước khi chọn cải tiến."
```

| Tham số | Giá trị | Lý do (từ kinh nghiệm) |
|---|---|---|
| evalMode / metricRegex | `score`, `SCORE:\s*(\d+)` | loop dùng rubric số |
| direction / minDelta | `max`, `1` | tie bị discard (bài học E3 hòa điểm) |
| timeLimitMin | 5 | autoresearch chuẩn |
| evalTimeoutMin | 8 | render 50s ultrafast + vision ~2-3 phút |
| protectedFiles | `render/`, `evaluate.py`, `rubric.json` | hạ tầng bất biến |
| agents | claude ×2 + agy ×1 (KHÔNG grok) | quota + kinh nghiệm của user |
| extraInstructions | trỏ vào TASK.md + pitfalls.md | agents biết luật ngay |
| baseline | bật | "Round 0" = điểm gốc để so (86/100 thuở đầu) |

## 4. Những gì cần BỔ SUNG vào agent-swarm (nhỏ, có thứ tự ưu tiên)

1. **`publishCommand`** (khuyến nghị #1): tùy chọn chạy 1 lệnh MỖI KHI có best mới được merge
   → gọi `export_publish.py` + gửi Telegram. Hiện swarm chỉ log best — thêm ~20 dòng trong swarm.js
   (gọi ở nhánh `status:'keep'` sau khi cập nhật `this.best`).
2. **Shared cache env**: renderer cache theo hash — worktree khác nhau = cache lạnh. Thêm env
   `RENDER_CACHE_DIR` trỏ ra ngoài worktree (vd `data/cache/`) — vòng chỉ đổi subs rơi ~40s.
3. **Re-baseline khi rubric đổi**: rubric tự nâng (cơ chế SaaS) nghĩa là điểm cũ không so được
   điểm mới. Thêm nút/API "re-baseline" chạy lại evaluate trên best commit → đặt best mới.
4. **Xuất lịch sử điểm**: đã có results.tsv — thêm 1 endpoint export CSV đủ vẽ biểu đồ điểm
   theo vòng trên UI (Loop View trong spec SaaS).

## 5. Lộ trình 3 bước

**B1 — Chạy được tuần này (đã dựng khung):** `lab-video/` workspace + evaluate.py deterministic
(vision để trống khi chưa có provider, điểm nghiêm ngặt 0 phần vision) + TASK.md + pitfalls.
Chạy 1 phiên swarm 3 agent × 60 phút → đối chiếu điểm với best thủ công 348/380.

**B2 — Điểm thật + publish (tuần sau):** bật AILAB_VISION (claude-haiku, GIỮ timing khi polish),
đồng bộ rubric.json đủ 38 mục; vá `publishCommand` vào swarm.js; niêm quy tắc re-baseline.
Chuẩn hóa `lab-video` thành **template** (`ailab init --template video`).

**B3 — SaaS hoá (theo SPEC_AILAB_SAAS.md):** mỗi tenant = 1 workspace template; agent-swarm
chạy embed (thư viện) thay vì CLI máy cục bộ; quota theo vòng; UI Dashboard = Loop View
đã có trong spec;Knowledge Base dùng chung có opt-in.

## 6. Rủi ro & xử lý

| Rủi ro | Xử lý |
|---|---|
| Agents đụng render/ làm hỏng mọi lượt | protectedFiles + CI check evaluate.py hash |
| Điểm vision dao động giữa các lần chấm | chấm 3 frame cố định (d/g/c) + prompt khóa định nghĩa + nhiệt độ 0 |
| 2 agent cùng chọn 1 cải tiến | .swarm_note.md + kết quả LỊCH SỬ trong buildTask đã hiện |
| Chi phí vision/vòng cao | deterministic trước, vision chỉ chạy khi deterministic PASS; model haiku |
| Worktree Windows lock | swarm đã retry sẵn; thêm shared cache tránh I/O nặng |

## 7. Việc đã dựng sẵn trong PR này (đợi duyệt commit)

- `lab-video/variant.json` — bản best E41 (348/380) làm điểm khởi đầu
- `lab-video/evaluate.py` — render + deterministic checks + vision pluggable, in `SCORE:`
- `lab-video/rubric.json` — 38 mục map từ rubric.md (vision/deterministic + gate M6)
- `lab-video/TASK.md` — luật chơi cho agent
- `lab-video/knowledge/pitfalls.md` — 20+ bài học fail từ loop thật
- `lab-video/render/` — renderer pinned v39 + term_fixes + gen_timing/gen_subs
