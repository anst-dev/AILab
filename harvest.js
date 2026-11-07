#!/usr/bin/env node
// harvest.js — gom kết quả các phiên swarm vào log tập trung knowledge/improvements_log.jsonl.
//
// Nguồn dữ liệu:
//   1. Mọi .swarm/runs/*/results.tsv (nếu script chạy trong worktree .swarm/wt/<ten>,
//      tự đi lên thư mục gốc repo để tìm .swarm/runs).
//   2. git log --oneline các nhánh swarm/* (bắt cả commit chưa kịp ghi vào results.tsv).
//
// Dòng harvest có kind="swarm-row", đủ 8 trường:
//   {"ts","bot","kind","feature","commit","score","status","note"}
//   - results.tsv : bot=agent, feature=description, note=id run, status/score giữ nguyên tsv.
//   - git log     : bot="git", feature=tiêu đề commit, note=tên nhánh, status="committed".
//
// Dedupe (chạy lại không bao giờ nhân đôi):
//   - Trong 1 lần chạy: bỏ dòng trùng theo commit+status (hoặc runId+iter+ts+bot+status nếu không có commit).
//   - So với log đã có: dòng có commit khớp theo commit/commit+status; dòng không có commit khớp theo runId+ts+bot+status.
//     Khử trùng cả các dòng bị lặp đã có sẵn trong log.
// Stdlib thôi, không phụ thuộc npm.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;

// Tìm .swarm/runs: đi tối đa 5 cấp từ thư mục chứa script (worktree nằm ở <repo>/.swarm/wt/<ten>).
function findRunsDir() {
  if (process.env.HARVEST_RUNS_DIR) return path.resolve(process.env.HARVEST_RUNS_DIR);
  let dir = HERE;
  for (let i = 0; i < 5; i++) {
    const cand = path.join(dir, '.swarm', 'runs');
    if (fs.existsSync(cand)) return cand;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.join(HERE, '.swarm', 'runs');
}

function findRepoRoot() {
  const runsDir = findRunsDir();
  return path.resolve(runsDir, '..', '..');
}

function getOutPath(repoRoot) {
  if (process.env.HARVEST_OUT) return path.resolve(process.env.HARVEST_OUT);
  const root = repoRoot || findRepoRoot();
  return path.join(root, 'knowledge', 'improvements_log.jsonl');
}

const OUT = getOutPath();

// ---------- tiện ích ----------
function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: findRepoRoot(), encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

// ---------- 1) các dòng từ results.tsv ----------
function tsvRows() {
  const runsDir = findRunsDir();
  const rows = [];
  let runIds = [];
  try {
    runIds = fs.readdirSync(runsDir)
      .filter((d) => fs.statSync(path.join(runsDir, d)).isDirectory()
        && fs.existsSync(path.join(runsDir, d, 'results.tsv')))
      .sort();
  } catch {
    return { rows, runIds, runsDir };
  }
  for (const runId of runIds) {
    const lines = fs.readFileSync(path.join(runsDir, runId, 'results.tsv'), 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts[0] === 'time') continue; // dòng header
      if (parts.length < 6) continue;
      const [time, agent, iter, commit, score, status] = parts;
      const feature = parts.slice(6).join('\t').trim() || null;
      const scoreRaw = (score || '').trim();
      rows.push({
        ts: (time || '').trim() || null,
        bot: (agent || '').trim() || null,
        kind: 'swarm-row',
        feature,
        commit: (commit || '').trim() || null,
        score: scoreRaw === '' ? null : (Number.isFinite(Number(scoreRaw)) ? Number(scoreRaw) : scoreRaw),
        status: (status || '').trim() || null,
        note: runId,
        _iter: (iter || '').trim(),
      });
    }
  }
  return { rows, runIds, runsDir };
}

