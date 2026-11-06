'use strict';

// Chat-driven coordinator: the user talks to one agent CLI in plain language; that agent
// answers with JSON actions (start / stop / merge / inspect...) which the server executes.
// The coordinator CLI never edits files itself, so it runs without permission-skipping flags.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runCommand } = require('./proc');
const { tailFile } = require('./util');

const REQUEST_FILE = 'request.md';
const COORD_PROMPT = `"Read the file ${REQUEST_FILE} in the current directory and follow it. Reply with ONLY the JSON object it asks for."`;
const MAX_STEPS = 4; // coordinator calls per trigger (inspect -> look at result -> act)
const MAX_AUTO = 6; // follow-ups triggered by finished runs before a new user message is required
const MAX_MESSAGES = 300;

// Read-only print-mode commands, in order of preference.
const COORD_TEMPLATES = {
  claude: 'claude -p {prompt}',
  agy: 'agy -p {prompt}',
  codex: 'codex exec --skip-git-repo-check {prompt}',
  gemini: 'gemini -p {prompt}',
  copilot: 'copilot -p {prompt}',
  opencode: 'opencode run {prompt}',
  qwen: 'qwen -p {prompt}',
};

/** Extracts the last JSON object from free-form CLI output. */
function parseReply(text) {
  const fenced = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fenced.reverse();
  const s = String(text);
  for (let end = s.lastIndexOf('}'); end >= 0; end = s.lastIndexOf('}', end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (s[i] === '}') depth++;
      else if (s[i] === '{' && --depth === 0) {
        candidates.push(s.slice(i, end + 1));
        break;
      }
    }
    if (candidates.length > fenced.length + 3) break;
  }
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      if (j && typeof j === 'object' && ('reply' in j || 'actions' in j)) return j;
    } catch {}
  }
  return null;
}

