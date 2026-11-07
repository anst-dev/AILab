'use strict';
// Regression tests cho các lỗi tìm thấy sau đêm 06→07/11. Run: node test/regression.test.js
//  1. Circuit breaker: agent toàn no-change (hết quota) → phiên tự dừng sau noChangeLimit vòng.
//  2. logImprovement: mặc định KHÔNG tạo knowledge/ trong dự án; bật bằng opts.knowledgeLog.
//  3. harvest: bỏ dòng no-change / lỗi quota, dọn chúng khỏi log cũ, chạy lại không tăng dòng.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SwarmRun, normalizeOptions } = require('../src/swarm');
const { getCatalog } = require('../src/agents');

const FAKE = path.join(__dirname, 'fake-agent.js');
const EVAL = path.join(__dirname, 'fake-eval.js');

async function runSwarm(raw) {
  const catalog = await getCatalog({ custom: [{ id: 'fake', name: 'Fake agent', template: `node "${FAKE}"` }] });
  const { opts, errors } = normalizeOptions(raw, catalog);
  assert.deepEqual(errors, []);
  const run = new SwarmRun(opts);
  await run.start();
  return run;
}

function project(tmp, name) {
  const ws = path.join(tmp, name);
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'value.txt'), '100');
  return ws;
}

const scoreOpts = (ws, extra) => ({
  workspace: ws,
  requirement: 'Giảm giá trị trong value.txt',
  agents: [{ cli: 'fake', count: 2 }],
  timeLimitMin: 0.08,
  evalMode: 'score',
  evalCommand: `node "${EVAL}"`,
  metricRegex: '^score:\\s*([-0-9.]+)',
  direction: 'min',
  evalTimeoutMin: 0.5,
  staggerSec: 0.2,
  ...extra,
});

async function circuitBreaker(tmp) {
  console.log('1. circuit breaker dừng phiên khi agent toàn no-change');
  process.env.FAKE_BEHAVIOURS = 'nothing';
  const t0 = Date.now();
  const run = await runSwarm(scoreOpts(project(tmp, 'breaker'), { noChangeLimit: 4, maxDurationMin: 2 }));
  const secs = (Date.now() - t0) / 1000;
  const noChange = run.results.filter((r) => r.status === 'no-change').length;
  console.log(`  dừng sau ${secs.toFixed(1)}s, ${noChange} vòng no-change`);
  assert.equal(run.status, 'stopped');
  assert.ok(noChange >= 4, 'chạm ngưỡng');
  assert.ok(noChange <= 4 + 2, 'không chạy quá ngưỡng (mỗi agent tối đa 1 vòng đang dở)');
  assert.ok(secs < 90, 'dừng sớm, không chờ hết maxDurationMin');
}

async function knowledgeLog(tmp) {
  console.log('2. logImprovement chỉ ghi khi bật knowledgeLog');
  process.env.FAKE_BEHAVIOURS = 'improve';
  const off = await runSwarm(scoreOpts(project(tmp, 'kl-off'), { maxIterations: 2 }));
  assert.ok(off.results.some((r) => r.status === 'keep'), 'có keep');
  assert.ok(!fs.existsSync(path.join(off.repoRoot, 'knowledge')), 'mặc định không tạo knowledge/ trong dự án');

  const logFile = path.join(tmp, 'kl.jsonl');
  const on = await runSwarm(scoreOpts(project(tmp, 'kl-on'), { maxIterations: 2, knowledgeLog: logFile }));
  const keeps = on.results.filter((r) => r.status === 'keep').length;
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, keeps, 'mỗi keep 1 dòng');
  assert.ok(lines.every((l) => l.status === 'keep' && l.commit));
}

function harvest(tmp) {
  console.log('3. harvest lọc nhiễu và idempotent');
  const runs = path.join(tmp, 'h', '.swarm', 'runs');
  fs.mkdirSync(path.join(runs, 'r1'), { recursive: true });
  const tsv = [
    'time\tagent\titer\tcommit\tscore\tstatus\tdescription',
    '2026-11-06T17:00:00Z\tagent-1\t1\tabc1234\t9\tkeep\tthêm tính năng A',
    '2026-11-06T17:01:00Z\tagent-2\t1\t\t\tno-change\tthoát mã 3, không có thay đổi',
    '2026-11-06T17:02:00Z\tagent-3\t1\t\t\tcrash\tAGY_ERROR: RESOURCE_EXHAUSTED (code 429): Individual quota reached',
    '2026-11-06T17:03:00Z\tagent-2\t2\tdef5678\t\tconflict\tsửa chung file',
  ].join('\n');
  fs.writeFileSync(path.join(runs, 'r1', 'results.tsv'), tsv);
  const out = path.join(tmp, 'h', 'log.jsonl');
  // log cũ đã lẫn rác từ trước
  fs.writeFileSync(out, JSON.stringify({ ts: '2026-11-06T16:00:00Z', bot: 'agent-1', kind: 'swarm-row', feature: 'x', commit: null, score: null, status: 'no-change', note: 'r0' }) + '\n'
    + JSON.stringify({ ts: '2026-11-06T16:00:00Z', bot: 'zc1', kind: 'feature', feature: 'tay', commit: '1111111', score: null, status: 'merged', note: '' }) + '\n');

  process.env.HARVEST_RUNS_DIR = runs;
  delete require.cache[require.resolve('../harvest')];
  const { runHarvest } = require('../harvest');
  const r1 = runHarvest(out);
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  console.log(`  +${r1.freshCount}, bỏ ${r1.skippedNoise}, dọn ${r1.prunedCount} → ${rows.length} dòng`);
  assert.equal(r1.skippedNoise, 2);
  assert.equal(r1.prunedCount, 1);
  assert.deepEqual(rows.map((r) => r.status).sort(), ['conflict', 'keep', 'merged']);
  const r2 = runHarvest(out);
  assert.equal(r2.freshCount, 0, 'chạy lại không thêm dòng');
  assert.equal(fs.readFileSync(out, 'utf8').trim().split('\n').length, 3);
  delete process.env.HARVEST_RUNS_DIR;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-regress-'));
  harvest(tmp);
  await circuitBreaker(tmp);
  await knowledgeLog(tmp);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log('\nALL REGRESSION TESTS PASSED');
})().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