// ---------- 2) các dòng từ git log các nhánh swarm/* ----------
function gitRows(takenCommits) {
  const rows = [];
  const branches = sh('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/swarm/'])
    .split('\n').map((s) => s.trim()).filter(Boolean).sort();
  const seen = new Set();
  for (const br of branches) {
    const out = sh('git', ['log', '--format=%h%x09%s%x09%cI', br]);
    for (const raw of out.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const hash = parts[0].trim();
      const date = parts[parts.length - 1].trim();
      const subject = parts.slice(1, -1).join('\t').trim();
      if (!hash || seen.has(hash) || takenCommits.has(hash)) continue;
      seen.add(hash);
      let ts = null;
      try { ts = new Date(date).toISOString(); } catch { /* giữ null */ }
      rows.push({
        ts, bot: 'git', kind: 'swarm-row', feature: subject || null,
        commit: hash, score: null, status: 'committed', note: br, _iter: '',
      });
    }
  }
  return rows;
}

// ---------- lọc nhiễu ----------
// Vòng no-change (agent không sửa gì, thường do hết quota 429) không mang tri thức gì: đêm 06/11
// chúng chiếm 4.392/4.620 dòng. Bỏ khi gom, và dọn luôn khỏi log cũ (nếu không, dọn tay xong
// lần harvest kế tiếp lại ghi lại từ results.tsv).
const NOISE_STATUS = new Set(['no-change']);
const QUOTA_RE = /RESOURCE_EXHAUSTED|\b429\b|quota (reached|exceeded)|rate.?limit/i;
function isNoise(r) {
  if (!r || r.kind !== 'swarm-row') return false;
  if (NOISE_STATUS.has(r.status)) return true;
  return !r.commit && r.status !== 'keep' && QUOTA_RE.test(String(r.feature || ''));
}

// ---------- ghép + dedupe + ghi ----------
const toLine = (r) => JSON.stringify({
  ts: r.ts, bot: r.bot, kind: r.kind, feature: r.feature,
  commit: r.commit, score: r.score, status: r.status, note: r.note,
});

function runHarvest(customOut, options = {}) {
  let targetOut = null;
  let dryRun = false;
  if (customOut && typeof customOut === 'object') {
    targetOut = customOut.targetOut || customOut.outPath || customOut.customOut || null;
    dryRun = Boolean(customOut.dryRun);
  } else {
    targetOut = customOut || null;
    dryRun = Boolean(options && options.dryRun);
  }
  targetOut = targetOut || getOutPath();
  const rawExisting = fs.existsSync(targetOut)
    ? fs.readFileSync(targetOut, 'utf8').split('\n').map((l) => l.replace(/\r$/, '').trim()).filter(Boolean)
    : [];
  const existingSeenLines = new Set();
  const existing = [];
  let prunedCount = 0;
  for (const l of rawExisting) {
    if (existingSeenLines.has(l)) continue;
    existingSeenLines.add(l);
    let obj = null;
    try { obj = JSON.parse(l); } catch { /* dòng lạ: giữ nguyên */ }
    if (isNoise(obj)) { prunedCount++; continue; }
    existing.push(l);
  }
  const existingParsed = existing.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const existingAllCommits = new Set(existingParsed.map((o) => o.commit).filter(Boolean));
  const existingSwarm = existingParsed.filter((o) => o && o.kind === 'swarm-row');
  const existingSwarmCommits = new Set(existingSwarm.map((o) => o.commit).filter(Boolean));
  const existingSwarmCommitStatus = new Set(existingSwarm.filter((o) => o.commit).map((o) => o.commit + '|' + (o.status || '')));
  const existingNoCommitKeys = new Set(
    existingSwarm.filter((o) => !o.commit).map((o) => (o.note || '') + '|' + (o.ts || '') + '|' + (o.bot || '') + '|' + (o.status || ''))
  );

  const { rows: trows, runIds, runsDir } = tsvRows();
  const tsvCommits = new Set(trows.map((r) => r.commit).filter(Boolean));
  const grows = gitRows(new Set([...tsvCommits, ...existingAllCommits]));

  const seenKeys = new Set(); // commit+status hoặc runId+iter+ts+bot+status
  const fresh = [];
  let skippedNoise = 0;
  for (const r of [...trows, ...grows]) {
    if (isNoise(r)) { skippedNoise++; continue; }
    const key = r.commit
      ? 'c|' + r.commit + '|' + (r.status || '')
      : 'nc|' + (r.note || '') + '|' + r._iter + '|' + (r.ts || '') + '|' + (r.bot || '') + '|' + (r.status || '');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    if (r.commit) {
      if (existingSwarmCommits.has(r.commit)) continue; // lần harvest trước đã log commit này
      if (existingSwarmCommitStatus.has(r.commit + '|' + (r.status || ''))) continue;
    } else {
      const ncKey = (r.note || '') + '|' + (r.ts || '') + '|' + (r.bot || '') + '|' + (r.status || '');
      if (existingNoCommitKeys.has(ncKey)) continue;
    }
    const line = toLine(r);
    if (existingSeenLines.has(line)) continue;
    fresh.push(r);
  }

  // Sắp theo thời gian (ổn định, giữ thứ tự gốc khi bằng thời điểm).
  const items = [];
  for (const l of existing) {
    let tsMs = Infinity;
    try {
      const t = Date.parse(JSON.parse(l).ts);
      if (!Number.isNaN(t)) tsMs = t;
    } catch { /* dòng lạ → đẩy xuống cuối */ }
    items.push({ line: l, tsMs });
  }
  for (const r of fresh) {
    const t = r.ts ? Date.parse(r.ts) : NaN;
    items.push({ line: toLine(r), tsMs: Number.isNaN(t) ? Infinity : t });
  }
  items.sort((a, b) => a.tsMs - b.tsMs);

  if (!dryRun) {
    fs.mkdirSync(path.dirname(targetOut), { recursive: true });
    fs.writeFileSync(targetOut, items.map((i) => i.line).join('\n') + '\n');
  }
  return {
    runsDir,
    runIds,
    tsvRowCount: trows.length,
    gitRowCount: grows.length,
    freshCount: fresh.length,
    skippedNoise,
    prunedCount,
    totalCount: items.length,
    outPath: targetOut,
    dryRun,
  };
}

