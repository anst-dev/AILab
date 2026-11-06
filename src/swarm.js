'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { git, revParse, changedPaths, repoLock } = require('./git');
const { runCommand } = require('./proc');
const { Semaphore, sleep, makeTag, tailFile } = require('./util');
const { buildAgentCommand } = require('./agents');

const TASK_FILE = '.swarm_task.md';
const NOTE_FILE = '.swarm_note.md';
const MAX_RETESTS = 3;

const activeRepos = new Set(); // repo roots with a running swarm

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function num(v, def, min, max) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function splitList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v || '').split(/[\n,;]+/).map((s) => s.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
}

/** Validates raw options from the UI. Returns { opts, errors }. */
function normalizeOptions(raw, catalog) {
  const errors = [];
  const o = {};
  o.workspace = String(raw.workspace || '').trim();
  if (!o.workspace) errors.push('Chưa nhập thư mục dự án.');
  else if (!path.isAbsolute(o.workspace)) errors.push('Thư mục dự án phải là đường dẫn tuyệt đối (vd: C:\\Projects\\abc).');
  else o.workspace = path.resolve(o.workspace);

  o.requirement = String(raw.requirement || '').trim();
  if (!o.requirement) errors.push('Chưa nhập yêu cầu.');

  o.agents = [];
  for (const a of Array.isArray(raw.agents) ? raw.agents : []) {
    const count = Math.floor(num(a && a.count, 0, 0, 32));
    if (!count) continue;
    const entry = catalog.find((c) => c.id === a.cli);
    if (!entry) errors.push(`Không có agent CLI "${a && a.cli}".`);
    else if (!entry.found) errors.push(`Không tìm thấy "${entry.name}" trên máy (lệnh ${entry.bin}).`);
    else o.agents.push({ cli: entry.id, name: entry.name, template: entry.template, count });
  }
  const total = o.agents.reduce((s, a) => s + a.count, 0);
  if (total < 1) errors.push('Chọn ít nhất 1 agent.');
  if (total > 32) errors.push('Tối đa 32 agent.');

  o.timeLimitMin = num(raw.timeLimitMin, 5, 0.05, 240);
  o.evalMode = ['none', 'pass', 'score'].includes(raw.evalMode) ? raw.evalMode : 'none';
  o.evalCommand = String(raw.evalCommand || '').trim();
  if (o.evalMode !== 'none' && !o.evalCommand) errors.push('Chế độ đánh giá cần lệnh đánh giá.');
  o.metricRegex = String(raw.metricRegex || '').trim();
  if (o.evalMode === 'score') {
    if (!o.metricRegex) errors.push('Chế độ điểm số cần regex lấy điểm.');
    else {
      try {
        new RegExp(o.metricRegex, 'm');
      } catch (e) {
        errors.push(`Regex không hợp lệ: ${e.message}`);
      }
    }
  }
  o.direction = raw.direction === 'max' ? 'max' : 'min';
  o.minDelta = num(raw.minDelta, 0, 0, 1e12);
  o.evalTimeoutMin = num(raw.evalTimeoutMin, 15, 0.05, 1440);
  o.evalConcurrency = Math.floor(num(raw.evalConcurrency, 1, 1, 32));
  o.baseline = raw.baseline !== false;
  o.protectedFiles = splitList(raw.protectedFiles);
  o.maxIterations = Math.floor(num(raw.maxIterations, 0, 0, 100000));
  o.maxDurationMin = num(raw.maxDurationMin, 0, 0, 100000);
  o.staggerSec = num(raw.staggerSec, 3, 0, 600);
  o.keepWorktrees = !!raw.keepWorktrees;
  o.extraInstructions = String(raw.extraInstructions || '').trim();
  o.publishCommand = String(raw.publishCommand || '').trim();

  // envExtra: object merged into env when running agent + evalCommand (RENDER_CACHE passthrough)
  o.envExtra = {};
  let envInput = raw.envExtra;
  if (typeof envInput === 'string' && envInput.trim().startsWith('{')) {
    try { envInput = JSON.parse(envInput); } catch {}
  }
  if (envInput && typeof envInput === 'object' && !Array.isArray(envInput)) {
    for (const [k, v] of Object.entries(envInput)) {
      if (k && v !== undefined && v !== null) {
        o.envExtra[String(k)] = String(v);
      }
    }
  }
  if (raw.cacheDir && !o.envExtra.RENDER_CACHE_DIR) {
    o.envExtra.RENDER_CACHE_DIR = String(raw.cacheDir);
  } else if (raw.RENDER_CACHE_DIR && !o.envExtra.RENDER_CACHE_DIR) {
    o.envExtra.RENDER_CACHE_DIR = String(raw.RENDER_CACHE_DIR);
  }
  return { opts: o, errors };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

class SwarmRun extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.id = makeTag();
    this.central = `swarm/${this.id}`;
    this.status = 'preparing'; // preparing | running | stopping | stopped | error
    this.phase = 'Đang chuẩn bị';
    this.error = null;
    this.stopMode = null; // null | 'graceful' | 'now'
    this.best = null; // { score, commit, desc, agent }
    this.baseCommit = null;
    this.results = [];
    this.events = [];
    this.agents = [];
    this.startedAt = Date.now();
    this.endedAt = null;
    this.handles = new Set();
    this.evalSem = new Semaphore(opts.evalConcurrency);
    this.mergedBack = null;
    this._emitTimer = null;
    this._saveTimer = null;
  }

  // ----- bookkeeping -------------------------------------------------------

  info(msg, level = 'info') {
    this.events.push({ t: Date.now(), level, msg });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    this.changed();
  }

  changed() {
    if (!this._emitTimer) {
      this._emitTimer = setTimeout(() => {
        this._emitTimer = null;
        this.emit('update', this);
      }, 250);
    }
    if (this.runDir && !this._saveTimer) {
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        this.save();
      }, 1000);
    }
  }

  save() {
    if (!this.runDir) return;
    try {
      fs.writeFileSync(path.join(this.runDir, 'state.json'), JSON.stringify(this.snapshot(), null, 2));
    } catch {}
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      phase: this.phase,
      error: this.error,
      stopMode: this.stopMode,
      workspace: this.opts.workspace,
      repoRoot: this.repoRoot || null,
      central: this.central,
      originalBranch: this.originalBranch || null,
      baseCommit: this.baseCommit,
      best: this.best,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      mergedBack: this.mergedBack,
      opts: { ...this.opts, agents: this.opts.agents.map(({ cli, name, count }) => ({ cli, name, count })) },
      agents: this.agents.map((a) => ({
        name: a.name,
        cli: a.cli,
        cliName: a.cliName,
        status: a.status,
        iter: a.iter,
        note: a.note,
        startedAt: a.startedAt,
        deadline: a.deadline,
        kept: a.kept,
        discarded: a.discarded,
        crashed: a.crashed,
        lastLog: a.lastLog,
      })),
      results: this.results,
      events: this.events.slice(-200),
    };
  }

  record(agent, iter, fields) {
    const row = {
      t: Date.now(),
      agent: agent ? agent.name : 'orchestrator',
      cli: agent ? agent.cli : '',
      iter,
      commit: fields.commit ? fields.commit.slice(0, 7) : '',
      score: fields.score === undefined || fields.score === null ? null : fields.score,
      status: fields.status,
      desc: fields.desc || '',
      log: fields.log || null,
    };
    this.results.push(row);
    if (agent) {
      if (row.status === 'keep') agent.kept++;
      else if (row.status === 'crash' || row.status === 'error') agent.crashed++;
      else agent.discarded++;
    }
    try {
      const tsv = path.join(this.runDir, 'results.tsv');
      if (!fs.existsSync(tsv)) fs.writeFileSync(tsv, 'time\tagent\titer\tcommit\tscore\tstatus\tdescription\n');
      const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
      fs.appendFileSync(
        tsv,
        [new Date(row.t).toISOString(), row.agent, iter, row.commit, row.score === null ? '' : row.score, row.status, clean(row.desc)].join('\t') + '\n'
      );
    } catch {}
    this.changed();
    return row;
  }

  gitEnv(agent) {
    const name = agent ? `${agent.name} (${agent.cli})` : 'agent-swarm';
    return {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: 'agent-swarm@localhost',
      GIT_COMMITTER_NAME: 'agent-swarm',
      GIT_COMMITTER_EMAIL: 'agent-swarm@localhost',
    };
  }

  async commitAll(cwd, message, agent) {
    const msgFile = path.join(this.runDir, `msg-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(msgFile, message);
    try {
      await git(['add', '-A'], cwd);
      await git(['commit', '-q', '-F', msgFile], cwd, { env: this.gitEnv(agent) });
    } finally {
      fs.rmSync(msgFile, { force: true });
    }
  }

  isBetter(a, b) {
    if (b === null || b === undefined) return true;
    return this.opts.direction === 'min' ? a < b - this.opts.minDelta : a > b + this.opts.minDelta;
  }

  // ----- lifecycle ---------------------------------------------------------

  async start() {
    try {
      await this.prepare();
      this.status = 'running';
      this.phase = 'Đang chạy';
      this.info(`Bắt đầu ${this.agents.length} agent. Nhánh trung tâm: ${this.central}`);
      if (this.opts.maxDurationMin > 0) {
        this._durationTimer = setTimeout(() => {
          this.info(`Hết thời lượng tối đa ${this.opts.maxDurationMin} phút → dừng sau vòng hiện tại.`);
          this.stop('graceful');
        }, this.opts.maxDurationMin * 60000);
      }
      await Promise.all(
        this.agents.map(async (agent, idx) => {
          await this.sleepUnlessStopped(idx * this.opts.staggerSec * 1000);
          await this.agentLoop(agent);
        })
      );
    } catch (e) {
      this.error = e.message;
      this.status = 'error';
      this.info(`Lỗi: ${e.message}`, 'error');
      for (const h of this.handles) h.kill('error');
    } finally {
      clearTimeout(this._durationTimer);
      await this.cleanup();
      if (this.status !== 'error') this.status = 'stopped';
      this.phase = this.status === 'error' ? 'Lỗi' : 'Đã dừng';
      this.endedAt = Date.now();
      if (this._ownsRepo) activeRepos.delete(this.repoRoot.toLowerCase());
      this.info('Kết thúc phiên.');
      this.save();
      this.emit('update', this);
    }
  }

  async sleepUnlessStopped(ms) {
    const end = Date.now() + ms;
    while (!this.stopMode && Date.now() < end) await sleep(Math.min(500, end - Date.now()));
  }

  stop(mode = 'now') {
    if (this.status === 'stopped' || this.status === 'error') return;
    if (mode === 'now') {
      this.stopMode = 'now';
      for (const h of this.handles) h.kill('stopped by user');
    } else if (!this.stopMode) {
      this.stopMode = 'graceful';
    }
    if (this.status === 'running' || this.status === 'preparing') this.status = 'stopping';
    this.phase = mode === 'now' ? 'Đang dừng ngay' : 'Dừng sau vòng hiện tại';
    this.changed();
  }

  async prepare() {
    const o = this.opts;
    fs.mkdirSync(o.workspace, { recursive: true });

    let top = await git(['rev-parse', '--show-toplevel'], o.workspace, { allowFail: true });
    if (top.code !== 0) {
      this.info('Thư mục chưa phải git repo → git init');
      await git(['init'], o.workspace);
      top = await git(['rev-parse', '--show-toplevel'], o.workspace);
    }
    this.repoRoot = path.resolve(top.stdout);
    const rootKey = this.repoRoot.toLowerCase();
    if (activeRepos.has(rootKey)) throw new Error(`Repo ${this.repoRoot} đang có một phiên swarm khác chạy.`);
    activeRepos.add(rootKey);
    this._ownsRepo = true;

    let sub = path.relative(this.repoRoot, o.workspace);
    if (sub.startsWith('..') || path.isAbsolute(sub)) sub = '';
    this.subdir = sub;
    this.lock = repoLock(this.repoRoot);
    const root = this.repoRoot;

    const swarmDir = path.join(root, '.swarm');
    this.runDir = path.join(swarmDir, 'runs', this.id);
    this.wtRoot = path.join(swarmDir, 'wt', this.id);
    fs.mkdirSync(path.join(this.runDir, 'logs'), { recursive: true });

    const commonDir = path.resolve(root, (await git(['rev-parse', '--git-common-dir'], root)).stdout);
    const exclude = path.join(commonDir, 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    const lines = cur.split(/\r?\n/);
    const add = ['/.swarm/', TASK_FILE, NOTE_FILE].filter((l) => !lines.includes(l));
    if (add.length) fs.appendFileSync(exclude, (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');

    const gitDir = path.resolve(root, (await git(['rev-parse', '--git-dir'], root)).stdout);
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
      if (fs.existsSync(path.join(gitDir, marker))) throw new Error('Repo đang dở merge/rebase/cherry-pick. Hãy hoàn tất hoặc huỷ trước.');
    }

    await this.lock.run(async () => {
      const head = await git(['rev-parse', '--verify', 'HEAD'], root, { allowFail: true });
      if (head.code !== 0) {
        this.info('Repo chưa có commit → tạo commit đầu tiên');
        await git(['add', '-A'], root);
        await git(['commit', '-q', '--allow-empty', '-m', 'swarm: initial commit'], root, { env: this.gitEnv(null) });
      }
      this.originalBranch = (await git(['symbolic-ref', '--short', '-q', 'HEAD'], root, { allowFail: true })).stdout || null;
      await git(['checkout', '-q', '-b', this.central], root);
      if ((await changedPaths(root)).length) {
        this.info('Có thay đổi chưa commit → lưu snapshot vào nhánh swarm');
        await this.commitAll(root, 'swarm: snapshot of uncommitted work before run', null);
      }
      this.baseCommit = await revParse('HEAD', root);
      await this.removeStaleWorktrees();

      let n = 0;
      for (const spec of o.agents) {
        for (let k = 0; k < spec.count; k++) {
          n++;
          const name = `agent-${n}`;
          const wt = path.join(this.wtRoot, `a${n}`);
          const branch = `${this.central}-a${n}`;
          this.phase = `Tạo worktree ${name}`;
          this.changed();
          await git(['worktree', 'add', '-q', '-f', '-B', branch, wt, this.central], root);
          this.agents.push({
            name,
            cli: spec.cli,
            cliName: spec.name,
            template: spec.template,
            wt,
            cwd: path.join(wt, this.subdir),
            branch,
            status: 'idle',
            iter: 0,
            note: '',
            startedAt: null,
            deadline: null,
            kept: 0,
            discarded: 0,
            crashed: 0,
            lastLog: null,
          });
        }
      }
    });
    this.info(`Đã tạo ${this.agents.length} worktree tại ${this.wtRoot}`);

    if (!this.stopMode) await this.evaluateBaseline();
  }

  /**
   * Xuất kết quả của phiên ra chuỗi CSV (RFC 4180).
   * Dùng bởi route GET /api/runs/:id/export.csv hoặc SwarmRun.exportCsv().
   */
  exportCsv() {
    const escField = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['time,agent,iter,commit,score,status,description'];
    for (const r of this.results || []) {
      lines.push(
        [
          new Date(r.t).toISOString(),
          r.agent,
          r.iter,
          r.commit,
          r.score === null || r.score === undefined ? '' : r.score,
          r.status,
          r.desc,
        ]
          .map(escField)
          .join(',')
      );
    }
    return lines.join('\r\n') + '\r\n';
  }

  /** Re-baseline: đo lại base commit, ghi kết quả và cập nhật this.best. Dùng lúc start và bởi POST /api/runs/:id/rebaseline. */
  async evaluateBaseline() {
    const o = this.opts;
    if (o.evalMode === 'none' || !o.baseline || !this.baseCommit || !this.agents.length) {
      return { ok: false, score: null, reason: 'phiên không đo được baseline (không dùng chế độ đánh giá hoặc chưa sẵn sàng)' };
    }
    this.phase = 'Đo baseline';
    this.changed();
    const a0 = this.agents[0];
    const logRel = path.join('logs', 'baseline.eval.log');
    const res = await this.evaluate(a0, path.join(this.runDir, logRel));
    if (res.ok) {
      if (o.evalMode === 'score') this.best = { score: res.score, commit: this.baseCommit.slice(0, 7), desc: 'baseline', agent: null };
      this.record(null, 0, { commit: this.baseCommit, score: res.score, status: 'baseline', desc: 'baseline (code ban đầu)', log: logRel });
      this.info(o.evalMode === 'score' ? `Baseline: ${res.score}` : 'Baseline: PASS');
    } else {
      this.record(null, 0, { commit: this.baseCommit, status: 'crash', desc: `baseline lỗi: ${res.reason}`, log: logRel });
      this.info(`Baseline lỗi (${res.reason}). Kết quả đạt đầu tiên sẽ được giữ.`, 'warn');
    }
    return res;
  }

  // ----- agent loop --------------------------------------------------------

  async agentLoop(agent) {
    while (!this.stopMode) {
      if (this.opts.maxIterations && agent.iter >= this.opts.maxIterations) break;
      agent.iter++;
      try {
        await this.iteration(agent, agent.iter);
      } catch (e) {
        this.record(agent, agent.iter, { status: 'error', desc: e.message.slice(0, 300) });
        this.info(`${agent.name} vòng ${agent.iter}: ${e.message}`, 'error');
        await this.sleepUnlessStopped(5000);
      }
    }
    agent.status = 'done';
    agent.deadline = null;
    this.changed();
  }

  /** Puts the worktree exactly at the central head. Retries because Windows may briefly lock files. */
  async syncWorktree(agent) {
    return this.lock.run(async () => {
      const head = await revParse(this.central, this.repoRoot);
      let lastErr;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await git(['rebase', '--abort'], agent.wt, { allowFail: true });
          await git(['reset', '-q', '--hard', head], agent.wt);
          await git(['clean', '-q', '-fd'], agent.wt);
          return head;
        } catch (e) {
          lastErr = e;
          await sleep(2000);
        }
      }
      throw lastErr;
    });
  }

  readNote(agent) {
    try {
      const txt = fs.readFileSync(path.join(agent.cwd, NOTE_FILE), 'utf8');
      const line = txt.split(/\r?\n/).map((s) => s.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean);
      return line ? line.slice(0, 200) : '';
    } catch {
      return '';
    }
  }

  async iteration(agent, it) {
    const o = this.opts;
    const logDir = path.join('logs', agent.name);
    const agentLogRel = path.join(logDir, `iter-${it}.agent.log`);
    const evalLogRel = path.join(logDir, `iter-${it}.eval.log`);
    const agentLog = path.join(this.runDir, agentLogRel);

    agent.status = 'syncing';
    agent.note = '';
    this.changed();
    const base = await this.syncWorktree(agent);

    fs.mkdirSync(agent.cwd, { recursive: true });
    fs.writeFileSync(path.join(agent.cwd, TASK_FILE), this.buildTask(agent, it, base));
    fs.rmSync(path.join(agent.cwd, NOTE_FILE), { force: true });

    // --- run the agent with a hard time limit -------------------------------
    const limitMs = o.timeLimitMin * 60000;
    agent.status = 'working';
    agent.startedAt = Date.now();
    agent.deadline = agent.startedAt + limitMs;
    agent.lastLog = agentLogRel;
    this.changed();
    const cmd = buildAgentCommand(agent.template);
    fs.mkdirSync(path.dirname(agentLog), { recursive: true });
    fs.writeFileSync(agentLog, `[swarm] ${new Date().toISOString()} ${agent.name} iteration ${it}\n[swarm] cwd: ${agent.cwd}\n[swarm] $ ${cmd}\n\n`);
    const handle = runCommand({
      command: cmd,
      cwd: agent.cwd,
      env: { SWARM_AGENT: agent.name, SWARM_RUN: this.id, ...(o.envExtra || {}) },
      logFile: agentLog,
      timeoutMs: limitMs,
    });
    this.handles.add(handle);
    const notePoll = setInterval(() => {
      const note = this.readNote(agent);
      if (note && note !== agent.note) {
        agent.note = note;
        this.changed();
      }
    }, 3000);
    const res = await handle.promise;
    clearInterval(notePoll);
    this.handles.delete(handle);
    agent.deadline = null;
    await sleep(1000); // let Windows release file handles of killed processes

    const note = this.readNote(agent) || agent.note;
    agent.note = note;
    fs.rmSync(path.join(agent.cwd, TASK_FILE), { force: true });
    fs.rmSync(path.join(agent.cwd, NOTE_FILE), { force: true });

    if (this.stopMode === 'now') {
      this.record(agent, it, { status: 'stopped', desc: note || 'dừng bởi người dùng', log: agentLogRel });
      return;
    }
    const how = res.timedOut ? `bị kill sau ${o.timeLimitMin} phút` : `thoát mã ${res.code}`;
    const desc = note || `${agent.name} vòng ${it} (không ghi chú)`;

    // --- collect changes ----------------------------------------------------
    agent.status = 'committing';
    this.changed();
    for (const f of o.protectedFiles) {
      const rel = this.subdir ? path.posix.join(this.subdir.replace(/\\/g, '/'), f) : f;
      const inBase = await git(['cat-file', '-e', `${base}:${rel}`], agent.wt, { allowFail: true });
      if (inBase.code === 0) await git(['checkout', '-q', base, '--', rel], agent.wt, { allowFail: true });
      else fs.rmSync(path.join(agent.wt, rel), { force: true, recursive: true });
    }
    // The agent must not move HEAD; if it committed anyway, fold those commits into the working tree.
    const headNow = await revParse('HEAD', agent.wt);
    if (headNow !== base) await git(['reset', '-q', '--soft', base], agent.wt, { allowFail: true });

    // Some CLIs drop empty files (e.g. logs/*.log) into their cwd; those alone are not a change.
    const changes = await changedPaths(agent.wt);
    const junk = changes.filter((c) => c.xy === '??' && fs.statSync(path.join(agent.wt, c.file), { throwIfNoEntry: false })?.size === 0);
    if (changes.length === junk.length) {
      for (const c of junk) fs.rmSync(path.join(agent.wt, c.file), { force: true });
      // Surface why the agent did nothing (auth / permission errors usually show up in the last line).
      const lastLine = tailFile(agentLog, 4000).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('[swarm]')).pop();
      const why = lastLine ? ` · agent: ${lastLine.slice(0, 200)}` : '';
      this.record(agent, it, { status: 'no-change', desc: `${desc} — ${how}, không có thay đổi${why}`, log: agentLogRel });
      return;
    }
    let commit;
    await this.lock.run(async () => {
      await this.commitAll(agent.wt, `[${agent.name} #${it}] ${desc}\n\nagent: ${agent.cliName}\nrun: ${this.id}\nend: ${how}\n`, agent);
      commit = await revParse('HEAD', agent.wt);
    });

    // --- evaluate + integrate (re-test when the central branch moved) -------
    let curBase = base;
    let score = null;
    for (let attempt = 0; ; attempt++) {
      if (o.evalMode !== 'none') {
        agent.status = 'waiting-eval';
        this.changed();
        const ev = await this.evaluate(agent, path.join(this.runDir, evalLogRel));
        if (this.stopMode === 'now') {
          this.record(agent, it, { commit, status: 'stopped', desc, log: evalLogRel });
          return;
        }
        if (!ev.ok) {
          this.record(agent, it, { commit, score: ev.score, status: 'crash', desc: `${desc} — ${ev.reason}`, log: evalLogRel });
          return;
        }
        score = ev.score;
        if (o.evalMode === 'score' && this.best && !this.isBetter(score, this.best.score)) {
          this.record(agent, it, { commit, score, status: 'discard', desc, log: evalLogRel });
          return;
        }
      }

      agent.status = 'merging';
      this.changed();
      const r = await this.integrate(agent, curBase, score, desc);
      if (r.result === 'keep') {
        this.record(agent, it, { commit: r.commit, score, status: 'keep', desc, log: o.evalMode === 'none' ? agentLogRel : evalLogRel });
        this.info(`✔ ${agent.name} được giữ: ${desc}${score !== null ? ` (${score})` : ''}`);
        return;
      }
      if (r.result === 'retest') {
        if (attempt + 1 >= MAX_RETESTS) {
          this.record(agent, it, { commit: r.commit, score, status: 'discard', desc: `${desc} — nhánh trung tâm thay đổi liên tục`, log: evalLogRel });
          return;
        }
        curBase = r.base;
        commit = r.commit;
        this.info(`${agent.name}: nhánh trung tâm đã tiến lên → rebase và đánh giá lại`);
        continue;
      }
      const label = { conflict: 'conflict', duplicate: 'duplicate', discard: 'discard', failed: 'error' }[r.result] || r.result;
      this.record(agent, it, { commit, score, status: label, desc: `${desc}${r.reason ? ` — ${r.reason}` : ''}`, log: o.evalMode === 'none' ? agentLogRel : evalLogRel });
      return;
    }
  }

  /** Under the repo lock: fast-forward the central branch to the agent's commit, rebasing first if needed. */
  integrate(agent, base, score, desc) {
    return this.lock.run(async () => {
      const central = await revParse(this.central, this.repoRoot);
      if (central !== base) {
        // Drop evaluation artefacts so they cannot block the rebase.
        await git(['reset', '-q', '--hard', 'HEAD'], agent.wt, { allowFail: true });
        await git(['clean', '-q', '-fd'], agent.wt, { allowFail: true });
        const r = await git(['rebase', '-q', central], agent.wt, { allowFail: true, env: this.gitEnv(agent) });
        if (r.code !== 0) {
          await git(['rebase', '--abort'], agent.wt, { allowFail: true });
          return { result: 'conflict', reason: 'xung đột với thay đổi của agent khác' };
        }
        const rebased = await revParse('HEAD', agent.wt);
        if (rebased === central) return { result: 'duplicate', reason: 'thay đổi đã có sẵn trên nhánh trung tâm' };
        if (this.opts.evalMode !== 'none') return { result: 'retest', base: central, commit: rebased };
      }
      const commit = await revParse('HEAD', agent.wt);
      if (this.opts.evalMode === 'score' && this.best && !this.isBetter(score, this.best.score)) {
        return { result: 'discard', reason: `không tốt hơn best ${this.best.score}` };
      }
      try {
        await this.advanceCentral(commit, central);
      } catch (e) {
        const rescue = `${this.central}-rescue-${agent.name}-${agent.iter}`;
        await git(['branch', '-f', rescue, commit], this.repoRoot, { allowFail: true });
        this.info(`Không cập nhật được nhánh trung tâm (${e.message}). Đã lưu vào nhánh ${rescue}`, 'error');
        return { result: 'failed', reason: `không merge được, lưu ở ${rescue}` };
      }
      if (this.opts.evalMode === 'score') {
        this.best = { score, commit: commit.slice(0, 7), desc, agent: agent.name };
        if (this.opts.publishCommand) {
          try {
            const pubLog = this.runDir ? path.join(this.runDir, 'publish.log') : path.join(this.repoRoot, 'publish.log');
            const pubHandle = runCommand({
              command: this.opts.publishCommand,
              cwd: this.opts.workspace || this.repoRoot,
              env: {
                SWARM_AGENT: agent.name,
                SWARM_RUN: this.id,
                SWARM_BEST_SCORE: String(score ?? ''),
                ...(this.opts.envExtra || {}),
              },
              logFile: pubLog,
              timeoutMs: 60000,
            });
            this.handles.add(pubHandle);
            pubHandle.promise.finally(() => this.handles.delete(pubHandle));
          } catch (e) {
            this.info(`publishCommand error: ${e.message}`, 'warn');
          }
        }
      }
      return { result: 'keep', commit };
    });
  }

  async advanceCentral(commit, expectedOld) {
    const root = this.repoRoot;
    const branch = (await git(['symbolic-ref', '--short', '-q', 'HEAD'], root, { allowFail: true })).stdout;
    if (branch === this.central) {
      await git(['merge', '-q', '--ff-only', commit], root);
    } else {
      await git(['update-ref', `refs/heads/${this.central}`, commit, expectedOld], root);
    }
  }

  /** Runs the evaluation command in the agent's worktree. Returns { ok, score, reason }. */
  async evaluate(agent, logFile) {
    const o = this.opts;
    return this.evalSem.run(async () => {
      if (this.stopMode === 'now') return { ok: false, score: null, reason: 'đã dừng' };
      const prevStatus = agent.status;
      agent.status = 'evaluating';
      this.changed();
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `[swarm] ${new Date().toISOString()} eval in ${agent.cwd}\n[swarm] $ ${o.evalCommand}\n\n`);
      const handle = runCommand({
        command: o.evalCommand,
        cwd: agent.cwd,
        env: { SWARM_AGENT: agent.name, SWARM_RUN: this.id, ...(o.envExtra || {}) },
        logFile,
        timeoutMs: o.evalTimeoutMin * 60000,
      });
      this.handles.add(handle);
      const res = await handle.promise;
      this.handles.delete(handle);
      agent.status = prevStatus;
      this.changed();
      if (res.killedReason && res.killedReason !== 'timeout') return { ok: false, score: null, reason: res.killedReason };
      if (res.timedOut) return { ok: false, score: null, reason: `đánh giá quá ${o.evalTimeoutMin} phút` };
      if (o.evalMode === 'pass') {
        return res.code === 0 ? { ok: true, score: null } : { ok: false, score: null, reason: `đánh giá FAIL (mã ${res.code})` };
      }
      const text = tailFile(logFile, 2_000_000);
      const re = new RegExp(o.metricRegex, 'gm');
      let m;
      let last = null;
      while ((m = re.exec(text)) !== null) {
        last = m;
        if (m[0] === '') re.lastIndex++;
      }
      const score = last ? parseFloat(last[1] !== undefined ? last[1] : last[0]) : NaN;
      if (!Number.isFinite(score)) {
        return { ok: false, score: null, reason: `không tìm thấy điểm (mã thoát ${res.code})` };
      }
      return { ok: true, score };
    });
  }

  buildTask(agent, it, base) {
    const o = this.opts;
    const n = this.agents.length;
    const T = o.timeLimitMin;
    const fmtMin = (m) => (m >= 1 ? `${Math.round(m * 10) / 10} minutes` : `${Math.round(m * 60)} seconds`);
    const others = this.agents
      .filter((a) => a !== agent && (a.status === 'working' || a.status === 'waiting-eval' || a.status === 'evaluating') && a.note)
      .map((a) => `- ${a.name}: ${a.note}`);
    const hist = this.results
      .slice(-25)
      .reverse()
      .map((r) => `| ${r.agent} | ${r.status} | ${r.score === null ? '' : r.score} | ${String(r.desc).replace(/\|/g, '/').slice(0, 160)} |`);
    let judge;
    if (o.evalMode === 'score') {
      judge =
        `After you stop, the orchestrator runs \`${o.evalCommand}\` in this directory (timeout ${fmtMin(o.evalTimeoutMin)}) ` +
        `and extracts the metric with the regex \`${o.metricRegex}\`. **${o.direction === 'min' ? 'LOWER' : 'HIGHER'} is better.** ` +
        `Your change is merged only if it beats the current best${this.best ? ` (${this.best.score})` : ''}.\n` +
        `- If that command takes longer than a minute, do NOT run it yourself — you would run out of time. Quick sanity checks (syntax check, a tiny smoke test) are fine.\n` +
        `- A change that crashes the evaluation is thrown away, so be careful.`;
    } else if (o.evalMode === 'pass') {
      judge =
        `After you stop, the orchestrator runs \`${o.evalCommand}\` in this directory (timeout ${fmtMin(o.evalTimeoutMin)}). ` +
        `Your change is merged only if that command exits with code 0. You may run it yourself if it is quick.`;
    } else {
      judge =
        'There is no automatic evaluation: whatever you leave in the working tree is merged if it does not conflict with work other agents merged meanwhile. ' +
        'So leave the project in a working state, and keep changes focused to avoid conflicts.';
    }
    const protectedLine = o.protectedFiles.length
      ? `5. Do NOT modify these protected files (changes are reverted automatically): ${o.protectedFiles.map((f) => `\`${f}\``).join(', ')}.`
      : '5. Do not delete or rewrite unrelated parts of the project.';

    return `# Autonomous improvement task — ${agent.name}, iteration ${it}