class Coordinator extends EventEmitter {
  /**
   * ops: { catalog(), config(), setTemplate(cli, tpl), listRuns(), getRun(id), startRun(opts), stopRun(id, mode), mergeRun(id), inspect(path) }
   */
  constructor({ dataDir, ops }) {
    super();
    this.dir = path.join(dataDir, 'coordinator');
    this.file = path.join(dataDir, 'chat.json');
    this.ops = ops;
    this.queue = [];
    this.busy = false;
    this.autoLeft = MAX_AUTO;
    this.owned = new Set(); // run ids started by the coordinator
    this.messages = [];
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.messages = saved.messages || [];
      this.owned = new Set(saved.owned || []);
    } catch {}
    this.seq = this.messages.reduce((m, x) => Math.max(m, x.id || 0), 0);
  }

  state() {
    return { busy: this.busy, messages: this.messages };
  }

  push(role, text, extra = {}) {
    const msg = { id: ++this.seq, t: Date.now(), role, text: String(text || ''), ...extra };
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.save();
    this.emit('message', msg);
    return msg;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ messages: this.messages, owned: [...this.owned] }, null, 2));
    } catch {}
  }

  clear() {
    this.messages = [];
    this.save();
    this.emit('cleared');
  }

  /** A message from the user. */
  send(text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('Tin nhắn trống.');
    this.autoLeft = MAX_AUTO;
    const msg = this.push('user', t);
    this.enqueue('user');
    return msg;
  }

  /** Called by the server whenever a run stops. */
  runEnded(snap) {
    if (!this.owned.has(snap.id)) return;
    const n = (st) => snap.results.filter((r) => r.status === st).length;
    const best = snap.best ? ` Best: ${snap.best.score} (${snap.best.desc || ''}).` : '';
    const err = snap.status === 'error' ? ` Lỗi: ${snap.error}.` : '';
    this.push('system', `Phiên ${snap.id} đã kết thúc (${snap.status}). Giữ ${n('keep')}, loại ${n('discard')}, lỗi ${n('crash')}, xung đột ${n('conflict')}.${best}${err}`);
    if (this.autoLeft-- > 0) this.enqueue('run-ended');
  }

  enqueue(trigger) {
    this.queue.push(trigger);
    this.pump();
  }

  async pump() {
    if (this.busy) return;
    const trigger = this.queue.shift();
    if (!trigger) return;
    this.busy = true;
    this.emit('busy', true);
    try {
      await this.process(trigger);
    } catch (e) {
      this.push('system', `Agent điều phối lỗi: ${e.message}`, { level: 'error' });
    } finally {
      this.busy = false;
      this.emit('busy', false);
      this.pump();
    }
  }

  async pickCommand() {
    const cfg = this.ops.config();
    const catalog = await this.ops.catalog();
    const c = cfg.coordinator || {};
    if (c.template) return c.template;
    const found = new Set(catalog.filter((a) => a.found).map((a) => a.id));
    const id = (c.cli && found.has(c.cli) && c.cli) || Object.keys(COORD_TEMPLATES).find((k) => found.has(k));
    if (!id) throw new Error('Không tìm thấy agent CLI nào để làm agent điều phối.');
    return COORD_TEMPLATES[id];
  }

  async process(trigger) {
    for (let step = 0; step < MAX_STEPS; step++) {
      const command = (await this.pickCommand()).split('{prompt}').join(COORD_PROMPT);
      fs.mkdirSync(path.join(this.dir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(this.dir, REQUEST_FILE), await this.buildRequest(trigger));
      const logFile = path.join(this.dir, 'logs', `${Date.now()}.log`);
      const r = await runCommand({ command, cwd: this.dir, logFile, timeoutMs: 5 * 60 * 1000 }).promise;
      const out = tailFile(logFile, 200000);
      const reply = parseReply(out);
      if (!reply) {
        const why = r.timedOut ? 'quá 5 phút' : `mã thoát ${r.code}`;
        this.push('system', `Agent điều phối không trả về JSON hợp lệ (${why}). Đoạn cuối output:\n${out.slice(-600)}`, { level: 'error' });
        return;
      }
      const actions = Array.isArray(reply.actions) ? reply.actions : [];
      const results = [];
      for (const a of actions) results.push(await this.execute(a));
      this.push('agent', reply.reply || '', { actions: results });
      // Only informational actions need another look; anything else ends the turn.
      if (!results.length || !results.every((x) => x.info)) return;
      trigger = 'tool-results';
    }
  }

  async execute(a) {
    const type = a && a.type;
    try {
      switch (type) {
        case 'start': {
          const id = await this.ops.startRun(a.options || {});
          this.owned.add(id);
          this.save();
          return { type, ok: true, text: `Đã bắt đầu phiên ${id}`, runId: id };
        }
        case 'stop':
          await this.ops.stopRun(a.id, a.mode === 'now' ? 'now' : 'graceful');
          return { type, ok: true, text: `Đã gửi lệnh dừng (${a.mode === 'now' ? 'ngay' : 'sau lượt này'}) cho ${a.id}`, runId: a.id };
        case 'merge': {
          const r = await this.ops.mergeRun(a.id);
          return { type, ok: true, text: `Đã merge ${a.id}: ${JSON.stringify(r)}`, runId: a.id };
        }
        case 'rebaseline': {
          const r = await this.ops.rebaselineRun(a.id);
          return { type, ok: true, text: `Đã đo lại baseline ${a.id}: ${r && r.best && r.best.score != null ? `best = ${r.best.score}` : 'thành công'}`, runId: a.id };
        }
        case 'export_csv': {
          const csv = await this.ops.exportRunCsv(a.id);
          return { type, ok: true, info: true, text: `xuất CSV ${a.id}`, data: csv };
        }
        case 'export_json': {
          const json = await this.ops.exportRunJson(a.id);
          return { type, ok: true, info: true, text: `xuất JSON ${a.id}`, data: json };
        }
        case 'list_logs': {
          const files = await this.ops.listRunLogs(a.id);
          return { type, ok: true, info: true, text: `danh sách log ${a.id}`, data: files };
        }
        case 'gitlog': {
          const commits = await this.ops.gitLog(a.id);
          return { type, ok: true, info: true, text: `git log ${a.id} (${(commits || []).length} commit)`, data: commits };
        }
        case 'harvest': {
          const r = await this.ops.harvest();
          return { type, ok: true, text: `Đã gom kết quả (+${r.freshCount} dòng mới, tổng ${r.totalCount} dòng vào knowledge/improvements_log.jsonl)`, data: r };
        }
        case 'stats': {
          const r = await this.ops.stats();
          return { type, ok: true, info: true, text: `Thống kê tri thức: ${r.total} dòng, tỷ lệ keep ${r.keepRate}%`, data: r };
        }
        case 'list_runs':
          return { type, ok: true, info: true, text: 'danh sách các phiên', data: this.ops.listRuns() };
        case 'catalog':
          return { type, ok: true, info: true, text: 'danh mục agent CLI', data: await this.ops.catalog() };
        case 'set_agent_template':
          await this.ops.setTemplate(String(a.cli || ''), String(a.template || ''));
          return { type, ok: true, text: `Lệnh của ${a.cli}: ${a.template}` };
        case 'inspect':
          return { type, ok: true, info: true, text: `inspect ${a.path}`, data: await this.ops.inspect(String(a.path || '')) };
        case 'read_file': {
          const p = String(a.path || '');
          if (!path.isAbsolute(p)) throw new Error('Cần đường dẫn tuyệt đối.');
          return { type, ok: true, info: true, text: `read ${p}`, data: tailFile(p, 12000) || '(trống hoặc không đọc được)' };
        }
        case 'run_detail':
          return { type, ok: true, info: true, text: `chi tiết ${a.id}`, data: this.detail(await this.ops.getRun(a.id)) };
        case 'run_log': {
          const snap = await this.ops.getRun(a.id);
          if (!snap) throw new Error(`Không tìm thấy phiên ${a.id}`);
          let file = a.file;
          if (!file) {
            const last = (snap.results || []).slice().reverse().find((r) => r.log) || (snap.agents || []).find((ag) => ag.lastLog);
            if (last) file = last.log || last.lastLog;
          }
          if (!file) throw new Error(`Phiên ${a.id} chưa có file log.`);
          const p = path.resolve(snap.repoRoot || '', '.swarm', 'runs', a.id, file);
          return { type, ok: true, info: true, text: `log ${file} của ${a.id}`, data: tailFile(p, 25000) || '(log trống)' };
        }
        default:
          throw new Error(`Hành động không hỗ trợ: ${type}`);
      }
    } catch (e) {
      return { type, ok: false, info: true, text: `${type} thất bại: ${e.message}` };
    }
  }

  detail(snap) {
    if (!snap) return null;
    return {
      id: snap.id,
      status: snap.status,
      phase: snap.phase,
      error: snap.error,
      workspace: snap.workspace,
      central: snap.central,
      best: snap.best,
      opts: snap.opts,
      agents: snap.agents.map((a) => ({ name: a.name, cli: a.cli, status: a.status, iter: a.iter, note: a.note })),
      results: snap.results.slice(-30).map((r) => ({ agent: r.agent, iter: r.iter, status: r.status, score: r.score, desc: r.desc })),
      events: snap.events.slice(-15).map((e) => e.msg),
    };
  }

  async buildRequest(trigger) {
    const catalog = await this.ops.catalog();
    const cfg = this.ops.config();
    const runs = this.ops.listRuns().slice(0, 15);
    const live = [];
    for (const r of runs.filter((x) => x.live && !['stopped', 'error'].includes(x.status))) live.push(this.detail(await this.ops.getRun(r.id)));
    const history = this.messages.slice(-30).map((m) => {
      let s = `[${new Date(m.t).toLocaleString('vi-VN')}] ${m.role.toUpperCase()}: ${m.text}`;
      for (const a of m.actions || []) {
        s += `\n  -> ${a.ok ? 'OK' : 'FAIL'} ${a.text}`;
        if (a.data !== undefined && m === this.messages[this.messages.length - 1]) s += `\n${JSON.stringify(a.data, null, 1).slice(0, 12000)}`;
      }
      return s;
    });
    const triggerText = {
      user: 'The user just sent a new message (last USER line). Respond to it.',
      'run-ended': 'A run you started has just ended (last SYSTEM line). Summarise the outcome for the user. If the user\'s goal clearly asked for more work (e.g. keep going until a target), start a follow-up run; otherwise do not start anything.',
      'tool-results': 'You requested information; the results are attached to the last AGENT line. Continue the task.',
    }[trigger];

    return `# You are the coordinator of Agent Swarm

Agent Swarm runs N coding-agent CLIs in parallel to continuously improve a project (karpathy/autoresearch style).
Each agent works in its own git worktree for a fixed time per iteration; results are evaluated and only good ones
are fast-forwarded onto a central branch \`swarm/<id>\`. The user's original branch is untouched until "merge".

The user does not fill forms: they chat with you. You turn their wishes into actions. Reply in the user's language
(Vietnamese if they write Vietnamese), short and concrete.

## Output format (STRICT)
Reply with ONLY one JSON object, no other text:
{"reply": "message to the user", "actions": [ ... ]}

Actions:
- {"type":"start","options":{...}}   start a run. options:
    workspace (absolute path; created + git init if missing), requirement (goal for the agents, detailed),
    agents: [{"cli": "<id from the CLI list>", "count": N}],
    timeLimitMin (minutes per agent iteration, default 5),
    evalMode: "none" | "pass" (command exit code 0 = good) | "score" (number parsed from output),
    evalCommand (run in the agent worktree), metricRegex (capture group 1 = number, multiline), direction "min"|"max",
    minDelta, evalTimeoutMin, evalConcurrency (1 if evaluation uses a shared device/GPU),
    protectedFiles (array of paths agents must not change, e.g. the evaluation script),
    publishCommand (command to run on new best score, env has SWARM_BEST_SCORE),
    envExtra (key-value object or JSON string for agent and eval envs),
    maxIterations (per agent, 0 = unlimited), maxDurationMin (0 = unlimited), extraInstructions.
- {"type":"stop","id":"<run id>","mode":"graceful"|"now"}
- {"type":"merge","id":"<run id>"}      merge the run's central branch into the user's original branch
- {"type":"rebaseline","id":"<run id>"} re-evaluate baseline/best commit for an active run
- {"type":"export_csv","id":"<run id>"} export run results as CSV text
- {"type":"export_json","id":"<run id>"} export run snapshot as JSON object
- {"type":"list_logs","id":"<run id>"}   list all log files in a run
- {"type":"gitlog","id":"<run id>"}      list commits accumulated in the run's central branch
- {"type":"harvest"}                    harvest/aggregate all run results and git logs into knowledge/improvements_log.jsonl
- {"type":"stats"}                      summary statistics of improvements_log.jsonl
- {"type":"list_runs"}                  list recent and active swarm runs
- {"type":"catalog"}                    list available agent CLIs and detection status
- {"type":"set_agent_template","cli":"<id>","template":"... {prompt} ..."}   change how an agent CLI is launched
    (e.g. add "--effort low" or a model flag). Agents must run unattended, so keep the permission-skip flag.
- {"type":"inspect","path":"<absolute dir>"}     list files / git status of a folder
- {"type":"read_file","path":"<absolute file>"}  read up to 12 KB of a file
- {"type":"run_detail","id":"<run id>"}         full status of a run
- {"type":"run_log","id":"<run id>","file":"<relative log file>"}  read agent or evaluation log in a run
inspect/read_file/run_detail/run_log/list_runs/catalog return data to you in a follow-up call (max ${MAX_STEPS} calls per turn);
use them before starting a run on a project you have not looked at, so the evaluation command is right.

Guidelines:
- Prefer a measurable evaluation: a test command (pass) or a script that prints a number (score). Protect the evaluation files.
- If the user names a CLI, effort or count, honour it. Otherwise use 3 agents of the first available CLI.
- If something essential is missing (e.g. which folder), ask in "reply" with no actions.
- Never start a second run on a folder that already has an active run.
- "actions": [] is fine when you only answer.

## Environment
Platform: ${process.platform}
Agent CLIs (id: found? command):
${catalog.map((a) => `- ${a.id}: ${a.found ? 'FOUND' : 'missing'}  ${a.template}`).join('\n')}
Recent workspaces: ${(cfg.recentWorkspaces || []).join(', ') || '(none)'}

## Runs (newest first)
${runs.map((r) => `- ${r.id} [${r.status}] ${r.workspace} | ${r.agents} agents | kept ${r.kept}/${r.total} | best ${r.best ? r.best.score : '-'} | ${r.requirement.slice(0, 120)}`).join('\n') || '(none)'}

## Active runs detail
${live.length ? JSON.stringify(live, null, 1).slice(0, 15000) : '(none)'}

## Conversation
${history.join('\n')}

## Now
${triggerText}
`;
  }
}

module.exports = { Coordinator, parseReply, COORD_TEMPLATES };