function computeStats(target, filter) {
  let items = [];
  let logPath = null;
  if (Array.isArray(target)) {
    items = target;
  } else {
    logPath = typeof target === 'string' ? target : getOutPath();
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      for (const l of lines) {
        try { items.push(JSON.parse(l)); } catch {}
      }
    }
  }

  const rawTotal = items.length;
  const isFiltered = !!(filter && (filter.status || filter.bot || filter.query || (typeof filter.limit === 'number' && filter.limit > 0)));
  if (isFiltered) {
    items = filterKnowledge(items, filter);
  }

  const byStatus = {};
  const byBot = {};
  const total = items.length;
  const scores = [];
  for (const item of items) {
    const st = item.status || 'unknown';
    byStatus[st] = (byStatus[st] || 0) + 1;
    const bot = item.bot || 'unknown';
    byBot[bot] = (byBot[bot] || 0) + 1;
    if (typeof item.score === 'number' && Number.isFinite(item.score)) {
      scores.push(item.score);
    }
  }
  const keepCount = (byStatus['keep'] || 0) + (byStatus['keep-merged'] || 0);
  const discardCount = (byStatus['discard'] || 0) + (byStatus['no-change'] || 0) + (byStatus['duplicate'] || 0);
  const conflictCount = byStatus['conflict'] || 0;
  const errorCount = (byStatus['crash'] || 0) + (byStatus['error'] || 0);
  const keepRate = total > 0 ? Number(((keepCount / total) * 100).toFixed(1)) : 0;
  const bestScore = scores.length > 0 ? Math.max(...scores) : null;
  const avgScore = scores.length > 0 ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : null;

  return {
    total,
    rawTotal,
    filtered: isFiltered,
    byStatus,
    byBot,
    keepCount,
    discardCount,
    conflictCount,
    errorCount,
    keepRate,
    bestScore,
    avgScore,
    scoreCount: scores.length,
    logPath,
  };
}

function csvField(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function loadLogItems(target) {
  const items = [];
  const logPath = typeof target === 'string' ? target : getOutPath();
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      try { items.push(JSON.parse(l)); } catch {
        items.push({ feature: l });
      }
    }
  }
  return { items, logPath };
}

