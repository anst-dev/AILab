'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SwarmRun, normalizeOptions } = require('./swarm');
const { getCatalog, KNOWN_AGENTS } = require('./agents');
const { Coordinator } = require('./coordinator');
const { git, changedPaths } = require('./git');
const { killAll, IS_WIN } = require('./proc');
const { tailFile } = require('./util');

const APP_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = process.env.SWARM_DATA_DIR ? path.resolve(process.env.SWARM_DATA_DIR) : path.join(APP_DIR, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const runs = new Map(); // id -> SwarmRun (runs started in this session)
let shutdownHook = null; // set by main(); lets POST /api/shutdown stop a background server cleanly
const sseClients = new Set();

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { agents: {}, custom: [], recentWorkspaces: [] };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function rememberWorkspace(root) {
  const cfg = loadConfig();
  const list = (cfg.recentWorkspaces || []).filter((p) => p.toLowerCase() !== root.toLowerCase());
  list.unshift(root);
  cfg.recentWorkspaces = list.slice(0, 20);
  saveConfig(cfg);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Body quá lớn'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const txt = Buffer.concat(chunks).toString('utf8');
        resolve(txt ? JSON.parse(txt) : {});
      } catch {
        reject(new Error('JSON không hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

function broadcast(run) {
  const payload = `event: run\ndata: ${JSON.stringify(run.snapshot())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// ---------------------------------------------------------------------------
// export csv
// ---------------------------------------------------------------------------

/** Value → CSV field: chứa dấu phẩy, dấu " hoặc xuống dòng → bọc " và escape " thành "". */
function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** results (mảng row trong bộ nhớ) → CSV, cột time,agent,iter,commit,score,status,description. */
function resultsCsv(rows) {
  const lines = ['time,agent,iter,commit,score,status,description'];
  for (const r of rows || []) {
    lines.push(
      [new Date(r.t).toISOString(), r.agent, r.iter, r.commit, r.score === null || r.score === undefined ? '' : r.score, r.status, r.desc]
        .map(csvField)
        .join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** Nội dung results.tsv → CSV (giữ nguyên thứ tự cột, mỗi cột escape theo CSV). */
function tsvTextToCsv(txt) {
  const lines = txt.split(/\r?\n/).filter((l) => l.length);
  return lines.map((l) => l.split('\t').map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Dòng JSONL trong improvements_log.jsonl → CSV (cột ts,bot,kind,feature,commit,score,status,note). */
function knowledgeCsv(lines) {
  const cols = ['ts', 'bot', 'kind', 'feature', 'commit', 'score', 'status', 'note'];
  const out = [cols.join(',')];
  for (const line of lines || []) {
    const trimmed = (line || '').replace(/\r$/, '').trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      out.push(cols.map((col) => csvField(obj[col])).join(','));
    } catch {
      out.push(cols.map((col) => (col === 'feature' ? csvField(trimmed) : '')).join(','));
    }
  }
  return out.join('\r\n') + '\r\n';
}

/** Runs recorded on disk under <repo>/.swarm/runs of recently used workspaces. */
function historyRuns() {
  const out = [];
  for (const root of loadConfig().recentWorkspaces || []) {
    const dir = path.join(root, '.swarm', 'runs');
    let ids = [];
    try {
      ids = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (runs.has(id)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, id, 'state.json'), 'utf8'));
        out.push(summary(s, false));
      } catch {}
    }
  }
  return out;
}

function summary(s, live) {
  const results = Array.isArray(s && s.results) ? s.results : [];
  const agents = Array.isArray(s && s.agents) ? s.agents : [];
  const count = (st) => results.filter((r) => r.status === st).length;
  return {
    id: s.id,
    live,
    status: live || s.status === 'stopped' || s.status === 'error' ? s.status : 'interrupted',
    workspace: s.workspace,
    repoRoot: s.repoRoot,
    requirement: (s.opts && s.opts.requirement) || '',
    agents: agents.length,
    best: s.best,
    kept: count('keep'),
    total: results.filter((r) => r.agent !== 'orchestrator').length,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

function findSnapshot(id, repo) {
  if (runs.has(id)) return { snap: runs.get(id).snapshot(), run: runs.get(id) };
  const roots = repo ? [repo] : loadConfig().recentWorkspaces || [];
  for (const root of roots) {
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(root, '.swarm', 'runs', id, 'state.json'), 'utf8'));
      if (snap.status !== 'stopped' && snap.status !== 'error') snap.status = 'interrupted';
      return { snap, run: null };
    } catch {}
  }
  return null;
}

async function inspect(p) {
  const info = { path: p, exists: false, isDir: false, isRepo: false };
  if (!p || !path.isAbsolute(p)) return { ...info, error: 'Cần đường dẫn tuyệt đối.' };
  info.exists = fs.existsSync(p);
  if (!info.exists) return { ...info, note: 'Thư mục chưa tồn tại → sẽ được tạo và git init khi bắt đầu.' };
  info.isDir = fs.statSync(p).isDirectory();
  if (!info.isDir) return { ...info, error: 'Đây là file, không phải thư mục.' };
  try {
    info.files = fs.readdirSync(p).filter((f) => f !== '.git' && f !== '.swarm').slice(0, 40);
  } catch {
    info.files = [];
  }
  const top = await git(['rev-parse', '--show-toplevel'], p, { allowFail: true });
  if (top.code !== 0) return { ...info, note: 'Chưa phải git repo → sẽ git init và commit toàn bộ thư mục khi bắt đầu.' };
  info.isRepo = true;
  info.root = path.resolve(top.stdout);
  info.branch = (await git(['symbolic-ref', '--short', '-q', 'HEAD'], p, { allowFail: true })).stdout || '(detached)';
  const head = await git(['log', '-1', '--format=%h %s'], p, { allowFail: true });
  info.head = head.code === 0 ? head.stdout : '(chưa có commit)';
  try {
    info.dirty = (await changedPaths(info.root)).length;
  } catch {
    info.dirty = 0;
  }
  info.hasProgram = fs.existsSync(path.join(p, 'program.md'));
  info.hasTrainPy = fs.existsSync(path.join(p, 'train.py'));
  return info;
}

async function gitLog(run, snap) {
  const root = snap.repoRoot;
  if (!root || !snap.baseCommit) return [];
  const r = await git(['log', '--format=%h%x1f%an%x1f%ar%x1f%s', '-n', '200', `${snap.baseCommit}..${snap.central}`], root, { allowFail: true });
  if (r.code !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').map((l) => {
    const [hash, author, when, subject] = l.split('\x1f');
    return { hash, author, when, subject };
  });
}

async function gitDiff(snap, { from, to, statOnly } = {}) {
  const root = snap && snap.repoRoot;
  if (!root || !snap.baseCommit) return '';
  const refA = from || snap.baseCommit;
  const refB = to || snap.central || 'HEAD';
  const args = ['diff'];
  if (statOnly) args.push('--stat');
  args.push(`${refA}..${refB}`);
  const r = await git(args, root, { allowFail: true });
  return r.code === 0 ? r.stdout : '';
}

/** Validates options and starts a run. Throws an Error with .status on failure; returns the run id. */
async function startRun(body) {
  const catalog = await getCatalog(loadConfig());
  const { opts, errors } = normalizeOptions(body, catalog);
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  if (errors.length) throw fail(400, errors.join('\n'));
  for (const r of runs.values()) {
    if ((r.status === 'running' || r.status === 'preparing' || r.status === 'stopping') && r.repoRoot && opts.workspace.toLowerCase().startsWith(r.repoRoot.toLowerCase())) {
      throw fail(409, 'Thư mục này đang có phiên chạy. Hãy dừng phiên đó trước.');
    }
  }
  const run = new SwarmRun(opts);
  runs.set(run.id, run);
  run.on('update', broadcast);
  run.start().finally(() => {
    broadcast(run);
    coordinator.runEnded(run.snapshot());
  });
  // remember the workspace once its repo root is known
  const remember = setInterval(() => {
    if (run.repoRoot || run.status === 'error' || run.status === 'stopped') {
      clearInterval(remember);
      if (run.repoRoot) rememberWorkspace(run.repoRoot);
    }
  }, 200);
  broadcast(run);
  return run.id;
}

function sse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

const coordinator = new Coordinator({
  dataDir: DATA_DIR,
  ops: {
    catalog: () => getCatalog(loadConfig()),
    config: loadConfig,
    setTemplate: async (cli, template) => {
      if (!template.trim()) throw new Error('Lệnh trống.');
      const cfg = loadConfig();
      const custom = (cfg.custom || []).find((c) => c.id === cli);
      if (custom) custom.template = template.trim();
      else if (KNOWN_AGENTS.some((a) => a.id === cli)) (cfg.agents = cfg.agents || {})[cli] = { template: template.trim() };
      else throw new Error(`Không có agent CLI "${cli}".`);
      saveConfig(cfg);
    },
    listRuns: () => [...[...runs.values()].map((r) => summary(r.snapshot(), true)), ...historyRuns()].sort((a, b) => b.startedAt - a.startedAt),
    getRun: async (id) => {
      const found = findSnapshot(String(id || ''), '');
      if (!found) throw new Error(`Không tìm thấy phiên ${id}.`);
      return found.snap;
    },
    startRun,
    stopRun: async (id, mode) => {
      const run = runs.get(String(id || ''));
      if (!run) throw new Error(`Phiên ${id} không còn chạy.`);
      run.stop(mode);
    },
    mergeRun: async (id) => {
      const run = runs.get(String(id || ''));
      if (!run) throw new Error(`Chỉ merge được phiên chạy trong lần mở app này.`);
      return run.mergeBack();
    },
    rebaselineRun: async (id) => {
      const run = runs.get(String(id || ''));
      if (!run) throw new Error(`Phiên ${id} không còn chạy trong app.`);
      const resBase = await run.evaluateBaseline();
      if (resBase && !resBase.ok) throw new Error(resBase.reason || 'Không đo được baseline');
      return { ok: true, best: run.best };
    },
    exportRunCsv: async (id) => {
      const run = runs.get(String(id || ''));
      if (run) return typeof run.exportCsv === 'function' ? run.exportCsv() : resultsCsv(run.results);
      const roots = [...(loadConfig().recentWorkspaces || [])];
      const found = findSnapshot(String(id || ''), '');
      if (found && found.snap && found.snap.repoRoot && !roots.includes(found.snap.repoRoot)) {
        roots.unshift(found.snap.repoRoot);
      }
      for (const root of roots) {
        try {
          return tsvTextToCsv(fs.readFileSync(path.join(root, '.swarm', 'runs', String(id || ''), 'results.tsv'), 'utf8'));
        } catch {
          try {
            const snap = JSON.parse(fs.readFileSync(path.join(root, '.swarm', 'runs', String(id || ''), 'state.json'), 'utf8'));
            if (snap && Array.isArray(snap.results) && snap.results.length) {
              return resultsCsv(snap.results);
            }
          } catch {}
        }
      }
      throw new Error(`Không tìm thấy kết quả của phiên ${id}.`);
    },
    exportRunJson: async (id) => {
      const found = findSnapshot(String(id || ''), '');
      if (!found) throw new Error(`Không tìm thấy phiên ${id}.`);
      return found.snap;
    },
    listRunLogs: async (id) => {
      const found = findSnapshot(String(id || ''), '');
      if (!found) throw new Error(`Không tìm thấy phiên ${id}.`);
      const snap = found.snap;
      const runDir = path.join(snap.repoRoot || '', '.swarm', 'runs', String(id || ''));
      if (!snap.repoRoot || !fs.existsSync(runDir)) return [];
      try {
        const entries = fs.readdirSync(runDir, { withFileTypes: true });
        const files = [];
        for (const ent of entries) {
          if (ent.isFile()) {
            try {
              const st = fs.statSync(path.join(runDir, ent.name));
              files.push({ name: ent.name, size: st.size, mtime: st.mtimeMs });
            } catch {}
          }
        }
        return files;
      } catch (e) {
        return [];
      }
    },
    gitLog: async (id) => {
      const found = findSnapshot(String(id || ''), '');
      if (!found) throw new Error(`Không tìm thấy phiên ${id}.`);
      return gitLog(found.run, found.snap);
    },
    gitDiff: async (id, { from, to, statOnly } = {}) => {
      const found = findSnapshot(String(id || ''), '');
      if (!found) throw new Error(`Không tìm thấy phiên ${id}.`);
      return gitDiff(found.snap, { from, to, statOnly });
    },
    deleteRun: async (id, repo) => {
      const runId = String(id || '');
      const run = runs.get(runId);
      if (run && (run.status === 'running' || run.status === 'preparing' || run.status === 'stopping')) {
        throw new Error('Phiên đang chạy, vui lòng dừng trước khi xóa.');
      }
      const found = findSnapshot(runId, repo || '');
      if (!found && !run) throw new Error(`Không tìm thấy phiên ${runId}.`);
      const roots = [];
      if (repo) roots.push(repo);
      if (found && found.snap && found.snap.repoRoot) roots.push(found.snap.repoRoot);
      if (run && run.repoRoot) roots.push(run.repoRoot);
      roots.push(...(loadConfig().recentWorkspaces || []));
      let deleted = false;
      for (const root of roots) {
        const runDir = path.join(root, '.swarm', 'runs', runId);
        if (fs.existsSync(runDir)) {
          fs.rmSync(runDir, { recursive: true, force: true });
          deleted = true;
          git(['branch', '-D', `swarm/${runId}`], root, { allowFail: true }).catch(() => {});
          break;
        }
      }
      if (run) {
        runs.delete(runId);
        deleted = true;
      }
      if (!deleted) throw new Error(`Không tìm thấy thư mục lưu trữ của phiên ${runId}.`);
      if (typeof coordinator.runDeleted === 'function') coordinator.runDeleted(runId);
      return { ok: true, id: runId };
    },
    inspect,
    harvest: async () => {
      const harvestPath = path.join(APP_DIR, 'harvest.js');
      if (!fs.existsSync(harvestPath)) throw new Error('Không tìm thấy file harvest.js.');
      const harvestMod = require(harvestPath);
      if (typeof harvestMod.runHarvest !== 'function') throw new Error('harvest.js không có hàm runHarvest.');
      return harvestMod.runHarvest();
    },
    stats: async () => {
      const harvestPath = path.join(APP_DIR, 'harvest.js');
      if (!fs.existsSync(harvestPath)) throw new Error('Không tìm thấy file harvest.js.');
      const harvestMod = require(harvestPath);
      if (typeof harvestMod.computeStats !== 'function') throw new Error('harvest.js không có hàm computeStats.');
      const logPath = typeof harvestMod.getOutPath === 'function' ? harvestMod.getOutPath() : path.join(APP_DIR, 'knowledge', 'improvements_log.jsonl');
      return harvestMod.computeStats(logPath);
    },
    exportHarvestCsv: async () => {
      const harvestPath = path.join(APP_DIR, 'harvest.js');
      const harvestMod = fs.existsSync(harvestPath) ? require(harvestPath) : null;
      const logPath = harvestMod && typeof harvestMod.getOutPath === 'function'
        ? harvestMod.getOutPath()
        : path.join(APP_DIR, 'knowledge', 'improvements_log.jsonl');
      if (!fs.existsSync(logPath)) throw new Error('Chưa có file improvements_log.jsonl. Hãy bấm gom log trước.');
      const raw = fs.readFileSync(logPath, 'utf8').split('\n');
      return knowledgeCsv(raw);
    },
    exportHarvestJson: async () => {
      const harvestPath = path.join(APP_DIR, 'harvest.js');
      const harvestMod = fs.existsSync(harvestPath) ? require(harvestPath) : null;
      const logPath = harvestMod && typeof harvestMod.getOutPath === 'function'
        ? harvestMod.getOutPath()
        : path.join(APP_DIR, 'knowledge', 'improvements_log.jsonl');
      if (!fs.existsSync(logPath)) throw new Error('Chưa có file improvements_log.jsonl. Hãy bấm gom log trước.');
      const raw = fs.readFileSync(logPath, 'utf8').split('\n');
      const items = [];
      for (const line of raw) {
        const trimmed = (line || '').replace(/\r$/, '').trim();
        if (!trimmed) continue;
        try { items.push(JSON.parse(trimmed)); } catch { items.push({ raw: trimmed }); }
      }
      return items;
    },
    shutdown: async () => {
      setTimeout(() => {
        if (shutdownHook) shutdownHook();
        else process.exit(0);
      }, 200);
      return { ok: true, message: 'Server đang tắt...' };
    },
  },
});
coordinator.on('message', (m) => sse('chat', m));
coordinator.on('busy', (busy) => sse('chatbusy', { busy }));
coordinator.on('cleared', () => sse('chatclear', {}));

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = p.match(/^\/api\/runs\/([\w-]+)(?:\/(\w+))?$/);
  const mCsv = p.match(/^\/api\/runs\/([\w-]+)\/export\.csv$/);
  const mJson = p.match(/^\/api\/runs\/([\w-]+)\/export\.json$/);

  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    for (const run of runs.values()) res.write(`event: run\ndata: ${JSON.stringify(run.snapshot())}\n\n`);
    res.write(`event: chatbusy\ndata: ${JSON.stringify({ busy: coordinator.busy })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && p === '/api/catalog') {
    const cfg = loadConfig();
    const ar = path.resolve(APP_DIR, '..', 'autoresearch');
    const suggested = fs.existsSync(path.join(ar, 'train.py')) ? { autoresearch: ar } : {};
    return send(res, 200, { agents: await getCatalog(cfg), recentWorkspaces: cfg.recentWorkspaces || [], suggested, platform: process.platform, coordinator: cfg.coordinator || {} });
  }

  if (req.method === 'POST' && p === '/api/config/agents') {
    const body = await readBody(req);
    const cfg = loadConfig();
    cfg.agents = {};
    for (const [id, v] of Object.entries(body.agents || {})) {
      if (v && typeof v.template === 'string' && v.template.trim()) cfg.agents[id] = { template: v.template.trim() };
    }
    cfg.custom = (Array.isArray(body.custom) ? body.custom : [])
      .filter((c) => c && c.name && c.template)
      .map((c) => ({ id: String(c.id || c.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-'), name: String(c.name), template: String(c.template).trim() }));
    saveConfig(cfg);
    return send(res, 200, { agents: await getCatalog(cfg) });
  }

  if (req.method === 'GET' && p === '/api/inspect') {
    return send(res, 200, await inspect(String(url.searchParams.get('path') || '').trim()));
  }

  if (req.method === 'GET' && p === '/api/runs') {
    const live = [...runs.values()].map((r) => summary(r.snapshot(), true));
    const all = [...live, ...historyRuns()].sort((a, b) => b.startedAt - a.startedAt);
    return send(res, 200, all);
  }

  if (req.method === 'POST' && p === '/api/runs') {
    try {
      return send(res, 200, { id: await startRun(await readBody(req)) });
    } catch (e) {
      return send(res, e.status || 400, { error: e.message });
    }
  }

  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { app: 'agent-swarm', pid: process.pid });

  if (req.method === 'POST' && p === '/api/shutdown') {
    send(res, 200, { ok: true });
    if (shutdownHook) setTimeout(shutdownHook, 100);
    return;
  }

  if (req.method === 'GET' && p === '/api/chat') return send(res, 200, coordinator.state());

  if (req.method === 'POST' && p === '/api/chat') {
    const body = await readBody(req);
    try {
      return send(res, 200, coordinator.send(body.message));
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  if (req.method === 'POST' && p === '/api/chat/clear') {
    coordinator.clear();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/harvest') {
    try {
      const harvestPath = path.join(APP_DIR, 'harvest.js');
      if (!fs.existsSync(harvestPath)) return send(res, 404, { error: 'Không tìm thấy file harvest.js.' });
      const harvestMod = require(harvestPath);
      if (typeof harvestMod.runHarvest !== 'function') return send(res, 500, { error: 'harvest.js không có hàm runHarvest.' });
      return send(res, 200, { ok: true, ...harvestMod.runHarvest() });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === 'GET' && p === '/api/harvest') {
    try {
      const harvestPath = path.join(APP_DIR, 'harvest.js');
      const harvestMod = fs.existsSync(harvestPath) ? require(harvestPath) : null;
      const logPath = harvestMod && typeof harvestMod.getOutPath === 'function'
        ? harvestMod.getOutPath()
        : path.join(APP_DIR, 'knowledge', 'improvements_log.jsonl');
      if (!fs.existsSync(logPath)) {
        return send(res, 200, { ok: true, exists: false, totalCount: 0, items: [], stats: null });
      }
      const lines = fs.readFileSync(logPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      const items = [];
      const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      const tail = lines.slice(-limit);
      for (const line of tail) {
        try { items.push(JSON.parse(line)); } catch { items.push({ raw: line }); }
      }
      const stats = harvestMod && typeof harvestMod.computeStats === 'function' ? harvestMod.computeStats(logPath) : null;
      return send(res, 200, {
        ok: true,
        exists: true,
        totalCount: lines.length,
        outPath: logPath,
        items,
        stats,
      });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === 'GET' && (p === '/api/harvest/export.csv' || (p === '/api/harvest/download' && url.searchParams.get('format') === 'csv'))) {
    try {
      const harvestPath = path.join(APP_DIR, 'harvest.js');
      const harvestMod = fs.existsSync(harvestPath) ? require(harvestPath) : null;
      const logPath = harvestMod && typeof harvestMod.getOutPath === 'function'
        ? harvestMod.getOutPath()
        : path.join(APP_DIR, 'knowledge', 'improvements_log.jsonl');
      if (!fs.existsSync(logPath)) {
        return send(res, 404, { error: 'Chưa có file improvements_log.jsonl. Hãy bấm gom log trước.' });
      }
      const raw = fs.readFileSync(logPath, 'utf8').split('\n');
      const csv = knowledgeCsv(raw);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="improvements_log.csv"',
        'Cache-Control': 'no-store',
      });
      return res.end(csv);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === 'GET' && (p === '/api/harvest/export.json' || (p === '/api/harvest/download' && url.searchParams.get('format') === 'json'))) {
    try {
      const harvestPath = path.join(APP_DIR, 'harvest.js');
      const harvestMod = fs.existsSync(harvestPath) ? require(harvestPath) : null;
      const logPath = harvestMod && typeof harvestMod.getOutPath === 'function'
        ? harvestMod.getOutPath()
        : path.join(APP_DIR, 'knowledge', 'improvements_log.jsonl');
      if (!fs.existsSync(logPath)) {
        return send(res, 404, { error: 'Chưa có file improvements_log.jsonl. Hãy bấm gom log trước.' });
      }
      const raw = fs.readFileSync(logPath, 'utf8').split('\n');
      const items = [];
      for (const line of raw) {
        const trimmed = (line || '').replace(/\r$/, '').trim();
        if (!trimmed) continue;
        try {
          items.push(JSON.parse(trimmed));
        } catch {
          items.push({ raw: trimmed });
        }
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="improvements_log.json"',
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify(items, null, 2));
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === 'GET' && p === '/api/harvest/download') {
    try {
      const harvestPath = path.join(APP_DIR, 'harvest.js');
      const harvestMod = fs.existsSync(harvestPath) ? require(harvestPath) : null;
      const logPath = harvestMod && typeof harvestMod.getOutPath === 'function'
        ? harvestMod.getOutPath()
        : path.join(APP_DIR, 'knowledge', 'improvements_log.jsonl');
      if (!fs.existsSync(logPath)) {
        return send(res, 404, { error: 'Chưa có file improvements_log.jsonl. Hãy bấm gom log trước.' });
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': 'attachment; filename="improvements_log.jsonl"',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(logPath).pipe(res);
      return;
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && p === '/api/config/coordinator') {
    const body = await readBody(req);
    const cfg = loadConfig();
    cfg.coordinator = { cli: String(body.cli || ''), template: String(body.template || '').trim() };
    saveConfig(cfg);
    return send(res, 200, cfg.coordinator);
  }

  if (req.method === 'GET' && mCsv) {
    const id = mCsv[1];
    const run = runs.get(id);
    let csv = null;
    if (run) {
      csv = typeof run.exportCsv === 'function' ? run.exportCsv() : resultsCsv(run.results);
    } else {
      // phiên cũ không còn trong bộ nhớ: đọc lại results.tsv trên đĩa nếu có
      const roots = [];
      const repo = url.searchParams.get('repo');
      if (repo) roots.push(repo);
      roots.push(...(loadConfig().recentWorkspaces || []));
      for (const root of roots) {
        try {
          csv = tsvTextToCsv(fs.readFileSync(path.join(root, '.swarm', 'runs', id, 'results.tsv'), 'utf8'));
          break;
        } catch {
          try {
            const snap = JSON.parse(fs.readFileSync(path.join(root, '.swarm', 'runs', id, 'state.json'), 'utf8'));
            if (snap && Array.isArray(snap.results) && snap.results.length) {
              csv = resultsCsv(snap.results);
              break;
            }
          } catch {}
        }
      }
    }
    if (csv === null) return send(res, 400, { error: `Không export được CSV: không tìm thấy phiên ${id} hoặc file results.tsv của phiên.` });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="results-${id}.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  if (req.method === 'GET' && mJson) {
    const id = mJson[1];
    const repo = url.searchParams.get('repo') || '';
    const found = findSnapshot(id, repo);
    if (!found) return send(res, 404, { error: `Không export được JSON: không tìm thấy phiên ${id}.` });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="run-${id}.json"`,
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify(found.snap, null, 2));
  }

  if (m) {
    const [, id, action] = m;
    const repo = url.searchParams.get('repo') || '';
    const found = findSnapshot(id, repo);
    if (!found) return send(res, 404, { error: 'Không tìm thấy phiên.' });
    const { snap, run } = found;

    if (req.method === 'GET' && !action) return send(res, 200, snap);

    if (req.method === 'DELETE' && !action) {
      if (run && (run.status === 'running' || run.status === 'preparing' || run.status === 'stopping')) {
        return send(res, 400, { error: 'Phiên đang chạy, vui lòng dừng trước khi xóa.' });
      }
      const roots = [];
      if (repo) roots.push(repo);
      if (snap.repoRoot) roots.push(snap.repoRoot);
      roots.push(...(loadConfig().recentWorkspaces || []));
      let deleted = false;
      for (const root of roots) {
        const runDir = path.join(root, '.swarm', 'runs', id);
        if (fs.existsSync(runDir)) {
          try {
            fs.rmSync(runDir, { recursive: true, force: true });
            deleted = true;
            git(['branch', '-D', `swarm/${id}`], root, { allowFail: true }).catch(() => {});
            break;
          } catch (e) {
            return send(res, 500, { error: `Không thể xóa thư mục phiên: ${e.message}` });
          }
        }
      }
      if (run) {
        runs.delete(id);
        deleted = true;
      }
      if (!deleted) return send(res, 404, { error: `Không tìm thấy dữ liệu thư mục của phiên ${id} để xóa.` });
      if (coordinator && typeof coordinator.runDeleted === 'function') coordinator.runDeleted(id);
      return send(res, 200, { ok: true, id, message: `Đã xóa phiên ${id}` });
    }

    if (req.method === 'GET' && action === 'gitlog') return send(res, 200, await gitLog(run, snap));

    if (req.method === 'GET' && action === 'diff') {
      const statOnly = url.searchParams.get('stat') === '1' || url.searchParams.get('stat') === 'true';
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      const diff = await gitDiff(snap, { from, to, statOnly });
      return send(res, 200, diff, 'text/plain; charset=utf-8');
    }

    if (req.method === 'GET' && action === 'logs') {
      const runDir = path.join(snap.repoRoot || '', '.swarm', 'runs', id);
      if (!snap.repoRoot || !fs.existsSync(runDir)) return send(res, 200, { files: [] });
      try {
        const entries = fs.readdirSync(runDir, { withFileTypes: true });
        const files = [];
        for (const ent of entries) {
          if (ent.isFile()) {
            try {
              const st = fs.statSync(path.join(runDir, ent.name));
              files.push({ name: ent.name, size: st.size, mtime: st.mtimeMs });
            } catch {}
          }
        }
        return send(res, 200, { files });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    if (req.method === 'GET' && action === 'log') {
      const rel = String(url.searchParams.get('file') || '');
      const runDir = path.join(snap.repoRoot || '', '.swarm', 'runs', id);
      const file = path.resolve(runDir, rel);
      if (!snap.repoRoot || !rel || !file.toLowerCase().startsWith(runDir.toLowerCase() + path.sep)) return send(res, 400, { error: 'File log không hợp lệ.' });
      return send(res, 200, tailFile(file, 300000) || '(log trống)', 'text/plain; charset=utf-8');
    }

    if (req.method === 'POST' && action === 'stop') {
      if (!run) return send(res, 400, { error: 'Phiên không còn chạy.' });
      const body = await readBody(req);
      run.stop(body.mode === 'graceful' ? 'graceful' : 'now');
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && action === 'merge') {
      if (!run) return send(res, 400, { error: 'Chỉ merge được phiên chạy trong lần mở app này. Hãy dùng git: git checkout <nhánh gốc> && git merge ' + snap.central });
      try {
        return send(res, 200, await run.mergeBack());
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    if (req.method === 'POST' && action === 'rebaseline') {
      if (!run) return send(res, 400, { error: 'Phiên không còn chạy trong app — dùng git + evaluate.py thủ công.' });
      try {
        const resBase = await run.evaluateBaseline();
        if (resBase && !resBase.ok) {
          return send(res, 400, { error: resBase.reason || 'Không đo được baseline' });
        }
        return send(res, 200, { ok: true, best: run.best });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
  }

  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  }

  send(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------

/** True when http://127.0.0.1:port really reaches this process (Windows can let two apps bind the same port). */
async function isOwnPort(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return (await r.json()).pid === process.pid;
  } catch {
    return false;
  }
}

/** Listens on the first free port from `port` up; a fresh server per attempt (a closed one can't be reused). */
function listen(createServer, port, attempts = 20) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      const server = createServer();
      const next = (e) => (left > 0 ? tryPort(p + 1, left - 1) : reject(e));
      server.once('error', (e) => (e.code === 'EADDRINUSE' || e.code === 'EACCES' ? next(e) : reject(e)));
      server.listen(p, '127.0.0.1', async () => {
        if (await isOwnPort(p)) return resolve(p);
        server.close();
        next(new Error(`Cổng ${p} bị app khác chiếm`));
      });
    };
    tryPort(port, attempts);
  });
}

function openBrowser(url) {
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

const SERVER_FILE = path.join(DATA_DIR, 'server.json');
const SERVER_LOG = path.join(DATA_DIR, 'server.log');

/** { pid, port, url } of a background server that still answers, or null. */
async function runningServer() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
  } catch {
    return null;
  }
  try {
    const r = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(3000) });
    return (await r.json()).pid === info.pid ? info : null;
  } catch {
    return null;
  }
}

/** --background / --stop / --status: manage a detached server, then exit. */
async function control(args) {
  const info = await runningServer();
  if (args.includes('--status')) {
    console.log(info ? `Đang chạy nền tại ${info.url} (pid ${info.pid})` : 'Không có server chạy nền.');
    return;
  }
  if (args.includes('--stop')) {
    if (!info) return console.log('Không có server chạy nền.');
    await fetch(`${info.url}/api/shutdown`, { method: 'POST' }).catch(() => {});
    console.log(`Đã yêu cầu dừng server ${info.url} (các agent đang chạy sẽ bị kill, worktree được dọn).`);
    return;
  }
  if (info) {
    console.log(`Đã có server chạy nền tại ${info.url}`);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.unlinkSync(SERVER_FILE); } catch {}
  const fd = fs.openSync(SERVER_LOG, 'a');
  const rest = args.filter((a) => a !== '--background');
  const child = spawn(process.execPath, [__filename, '--no-open', ...rest], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: process.env });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const ok = await runningServer();
    if (ok) {
      console.log(`Agent Swarm chạy nền tại ${ok.url} (pid ${ok.pid}). Log: ${SERVER_LOG}`);
      console.log('Nhắn cho agent điều phối: node src/chat.js "yêu cầu của bạn"   |   Dừng: node src/server.js --stop');
      if (args.includes('--open')) openBrowser(ok.url);
      return;
    }
  }
  console.log(`Server chưa phản hồi, xem log: ${SERVER_LOG}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => ['--background', '--stop', '--status'].includes(a))) return control(args);

  const createServer = () =>
    http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) send(res, 500, { error: e.message });
        else res.end();
      });
    });
  const port = await listen(createServer, Number(process.env.PORT) || 7788);
  // 127.0.0.1, not "localhost": "localhost" may resolve to ::1 where another app can own the same port.
  const url = `http://127.0.0.1:${port}`;
  console.log(`Agent Swarm đang chạy tại ${url}  (Ctrl+C để thoát)`);
  if (!args.includes('--no-open')) openBrowser(url);
  if (!process.env.PORT) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SERVER_FILE, JSON.stringify({ pid: process.pid, port, url, startedAt: Date.now() }));
    } catch {}
    process.on('exit', () => {
      try {
        if (JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(SERVER_FILE);
      } catch {}
    });
  }

  let shuttingDown = false;
  shutdownHook = () => shutdown();
  const shutdown = async () => {
    if (shuttingDown) return process.exit(1);
    shuttingDown = true;
    const active = [...runs.values()].filter((r) => r.status !== 'stopped' && r.status !== 'error');
    if (active.length) console.log('Đang dừng các agent và dọn worktree...');
    for (const r of active) r.stop('now');
    const deadline = Date.now() + 30000;
    while (active.some((r) => r.status !== 'stopped' && r.status !== 'error') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.on('exit', killAll);
  process.on('uncaughtException', (e) => console.error('[uncaught]', e));
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
}

if (require.main === module) main();

module.exports = { handle, main };
