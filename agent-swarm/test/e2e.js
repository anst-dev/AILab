'use strict';
// End-to-end tests of the orchestrator with fake agents. Run: node test/e2e.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SwarmRun, normalizeOptions } = require('../src/swarm');
const { getCatalog } = require('../src/agents');
const { IS_WIN } = require('../src/proc');

const FAKE = path.join(__dirname, 'fake-agent.js');
const EVAL = path.join(__dirname, 'fake-eval.js');
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function runSwarm(raw, { stopNowAfterMs } = {}) {
  const catalog = await getCatalog({ custom: [{ id: 'fake', name: 'Fake agent', template: `node "${FAKE}"` }] });
  const { opts, errors } = normalizeOptions(raw, catalog);
  assert.deepEqual(errors, []);
  const run = new SwarmRun(opts);
  if (stopNowAfterMs) setTimeout(() => run.stop('now'), stopNowAfterMs);
  const t0 = Date.now();
  await run.start();
  const snap = run.snapshot();
  console.log(`  ${snap.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s, results: ${JSON.stringify(countBy(snap.results))}`);
  return run;
}

function countBy(rows) {
  const c = {};
  for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
  return c;
}

function assertClean(run) {
  const root = run.repoRoot;
  assert.equal(run.status, 'stopped', `status ${run.status} ${run.error}`);
  assert.ok(!fs.existsSync(run.wtRoot), 'worktrees removed');
  const wts = g(root, 'worktree', 'list').split('\n').filter(Boolean);
  assert.equal(wts.length, 1, `only the main worktree remains: ${wts}`);
  const branches = g(root, 'branch', '--list', `${run.central}-*`);
  assert.equal(branches, '', 'agent branches deleted');
  assert.equal(g(root, 'symbolic-ref', '--short', 'HEAD'), run.central, 'main dir is on the central branch');
  assert.equal(g(root, 'status', '--porcelain'), '', 'main dir clean');
  const kept = run.results.filter((r) => r.status === 'keep').length;
  const commits = Number(g(root, 'rev-list', '--count', `${run.baseCommit}..${run.central}`));
  assert.equal(commits, kept, 'one central commit per kept result');
}

function leftoverHangers() {
  if (!IS_WIN) return 0;
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*setInterval(()=>{},1000)*' }).Count"],
    { encoding: 'utf8' }
  ).trim();
  return Number(out || 0);
}

async function scenarioScore(tmp) {
  console.log('A. score mode, fresh folder (git init), 4 agents, random behaviours');
  const ws = path.join(tmp, 'score-proj');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'value.txt'), '100');
  fs.writeFileSync(path.join(ws, 'protected.txt'), 'original');
  process.env.FAKE_BEHAVIOURS = 'improve,improve,improve,worse,hang,nothing,break,commit,protected,ownfile';
  const run = await runSwarm({
    workspace: ws,
    requirement: 'Giảm giá trị trong value.txt',
    agents: [{ cli: 'fake', count: 4 }],
    timeLimitMin: 0.08,
    evalMode: 'score',
    evalCommand: `node "${EVAL}"`,
    metricRegex: '^score:\\s*([-0-9.]+)',
    direction: 'min',
    evalTimeoutMin: 0.5,
    evalConcurrency: 2,
    protectedFiles: 'protected.txt',
    maxDurationMin: 0.9,
    staggerSec: 0.5,
  });
  assertClean(run);
  const root = run.repoRoot;
  const kept = run.results.filter((r) => r.status === 'keep');
  assert.ok(kept.length >= 1, 'at least one improvement kept');
  for (let i = 1; i < kept.length; i++) assert.ok(kept[i].score < kept[i - 1].score, 'kept scores strictly improve');
  const finalValue = parseFloat(fs.readFileSync(path.join(root, 'value.txt'), 'utf8'));
  assert.equal(finalValue, run.best.score, 'central value equals best score');
  assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), 'original', 'protected file untouched');
  assert.equal(run.results[0].status, 'baseline');
  assert.equal(run.results[0].score, 100);
  assert.ok(fs.existsSync(path.join(run.runDir, 'results.tsv')));
  assert.ok(fs.existsSync(path.join(run.runDir, 'state.json')));
  const statuses = new Set(run.results.map((r) => r.status));
  console.log(`  best=${run.best.score}, statuses: ${[...statuses].join(', ')}`);
  return run;
}

