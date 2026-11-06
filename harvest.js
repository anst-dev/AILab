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
//   - Trong 1 lần chạy: bỏ dòng trùng theo commit+iter+status.
//   - So với log đã có: dòng swarm-row cũ không lưu cột iter nên khớp theo commit
//     (commit đã nằm trong 1 dòng swarm-row rồi thì không log lại); riêng dòng git-log
//     bị bỏ luôn nếu commit đã xuất hiện ở bất kỳ dòng nào của log.
// Stdlib thôi, không phụ thuộc npm.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const OUT = path.join(HERE, 'knowledge', 'improvements_log.jsonl');

// ---------- tiện ích ----------
function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  } catch {
    return '';
  }
}

// Tìm .swarm/runs: đi tối đa 5 cấp từ thư mục chứa script (worktree nằm ở <repo>/.swarm/wt/<ten>).
function findRunsDir() {
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

// ---------- ghép + dedupe + ghi ----------
const toLine = (r) => JSON.stringify({
  ts: r.ts, bot: r.bot, kind: r.kind, feature: r.feature,
  commit: r.commit, score: r.score, status: r.status, note: r.note,
});

const existing = fs.existsSync(OUT)
  ? fs.readFileSync(OUT, 'utf8').split('\n').map((l) => l.replace(/\r$/, '').trim()).filter(Boolean)
  : [];
const existingParsed = existing.map((l) => { try { return JSON.parse(l); } catch { return null; } });
const existingAllCommits = new Set(existingParsed.filter(Boolean).map((o) => o.commit).filter(Boolean));
const existingSwarm = existingParsed.filter((o) => o && o.kind === 'swarm-row' && o.commit);
const existingSwarmCommits = new Set(existingSwarm.map((o) => o.commit));
const existingSwarmCommitStatus = new Set(existingSwarm.map((o) => o.commit + '|' + (o.status || '')));

const { rows: trows, runIds, runsDir } = tsvRows();
const tsvCommits = new Set(trows.map((r) => r.commit).filter(Boolean));
const grows = gitRows(new Set([...tsvCommits, ...existingAllCommits]));

const seenKeys = new Set(); // commit|iter|status trong nguồn
const fresh = [];
for (const r of [...trows, ...grows]) {
  const key = (r.commit || '') + '|' + r._iter + '|' + (r.status || '');
  if (seenKeys.has(key)) continue;
  if (r.commit && existingSwarmCommits.has(r.commit)) continue; // lần harvest trước đã log commit này
  if (r.commit && existingSwarmCommitStatus.has(r.commit + '|' + (r.status || ''))) continue;
  seenKeys.add(key);
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

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, items.map((i) => i.line).join('\n') + '\n');
console.log(`harvest: runs dir = ${runsDir}`);
console.log(`harvest: ${runIds.length} run results.tsv (${runIds.join(', ') || 'không có'}), ${trows.length} dòng tsv, ${grows.length} commit swarm/*`);
console.log(`harvest: +${fresh.length} dòng mới, tổng ${items.length} dòng -> knowledge/improvements_log.jsonl`);
