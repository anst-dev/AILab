# SETUP — mang AI Lab sang máy mới (5 phút)

## 1. Yêu cầu máy

| Cần | Kiểm tra |
|---|---|
| Node.js ≥ 18 | `node --version` |
| Git | `git --version` |
| ffmpeg + ffprobe (cho lab-video) | `ffmpeg -version` |
| Python ≥ 3.10 + Pillow (lab-video) | `python -c "import PIL"` |
| ≥ 1 agent CLI đã đăng nhập | `agy --version` / `claude --version` / `gemini --version`… |

## 2. Cài đặt

```bash
git clone https://github.com/anst-dev/AILab.git
cd AILab/lab-dev            # bản đầy đủ: app + labs + knowledge
node src/server.js          # mở http://localhost:7788 — xong
```

Không cần `npm install` (thuần stdlib). Đổi cổng: `PORT=8000 node src/server.js`.

## 3. Kiểm tra sức khỏe

```bash
node evaluate.js   # kỳ vọng: CHECK syntax ... OK / CHECK smoke ... OK / EVAL: PASS
node harvest.js    # gom kết quả các phiên cũ vào knowledge/improvements_log.jsonl
```

## 4. Biến môi trường (tùy chọn, cho lab-video)

```bash
set AILAB_MP4=D:\path\buoi_*.mp4      # nguồn video (glob chấp nhận dấu tiếng Việt)
set AILAB_VTT=D:\path\buoi_*.vtt
set AILAB_VISION=agy                   # scorer vision = agy CLI (đọc ảnh được)
```

## 5. Lỗi thường gặp trên máy mới

| Triệu chứng | Xử lý |
|---|---|
| `spawn bash ENOENT` (script gọi lệnh) | dùng đường dẫn đầy đủ `C:/Program Files/Git/usr/bin/bash.exe` |
| Cổng bận | app tự thử cổng kế; hoặc `node src/server.js --stop` dọn bản nền cũ |
| Agent CLI "không tìm thấy" | chạy lệnh đó 1 lần trong terminal để nó đăng nhập, rồi Restart catalog trên web |
| Worktree Windows lock | `git worktree prune` trong repo; phiên cũ dọn bằng `--stop` |
| Bot quay vòng no-change | circuit breaker `noChangeLimit` (mặc định 15) tự dừng — kiểm tra token CLI |

## 6. Vận hành vòng lặp cải tiến (tóm tắt)

1. Workspace git + `evaluate.js` (in `SCORE: n` hoặc exit 0) + `TASK.md` backlog.
2. Web → **Phiên mới**: evalCommand = `node evaluate.js`, protectedFiles, agent CLI × N → Bắt đầu.
3. `publishCommand` = chuỗi push GitHub tự động mỗi khi có best mới (mẫu: `postmerge.example.json`).
4. Xem chart live; ưng → **Merge** về main. Log mọi keep tự vào `knowledge/improvements_log.jsonl`.

Chi tiết đầy đủ: `README.md` (app) · `HUONG_DI.md` (vòng lặp 30 phút) · `docs/TICH_HOP_LAB_VIDEO.md` (lab video) · `knowledge/pitfalls.md` (20+ bài học).