function filterKnowledge(items, filter = {}) {
  let list = Array.isArray(items) ? [...items] : [];
  if (filter.status) {
    const s = String(filter.status).trim().toLowerCase();
    list = list.filter((it) => {
      const st = String(it.status || '').toLowerCase();
      if (s === 'keep') return st === 'keep' || st === 'keep-merged';
      if (s === 'discard') return st !== 'keep' && st !== 'keep-merged' && st !== 'committed';
      return st === s;
    });
  }
  if (filter.bot) {
    const b = String(filter.bot).trim().toLowerCase();
    list = list.filter((it) => String(it.bot || '').toLowerCase().includes(b));
  }
  if (filter.query) {
    const q = String(filter.query).trim().toLowerCase();
    list = list.filter((it) => {
      const matchFeat = String(it.feature || '').toLowerCase().includes(q);
      const matchCommit = String(it.commit || '').toLowerCase().includes(q);
      const matchBot = String(it.bot || '').toLowerCase().includes(q);
      const matchNote = String(it.note || '').toLowerCase().includes(q);
      const matchStatus = String(it.status || '').toLowerCase().includes(q);
      return matchFeat || matchCommit || matchBot || matchNote || matchStatus;
    });
  }
  if (filter.sort) {
    const f = String(filter.sort).trim();
    const rev = !!filter.reverse || String(filter.order || '').toLowerCase() === 'desc';
    list.sort((a, b) => {
      let cmp = 0;
      if (f === 'score') {
        const sa = a.score != null && Number.isFinite(Number(a.score)) ? Number(a.score) : null;
        const sb = b.score != null && Number.isFinite(Number(b.score)) ? Number(b.score) : null;
        if (sa === null && sb === null) cmp = 0;
        else if (sa === null) cmp = -1;
        else if (sb === null) cmp = 1;
        else cmp = sa - sb;
      } else if (f === 'ts' || f === 'time') {
        const ta = a.ts ? new Date(a.ts).getTime() : 0;
        const tb = b.ts ? new Date(b.ts).getTime() : 0;
        cmp = (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
      } else {
        cmp = String(a[f] || '').localeCompare(String(b[f] || ''));
      }
      return rev ? -cmp : cmp;
    });
  } else if (filter.reverse || String(filter.order || '').toLowerCase() === 'desc') {
    list.reverse();
  }
  if (typeof filter.limit === 'number' && filter.limit > 0) {
    list = list.slice(0, filter.limit);
  }
  return list;
}

function listKnowledge(targetLog, filter) {
  const { items, logPath } = loadLogItems(targetLog);
  const filtered = filter ? filterKnowledge(items, filter) : items;
  return { items: filtered, totalCount: items.length, matchCount: filtered.length, logPath };
}

function exportKnowledgeCsv(targetLog, outCsvPath, filter) {
  let { items, logPath } = loadLogItems(targetLog);
  if (filter) {
    items = filterKnowledge(items, filter);
  }
  const cols = ['ts', 'bot', 'kind', 'feature', 'commit', 'score', 'status', 'note'];
  const lines = [cols.join(',')];
  for (const obj of items) {
    lines.push(cols.map((col) => csvField(obj[col])).join(','));
  }
  const csvContent = lines.join('\r\n') + '\r\n';
  if (outCsvPath) {
    fs.mkdirSync(path.dirname(path.resolve(outCsvPath)), { recursive: true });
    fs.writeFileSync(outCsvPath, csvContent, 'utf8');
    return { ok: true, count: items.length, outPath: path.resolve(outCsvPath), logPath };
  }
  return { ok: true, count: items.length, csv: csvContent, logPath };
}

function exportKnowledgeJson(targetLog, outJsonPath, filter) {
  let { items, logPath } = loadLogItems(targetLog);
  if (filter) {
    items = filterKnowledge(items, filter);
  }
  const jsonContent = JSON.stringify(items, null, 2) + '\n';
  if (outJsonPath) {
    fs.mkdirSync(path.dirname(path.resolve(outJsonPath)), { recursive: true });
    fs.writeFileSync(outJsonPath, jsonContent, 'utf8');
    return { ok: true, count: items.length, outPath: path.resolve(outJsonPath), logPath };
  }
  return { ok: true, count: items.length, json: jsonContent, logPath };
}

function exportKnowledgeJsonl(targetLog, outJsonlPath, filter) {
  let { items, logPath } = loadLogItems(targetLog);
  if (filter) {
    items = filterKnowledge(items, filter);
  }
  const jsonlContent = items.map((it) => JSON.stringify(it)).join('\n') + (items.length ? '\n' : '');
  if (outJsonlPath) {
    fs.mkdirSync(path.dirname(path.resolve(outJsonlPath)), { recursive: true });
    fs.writeFileSync(outJsonlPath, jsonlContent, 'utf8');
    return { ok: true, count: items.length, outPath: path.resolve(outJsonlPath), logPath };
  }
  return { ok: true, count: items.length, jsonl: jsonlContent, logPath };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Sử dụng:
  node harvest.js              Gom kết quả các phiên swarm vào knowledge/improvements_log.jsonl
  node harvest.js --list       Xem danh sách các dòng tri thức trong terminal
  node harvest.js --stats, -s  Xem thống kê chi tiết các lượt và tỷ lệ keep trong knowledge log (hỗ trợ kèm -q, --status, --bot)
  node harvest.js --query, -q <keyword>  Lọc theo từ khóa (feature, commit, bot, status, note)
  node harvest.js --status <st> Lọc theo trạng thái (keep, discard, conflict, error, committed)
  node harvest.js --bot <name> Lọc theo tên bot/agent
  node harvest.js --sort <field> Sắp xếp danh sách/xuất (score, ts, bot, status, commit)
  node harvest.js --reverse, --desc Đảo ngược thứ tự sắp xếp
  node harvest.js --asc        Sắp xếp theo thứ tự tăng dần
  node harvest.js --limit <n>  Giới hạn số dòng hiển thị hoặc xuất
  node harvest.js --export-csv [f], --csv [f]  Xuất dữ liệu tri thức ra file CSV (mặc định improvements_log.csv)
  node harvest.js --export-json [f]            Xuất dữ liệu tri thức ra file JSON (mặc định improvements_log.json)
  node harvest.js --export-jsonl [f]           Xuất dữ liệu tri thức ra file JSONL (mặc định improvements_log.filtered.jsonl)
  node harvest.js --dry-run, -n Xem trước số dòng sẽ được gom mà không ghi file
  node harvest.js --json       In kết quả gom, danh sách hoặc thống kê dạng JSON ra stdout
  node harvest.js --help, -h   Hiện hướng dẫn này`);
    process.exit(0);
  }

  // Parse common filter options
  const getOpt = (flag, shortFlag) => {
    const idx = args.findIndex((a) => a === flag || (shortFlag && a === shortFlag));
    if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('-')) {
      return args[idx + 1];
    }
    return null;
  };

  const queryOpt = getOpt('--query', '-q');
  const statusOpt = getOpt('--status');
  const botOpt = getOpt('--bot');
  const sortOpt = getOpt('--sort');
  const reverseOpt = args.includes('--reverse') || args.includes('--desc');
  const orderOpt = getOpt('--order') || (args.includes('--asc') ? 'asc' : (reverseOpt ? 'desc' : null));
  const limitRaw = getOpt('--limit');
  const limitOpt = limitRaw ? parseInt(limitRaw, 10) : null;
  const filterOpts = {
    query: queryOpt,
    status: statusOpt,
    bot: botOpt,
    sort: sortOpt,
    reverse: reverseOpt,
    order: orderOpt,
    limit: limitOpt && Number.isFinite(limitOpt) && limitOpt > 0 ? limitOpt : undefined,
  };

  const isJson = args.includes('--json');
  if (args.includes('--stats') || args.includes('-s')) {
    const stats = computeStats(null, filterOpts);
    if (isJson) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(`Knowledge Log: ${stats.logPath || getOutPath()}`);
      if (stats.filtered) {
        const filterParts = [];
        if (queryOpt) filterParts.push(`query="${queryOpt}"`);
        if (statusOpt) filterParts.push(`status=${statusOpt}`);
        if (botOpt) filterParts.push(`bot=${botOpt}`);
        console.log(`(Đã lọc: ${stats.total}/${stats.rawTotal} dòng${filterParts.length ? ` [${filterParts.join(', ')}]` : ''})`);
      }
      console.log(`Tổng số dòng: ${stats.total}`);
      console.log(`Tỷ lệ keep: ${stats.keepRate}% (keep: ${stats.keepCount}, discard: ${stats.discardCount}, conflict: ${stats.conflictCount}, error: ${stats.errorCount})`);
      if (stats.bestScore !== null) {
        console.log(`Điểm số: cao nhất = ${stats.bestScore}, trung bình = ${stats.avgScore} (${stats.scoreCount} lượt có điểm)`);
      }
      console.log('Theo trạng thái:');
      for (const [st, c] of Object.entries(stats.byStatus)) {
        console.log(`  - ${st}: ${c}`);
      }
      console.log('Theo bot:');
      for (const [b, c] of Object.entries(stats.byBot)) {
        console.log(`  - ${b}: ${c}`);
      }
    }
    process.exit(0);
  }

  if (args.includes('--list')) {
    const res = listKnowledge(null, filterOpts);
    if (isJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`Kho tri thức (${res.matchCount}/${res.totalCount} dòng${queryOpt ? ` khớp "${queryOpt}"` : ''}${statusOpt ? ` status=${statusOpt}` : ''}):`);
      for (const it of res.items) {
        const time = it.ts ? new Date(it.ts).toLocaleTimeString('vi-VN') : '—';
        const st = (it.status || '—').padEnd(9);
        const bot = (it.bot || '—').padEnd(8);
        const hash = (it.commit ? it.commit.slice(0, 7) : '—').padEnd(8);
        const score = it.score != null ? String(it.score).padStart(5) : '    —';
        const desc = it.feature || '(không có mô tả)';
        console.log(`  ${time} [${st}] ${bot} ${hash} ${score}  ${desc}`);
      }
    }
    process.exit(0);
  }

  const exportCsvIdx = args.findIndex((a) => a === '--export-csv' || a === '--csv');
  if (exportCsvIdx !== -1) {
    const val = args[exportCsvIdx + 1];
    const outPath = (val && !val.startsWith('-')) ? val : path.join(path.dirname(getOutPath()), 'improvements_log.csv');
    const res = exportKnowledgeCsv(null, outPath, filterOpts);
    if (isJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`Đã xuất ${res.count} dòng tri thức sang file CSV: ${res.outPath}`);
    }
    process.exit(0);
  }

  const exportJsonIdx = args.findIndex((a) => a === '--export-json');
  if (exportJsonIdx !== -1) {
    const val = args[exportJsonIdx + 1];
    const outPath = (val && !val.startsWith('-')) ? val : path.join(path.dirname(getOutPath()), 'improvements_log.json');
    const res = exportKnowledgeJson(null, outPath, filterOpts);
    if (isJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`Đã xuất ${res.count} dòng tri thức sang file JSON: ${res.outPath}`);
    }
    process.exit(0);
  }

  const exportJsonlIdx = args.findIndex((a) => a === '--export-jsonl');
  if (exportJsonlIdx !== -1) {
    const val = args[exportJsonlIdx + 1];
    const outPath = (val && !val.startsWith('-')) ? val : path.join(path.dirname(getOutPath()), 'improvements_log.filtered.jsonl');
    const res = exportKnowledgeJsonl(null, outPath, filterOpts);
    if (isJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`Đã xuất ${res.count} dòng tri thức sang file JSONL: ${res.outPath}`);
    }
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const res = runHarvest({ dryRun });
  if (isJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`harvest: runs dir = ${res.runsDir}`);
    console.log(`harvest: ${res.runIds.length} run results.tsv (${res.runIds.join(', ') || 'không có'}), ${res.tsvRowCount} dòng tsv, ${res.gitRowCount} commit swarm/*`);
    console.log(`harvest: ${dryRun ? '[dry-run] ' : ''}+${res.freshCount} dòng mới, bỏ ${res.skippedNoise} dòng nhiễu, dọn ${res.prunedCount} dòng nhiễu cũ, tổng ${res.totalCount} dòng -> ${res.outPath}`);
  }
}

module.exports = { runHarvest, isNoise, computeStats, filterKnowledge, listKnowledge, exportKnowledgeCsv, exportKnowledgeJson, exportKnowledgeJsonl, tsvRows, gitRows, findRunsDir, findRepoRoot, getOutPath, OUT };
