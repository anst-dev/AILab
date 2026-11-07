# Agent Swarm — AI Lab

> **App này tự cải tiến chính nó.** 72 lượt keep trong ~24 giờ chạy 6 bot (3 agy CLI + 3 bot ZCode), toàn bộ lịch sử trong `knowledge/improvements_log.jsonl` (4,600+ dòng) và git history. Biểu đồ điểm, Export CSV, Re-baseline, publishCommand, envExtra, Knowledge viewer, Harvest, gần 20 lệnh chat CLI — đều là các tính năng **bot tự viết rồi tự merge**.

App điều phối **nhiều agent CLI** (Claude Code, Codex, Gemini, Copilot, OpenCode…) cải tiến **liên tục** một dự án theo mô hình [karpathy/autoresearch](https://github.com/karpathy/autoresearch). Mô hình gốc chỉ có 1 agent, còn app này chạy song song **N agent** và dùng **git làm trung tâm** để các agent không giẫm chân nhau.

## Ý tưởng

```
Bạn nhập yêu cầu ─► chọn CLI + số agent ─► Bắt đầu
                                              │
        ┌──────────── nhánh trung tâm swarm/<tag> (luôn là bản tốt nhất) ───────────┐
        │                                                                          │
   agent-1 (worktree riêng)   agent-2 (worktree riêng)   …   agent-N (worktree riêng)
        │  1. đồng bộ về bản tốt nhất                                              │
        │  2. agent làm việc, bị KILL sau 5 phút                                   │
        │  3. orchestrator tự commit                                               │
        │  4. đánh giá (điểm số / pass-fail / không đánh giá)                       │
        │  5. đạt → fast-forward vào nhánh trung tâm (có khoá git)                 │
        │     không đạt / xung đột → bỏ                                            │
        └──────────── lặp lại vô hạn (hoặc tới giới hạn bạn đặt) ───────────────────┘
```

- **Mỗi agent một git worktree + nhánh riêng** (`.swarm/wt/<tag>/aN`), không ai sửa file của ai.
- **Kill cứng theo thời gian**: hết giờ là kill **cả cây tiến trình**, kể cả tiến trình con (`taskkill /T /F` trên Windows).
- **Chỉ kết quả đạt mới được vào git.** Việc merge vào nhánh trung tâm luôn chạy dưới một khoá duy nhất. Nếu trong lúc đó nhánh trung tâm đã tiến lên, thay đổi được rebase rồi **đánh giá lại** (tối đa 3 lần); bị xung đột thì loại.
- **Chống trùng ý tưởng**: agent ghi ý tưởng của mình vào `.swarm_note.md` trước khi bắt đầu sửa. Agent khác thấy danh sách "đang làm" cùng lịch sử thử nghiệm trong file nhiệm vụ.
- **Nhánh gốc của bạn giữ nguyên.** Mọi kết quả nằm trên `swarm/<tag>`, chạy xong bấm **Merge** để đưa về nhánh gốc.

## Yêu cầu

- **Node.js ≥ 18** (không cần `npm install`, app không có thư viện ngoài)
- **Git**
- Ít nhất một agent CLI đã đăng nhập sẵn: `claude`, `codex`, `gemini`, `copilot`, `opencode`, `qwen`, `cursor-agent`, `aider`, `zcode`, hoặc một CLI tuỳ chỉnh.

## Chạy

```bash
cd agent-swarm
node src/server.js            # tự mở trình duyệt tại http://localhost:7788
node src/server.js --no-open  # không tự mở trình duyệt
```

Đổi cổng bằng biến `PORT`. Nếu cổng đang bận (kể cả khi app khác chiếm cùng cổng mà Windows vẫn cho bind), app tự thử cổng kế tiếp. Nhấn `Ctrl+C` để thoát: app sẽ kill mọi agent và dọn worktree trước khi tắt.

### Chạy nền + nhắn tin với agent điều phối

```bash
node src/server.js --background   # chạy nền (không cửa sổ), log ở data/server.log; hoặc bấm Start-background.bat
node src/server.js --status       # đang chạy ở đâu
node src/server.js --stop         # dừng (kill agent, dọn worktree)

node src/chat.js "Tối ưu C:\Projects\abc cho chạy nhanh hơn, dùng 3 agent agy effort low"   # nhắn 1 câu, chờ trả lời
node src/chat.js                  # chat liên tục trong terminal
```

Không cần điền form: bạn nhắn yêu cầu bằng lời thường (trong terminal hoặc tab **Điều phối** trên web), **agent điều phối** sẽ tự:

- xem thư mục / đọc file để chọn lệnh đánh giá, regex điểm, file cần bảo vệ;
- chọn CLI, số agent, thời gian mỗi lượt theo lời bạn (đổi được cả lệnh CLI, vd thêm `--effort low`);
- bắt đầu / dừng / merge phiên;
- báo lại khi phiên kết thúc, và tự chạy tiếp nếu yêu cầu của bạn cần thêm (tối đa 6 lần mỗi tin nhắn).

Agent điều phối là một CLI ở chế độ chỉ trả lời (`claude -p`, `agy -p`, `codex exec`…, chọn được trên web), **không** sửa file và không cần cờ bỏ qua quyền: nó chỉ trả về JSON hành động, server thực thi. Chat + bối cảnh lưu ở `data/chat.json`, log mỗi lần gọi ở `data/coordinator/logs/`.

`chat.js` tự khởi động server nền nếu chưa có.

## Dùng

1. **Mẫu**: chọn kiểu dự án.
   | Mẫu | Đánh giá | Khi nào dùng |
   |---|---|---|
   | Tự do | không có | Xây dựng hoặc cải tiến tự do; mọi thay đổi không xung đột đều được merge |
   | Kiểm thử | lệnh trả mã 0 | Có bộ test (`npm test`, `pytest`…) |
   | Điểm số | regex lấy một con số | Tối ưu một metric (tốc độ, độ chính xác…) |
   | autoresearch | `uv run train.py` → `val_bpb` | Đúng bài toán của karpathy (cần GPU NVIDIA) |
2. **Thư mục dự án**: nhập đường dẫn tuyệt đối rồi bấm *Kiểm tra*. Thư mục chưa tồn tại thì được tạo mới và `git init`. Thư mục chưa phải repo thì `git init` rồi commit toàn bộ. Thay đổi chưa commit được lưu thành snapshot trên nhánh swarm.
3. **Yêu cầu**: mô tả mục tiêu.
4. **Agent CLI và số lượng**: nhập số agent cho từng CLI mà app tìm thấy trên máy (có thể trộn nhiều loại).
5. **Thời gian mỗi lượt**: mặc định 5 phút.
6. **Bắt đầu.** Dashboard hiển thị thẻ từng agent (trạng thái, ý tưởng đang làm, đếm ngược), bảng kết quả, commit trên nhánh trung tâm và sự kiện. Bấm vào thẻ agent hoặc một dòng kết quả để xem log.
7. **Dừng sau lượt này** (để agent làm xong lượt hiện tại) hoặc **Dừng ngay** (kill hết). Sau khi dừng có thể **Merge kết quả vào nhánh gốc**.

### Tuỳ chọn nâng cao

- **File được bảo vệ**: agent có sửa các file này thì thay đổi tự bị hoàn tác (vd `prepare.py`).
- **Số lượt tối đa / tổng thời lượng**: để chạy qua đêm có giới hạn.
- **Số đánh giá song song**: đặt `1` khi đánh giá dùng chung tài nguyên, vd một GPU.
- **Cải thiện tối thiểu**: chỉ giữ khi điểm tốt hơn best ít nhất bằng giá trị này.
- **Chỉ dẫn thêm**: tương tự `program.md` của autoresearch.
- **Cấu hình agent** (menu trên cùng): sửa lệnh của từng CLI hoặc thêm CLI tuỳ chỉnh. `{prompt}` được thay bằng câu (đã kèm ngoặc kép) yêu cầu agent đọc file `.swarm_task.md`.

## Tính năng do bot tự thêm (72 keep)

**API:** `POST /api/runs/:id/rebaseline` (chấm lại best khi đổi rubric/command) · `GET /api/runs/:id/export.csv` (RFC4180, đọc cả results.tsv phiên cũ) · `export.json` + JSONL export · logs listing · git diff endpoint · `DELETE /api/runs/:id` · `/api/harvest` + status

**Web UI:** SVG score chart realtime (baseline line, best highlight, legend filter, average line, click điểm → log, keyboard nav) · Export CSV / Re-baseline buttons · Knowledge viewer + tìm kiếm · Diff/log modal có copy · Harvest button + download · Delete run · Search filter sidebar · publishCommand/envExtra inputs trong cấu hình nâng cao

**chat CLI:** `--status --stop --export --rebaseline --merge --runs --run --harvest --log --logs --catalog --knowledge --gitlog --diff --inspect --shutdown --delete --export-csv --export-json --stats` — điều khiển mọi thứ không cần mở web

**Hạ tầng log:** `logImprovement()` tự append JSONL mỗi KEEP (cả 2 evalMode) · `harvest.js` gom results.tsv mọi phiên → JSONL (dedupe commit+iter+status, `--stats --dry-run --export-csv/--json/--jsonl`, lọc status/bot/query) · `postmerge.example.json` mẫu publishCommand

## Labs kèm theo

| Thư mục | Là gì |
|---|---|
| `lab-video/` | Lab làm video ngắn từ bài giảng: renderer 3 tầng "code-to-video" (code typing / sub pill / footage + CTA), rubric 38 mục có **Privacy Gate** (lộ người ngoài speaker = 0 điểm), auto-sync timing từ phụ đề, A/B hook, publish pack (FINAL + srt + poster) |
| `lab-dev/` (repo này) | Workspace 6 bot tự cải tiến app — lịch sử trên nhánh `feat/autov1` + `autov1-swarm-live` |
| `knowledge/` | `improvements_log.jsonl` (append-only) + `pitfalls.md` (20+ bài học) — dữ liệu train/đánh giá bot sau này |

## Lộ trình (bài học từ 47 lượt discard)

- **Circuit breaker**: N vòng no-change liên tiếp (agent hết token) → tự dừng phiên — tránh 1,491 vòng quay vô nghĩa như đợt trực đêm đầu tiên
- Persist runs index qua restart (sidebar hiện lại các phiên cũ từ results.tsv)
- UI hiển thị Knowledge viewer theo từ khóa đã có server-side — mở rộng tìm kiếm ngữ nghĩa

| CLI | Lệnh mặc định |
|---|---|
| Claude Code | `claude -p {prompt} --dangerously-skip-permissions` |
| Codex | `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check {prompt}` |
| Gemini | `gemini --yolo -p {prompt}` |
| Copilot | `copilot -p {prompt} --allow-all` |
| OpenCode | `opencode run --auto {prompt}` |
| Qwen | `qwen --yolo -p {prompt}` |
| Cursor | `cursor-agent -p --force {prompt}` |
| Antigravity | `agy -p {prompt} --dangerously-skip-permissions` |
| Aider | `aider --yes-always --no-auto-commits --no-gitignore --message {prompt}` |
| ZCode (Z.ai) | `zcode --model account:zai-start-plan/GLM-5.3-Flash -p {prompt}` |

### Dùng ZCode (Z.ai GLM) làm agent

Gói **Start Plan** (vd. *ZCODE WEEKEND BUILD*, GLM-5.3-Flash) trong ZCode Desktop gọi được từ CLI qua [`zcode-app-cli`](https://github.com/kingsword09/zcode-cli) (CLI cộng đồng, bọc agent của ZCode Desktop).

```powershell
npm install -g zcode-app-cli@latest     # cần Node ≥ 22.19
zcode login --oauth                     # cùng tài khoản ZCode Desktop (--no-browser nếu chạy headless)
zcode --model account:zai-start-plan/GLM-5.3-Flash -p "say ok"   # thử nhanh
```

Sau đó chọn agent **ZCode CLI (Z.ai)** trong UI. Ghi chú:

- Cần bản sau [fix #251](https://github.com/kingsword09/zcode-cli/issues/248) (01/11/2026). Bản cũ báo `Model not in Provider Registry` với model Start Plan.
- Start Plan chạy qua `zcode.z.ai` bằng token OAuth của ZCode, **không** dùng API key của `api.z.ai`, nên không thể trỏ Claude Code (`ANTHROPIC_BASE_URL`) vào để dùng quota này.
- Gói GLM Coding Plan: đổi model thành `account:zai-individual-coding-plan/GLM-5.3-Flash` (sửa lệnh trong cấu hình agent của UI).
- CLI chưa có cờ bỏ qua xác nhận quyền. Nếu ở chế độ `-p` agent đứng chờ hoặc không sửa file, đặt chế độ `yolo` trong `%USERPROFILE%\.zcode\cli\setting.json`.
- Khi quota hết, các lượt sẽ không có thay đổi và circuit breaker tự dừng phiên.

> ⚠️ Agent chạy ở chế độ **bỏ qua xác nhận quyền** để có thể tự làm việc. Chỉ dùng với dự án bạn tin tưởng và nên có backup hoặc remote git.
>
> Muốn chặt hơn với `agy`: thay cờ bỏ qua quyền bằng danh sách lệnh được phép (chỉ khớp **chính xác** từng lệnh):
> `agy -p {prompt} --mode accept-edits --effort low --settings C:/path/agy-settings.json` với file
> `{"permissions":{"allow":["command(node eval.js)"]}}`. Lệnh không có trong danh sách bị từ chối; khi agent không sửa được gì, dòng lỗi cuối của CLI hiện ở cột mô tả kết quả.

## Dữ liệu được lưu ở đâu

Trong repo dự án, thư mục `.swarm/` được tự thêm vào `.git/info/exclude` nên không bị commit:

```
.swarm/
  runs/<tag>/state.json     trạng thái phiên (xem lại trong app)
  runs/<tag>/results.tsv    mọi lượt: agent, commit, điểm, keep/discard/crash...
  runs/<tag>/logs/agent-N/iter-K.agent.log | .eval.log
  wt/<tag>/aN/              worktree của agent (xoá khi phiên kết thúc)
```

Kết quả đạt là các commit trên nhánh `swarm/<tag>`, mỗi commit ghi rõ agent nào làm và ý tưởng gì:

```bash
git log --oneline swarm/<tag>
```

Cấu hình của app (lệnh agent, các thư mục dùng gần đây) nằm ở `agent-swarm/data/config.json`.

## Trạng thái kết quả

| Trạng thái | Ý nghĩa |
|---|---|
| giữ (`keep`) | Đạt, đã merge vào nhánh trung tâm |
| loại (`discard`) | Không tốt hơn best |
| lỗi (`crash`) | Lệnh đánh giá lỗi, quá giờ hoặc không lấy được điểm |
| xung đột (`conflict`) | Đè lên thay đổi mà agent khác vừa merge |
| trùng (`duplicate`) | Thay đổi đã có sẵn trên nhánh trung tâm |
| không đổi (`no-change`) | Agent không sửa gì (hoặc bị kill trước khi kịp lưu) |

## Dùng với autoresearch (karpathy)

Repo đã được clone sẵn ở `../autoresearch`. Cần **GPU NVIDIA**, Python ≥ 3.10 và [uv](https://docs.astral.sh/uv/):

```bash
cd ../autoresearch
uv sync
uv run prepare.py      # tải dữ liệu + train tokenizer, chỉ làm 1 lần
```

Sau đó chọn mẫu **autoresearch** và trỏ thư mục dự án tới `autoresearch`. Nên đặt **Số đánh giá song song = 1** vì chỉ có một GPU. Agent chỉ sửa `train.py`; mỗi lượt orchestrator chạy training 5 phút để đo `val_bpb`.

## Kiểm thử

```bash
npm test     # = regression.test.js + e2e.js + api.js + coordinator.js
node evaluate.js   # cổng chấm của swarm: syntax + smoke + toàn bộ test (EVAL_QUICK=1 để bỏ test)
```

`test/regression.test.js` khóa các lỗi đã gặp: circuit breaker dừng phiên khi agent toàn no-change, `knowledgeLog` mặc định tắt (không tạo `knowledge/` trong dự án người dùng), harvest bỏ dòng no-change/lỗi quota và chạy lại không nhân dòng. Bot thêm test mới đặt tên `test/*.test.js` — `evaluate.js` tự chạy.

`test/coordinator.js` khởi động server nền, nhắn qua `chat.js`, dùng agent điều phối giả (`test/fake-coordinator.js`) để kiểm tra: inspect → start → phiên kết thúc → tóm tắt, hành động lỗi, lưu hội thoại, `--stop`.

Bộ test dùng agent giả (`test/fake-agent.js`) để kiểm tra: cải tiến, kém hơn, treo bị kill (gồm cả tiến trình cháu), crash, agent tự commit, sửa file được bảo vệ, xung đột, dừng ngay, chạy phiên thứ hai, merge về nhánh gốc, và không còn tiến trình mồ côi.

## Cấu trúc mã

```
src/server.js   HTTP server + API + SSE (cập nhật trực tiếp) + chạy nền (--background/--stop/--status)
src/coordinator.js  Agent điều phối: hội thoại → JSON hành động → start/stop/merge/inspect
src/chat.js     Nhắn tin với agent điều phối từ terminal
src/swarm.js    Orchestrator: worktree, vòng lặp agent, đánh giá, merge
src/git.js      Gọi git + khoá theo repo
src/proc.js     Chạy lệnh, timeout, kill cả cây tiến trình
src/agents.js   Danh sách CLI + dò CLI có trên máy
public/         Giao diện web (HTML/CSS/JS thuần)
test/           Agent giả, đánh giá giả, test end-to-end
```