You are **${agent.name}**, one of ${n} AI agents working IN PARALLEL on the same project.
Each agent works in its own git worktree (this directory). An orchestrator collects every agent's changes,
evaluates them and merges only the successful ones into the shared central branch \`${this.central}\`.
Every iteration starts again from the latest central branch, so all accepted work accumulates there.

## Goal (from the human)

${o.requirement}

## Hard rules

1. You will be KILLED after ${fmtMin(T)} (wall clock). Pick ONE focused improvement that you can finish in about ${fmtMin(T * 0.6)}. Save files early — unsaved work is lost, half-finished edits get evaluated as they are.
2. FIRST, before changing anything, write ONE short line describing the idea you are about to try into the file \`${NOTE_FILE}\` (example: \`add input validation to the signup form\`). Update it if your idea changes. Other agents read it to avoid duplicating your work, and it becomes the commit message.
3. Do NOT run \`git commit\`, \`git checkout\`, \`git switch\`, \`git reset\`, \`git merge\`, \`git rebase\` or \`git stash\`. The orchestrator commits, evaluates and merges. Read-only git commands (\`git log\`, \`git diff\`, \`git show\`) are fine — \`git log\` shows what has already been accepted.
4. Only work inside this directory. Never touch files outside it.
${protectedLine}
6. Do not modify or delete \`${TASK_FILE}\`. Do not install new dependencies unless the goal requires it.
7. Never ask questions or wait for confirmation — nobody will answer. Decide and act.
8. Build on what is already there. Do not repeat ideas from the history below that were discarded or crashed, unless you have a clearly different take.

## How your work is judged

${judge}

## Current state

- Central branch \`${this.central}\` is at \`${base.slice(0, 7)}\`; this directory matches it exactly.
- Current best: ${o.evalMode === 'score' ? (this.best ? `**${this.best.score}** (${this.best.desc})` : 'not measured yet') : `${this.results.filter((r) => r.status === 'keep').length} change(s) accepted so far`}

## Ideas other agents are working on RIGHT NOW (do not duplicate)

${others.length ? others.join('\n') : '- (none)'}

## Recent experiment history (newest first)

${hist.length ? `| agent | result | score | description |\n|---|---|---|---|\n${hist.join('\n')}` : '(no experiments yet — you are among the first)'}
${o.extraInstructions ? `\n## Additional instructions\n\n${o.extraInstructions}\n` : ''}`;
  }

  // ----- teardown ----------------------------------------------------------

  /** Worktrees left in .swarm/wt by an earlier run that was killed (only one run per repo is active). */
  async removeStaleWorktrees() {
    const root = this.repoRoot;
    await git(['worktree', 'prune'], root, { allowFail: true });
    const list = await git(['worktree', 'list', '--porcelain'], root, { allowFail: true });
    const wtBase = path.join(root, '.swarm', 'wt').toLowerCase() + path.sep;
    let wt = null;
    for (const line of list.stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wt = path.resolve(line.slice(9));
      else if (line.startsWith('branch ') && wt && (wt.toLowerCase() + path.sep).startsWith(wtBase)) {
        await git(['worktree', 'remove', '--force', '--force', wt], root, { allowFail: true });
        await git(['branch', '-q', '-D', line.slice(7).replace(/^refs\/heads\//, '')], root, { allowFail: true });
        this.info(`Đã dọn worktree cũ ${wt}`);
        wt = null;
      }
    }
    try {
      fs.rmSync(path.join(root, '.swarm', 'wt'), { recursive: true, force: true, maxRetries: 3 });
    } catch {}
    await git(['worktree', 'prune'], root, { allowFail: true });
  }

  async cleanup() {
    for (const h of this.handles) h.kill('shutdown');
    if (!this.lock || !this.agents.length || this.opts.keepWorktrees) return;
    this.phase = 'Dọn worktree';
    this.changed();
    await this.lock.run(async () => {
      for (const a of this.agents) {
        let removed = false;
        for (let attempt = 0; attempt < 3 && !removed; attempt++) {
          const r = await git(['worktree', 'remove', '--force', '--force', a.wt], this.repoRoot, { allowFail: true });
          removed = r.code === 0 || !fs.existsSync(a.wt);
          if (!removed) await sleep(2000);
        }
        if (!removed) {
          try {
            fs.rmSync(a.wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
          } catch (e) {
            this.info(`Không xoá được ${a.wt}: ${e.message}`, 'warn');
          }
        }
        await git(['branch', '-q', '-D', a.branch], this.repoRoot, { allowFail: true });
      }
      await git(['worktree', 'prune'], this.repoRoot, { allowFail: true });
      try {
        fs.rmSync(this.wtRoot, { recursive: true, force: true, maxRetries: 3 });
      } catch {}
    });
  }

  /** After the run: merge the central branch back into the branch the user started from. */
  async mergeBack() {
    if (this.status !== 'stopped') throw new Error('Chỉ merge khi phiên đã dừng.');
    if (!this.originalBranch) throw new Error('Lúc bắt đầu repo không ở trên nhánh nào (detached HEAD).');
    const root = this.repoRoot;
    return this.lock.run(async () => {
      if ((await changedPaths(root)).length) throw new Error('Thư mục dự án đang có thay đổi chưa commit. Hãy commit hoặc huỷ trước.');
      await git(['checkout', '-q', this.originalBranch], root);
      const ff = await git(['merge', '-q', '--ff-only', this.central], root, { allowFail: true });
      if (ff.code !== 0) {
        const m = await git(['merge', '-q', '--no-edit', this.central], root, { allowFail: true, env: this.gitEnv(null) });
        if (m.code !== 0) {
          await git(['merge', '--abort'], root, { allowFail: true });
          throw new Error(`Merge bị xung đột: ${m.stderr || m.stdout}`);
        }
      }
      this.mergedBack = { branch: this.originalBranch, at: Date.now() };
      this.info(`Đã merge ${this.central} vào ${this.originalBranch}`);
      this.save();
      return this.mergedBack;
    });
  }
}

module.exports = { SwarmRun, normalizeOptions, TASK_FILE, NOTE_FILE };