async function scenarioNone(tmp) {
  console.log('B. no-eval mode, dirty existing repo, workspace in a subfolder, conflicting edits');
  const root = path.join(tmp, 'none-repo');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  g(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'proj', 'shared.txt'), 'start\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  g(root, 'add', '-A');
  g(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const original = g(root, 'symbolic-ref', '--short', 'HEAD');
  fs.writeFileSync(path.join(root, 'README.md'), 'hello dirty\n'); // uncommitted change
  process.env.FAKE_BEHAVIOURS = 'conflict,ownfile';
  const run = await runSwarm({
    workspace: path.join(root, 'proj'),
    requirement: 'Viết ghi chú',
    agents: [{ cli: 'fake', count: 3 }],
    timeLimitMin: 0.08,
    evalMode: 'none',
    maxIterations: 3,
    staggerSec: 0,
  });
  assertClean(run);
  assert.equal(run.originalBranch, original);
  assert.equal(g(root, 'rev-parse', `${original}`), g(root, 'rev-parse', `${run.baseCommit}~1`), 'original branch untouched, snapshot on swarm branch');
  assert.ok(run.results.some((r) => r.status === 'keep'));
  // merge back into the original branch
  await run.mergeBack();
  assert.equal(g(root, 'symbolic-ref', '--short', 'HEAD'), original);
  assert.equal(g(root, 'rev-parse', 'HEAD'), g(root, 'rev-parse', run.central));
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r/g, ''), 'hello dirty\n');
  return run;
}

async function scenarioStopNow(tmp) {
  console.log('C. pass mode, everybody hangs, stop immediately');
  const ws = path.join(tmp, 'stop-proj');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'value.txt'), '5');
  process.env.FAKE_BEHAVIOURS = 'hang';
  const t0 = Date.now();
  const run = await runSwarm(
    {
      workspace: ws,
      requirement: 'test',
      agents: [{ cli: 'fake', count: 3 }],
      timeLimitMin: 5,
      evalMode: 'pass',
      evalCommand: `node "${EVAL}"`,
      baseline: false,
      staggerSec: 0,
    },
    { stopNowAfterMs: 6000 }
  );
  assertClean(run);
  assert.ok(Date.now() - t0 < 40000, 'stop now is fast');
  assert.ok(run.results.every((r) => r.status === 'stopped'));
  return run;
}

async function scenarioBusyRepo(tmp, firstRun) {
  console.log('D. second run on a repo that already has a finished run');
  process.env.FAKE_BEHAVIOURS = 'improve';
  const run = await runSwarm({
    workspace: firstRun.opts.workspace,
    requirement: 'tiếp tục',
    agents: [{ cli: 'fake', count: 2 }],
    timeLimitMin: 0.08,
    evalMode: 'score',
    evalCommand: `node "${EVAL}"`,
    metricRegex: 'score:\\s*([-0-9.]+)',
    maxIterations: 2,
    staggerSec: 0,
  });
  assertClean(run);
  assert.equal(run.results[0].score, firstRun.best.score, 'baseline of second run = best of first run');
  assert.ok(run.best.score < firstRun.best.score);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-swarm-e2e-'));
  console.log(`tmp: ${tmp}`);
  try {
    const a = await scenarioScore(tmp);
    await scenarioNone(tmp);
    await scenarioStopNow(tmp);
    await scenarioBusyRepo(tmp, a);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(leftoverHangers(), 0, 'no orphaned agent processes');
    console.log('\nALL E2E TESTS PASSED');
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    console.error('\nTEST FAILED:', e);
    process.exitCode = 1;
  }
})();
