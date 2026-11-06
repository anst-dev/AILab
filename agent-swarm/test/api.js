'use strict';
// Starts the real server and drives it through its HTTP API. Run: node test/api.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'fake-agent.js');
const EVAL = path.join(__dirname, 'fake-eval.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let base;
async function call(p, body, method) {
  const res = await fetch(base + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

/** Collects SSE "run" events. */
function listenEvents(onSnap) {
  const req = http.get(base + '/api/events', (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (block.includes('event: run') && data) onSnap(JSON.parse(data));
      }
    });
  });
  return () => req.destroy();
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-swarm-api-'));
  const port = 17000 + Math.floor(Math.random() * 2000);
  const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--no-open'], {
    env: { ...process.env, PORT: String(port), SWARM_DATA_DIR: path.join(tmp, 'data'), FAKE_BEHAVIOURS: 'improve,worse,nothing' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 50 && !/127\.0\.0\.1:(\d+)/.test(out); i++) await sleep(100);
    base = `http://127.0.0.1:${out.match(/127\.0\.0\.1:(\d+)/)[1]}`;
    console.log(`server at ${base}`);

    // static files
    let r = await call('/');
    assert.equal(r.status, 200);
    assert.ok(r.data.includes('<title>Agent Swarm</title>'));
    for (const f of ['/app.js', '/style.css']) assert.equal((await call(f)).status, 200, f);
    assert.equal((await call('/../package.json')).status, 404);
    assert.equal((await call('/nope.js')).status, 404);

    // catalog + custom agent config
    r = await call('/api/catalog');
    assert.ok(Array.isArray(r.data.agents) && r.data.agents.length >= 8);
    console.log(`  CLIs found on this machine: ${r.data.agents.filter((a) => a.found).map((a) => a.id).join(', ') || '(none)'}`);
    assert.ok(r.data.suggested.autoresearch, 'autoresearch folder is suggested');
    r = await call('/api/config/agents', { agents: {}, custom: [{ name: 'Fake', template: `node "${FAKE}"` }] });
    const fake = r.data.agents.find((a) => a.id === 'fake');
    assert.ok(fake && fake.found, 'custom agent detected');

    // inspect
    r = await call(`/api/inspect?path=${encodeURIComponent(path.join(tmp, 'new'))}`);
    assert.equal(r.data.exists, false);
    r = await call(`/api/inspect?path=relative`);
    assert.ok(r.data.error);

    // validation
    r = await call('/api/runs', { workspace: '', requirement: '', agents: [] });
    assert.equal(r.status, 400);
    assert.ok(r.data.error.includes('thư mục') && r.data.error.includes('agent'));
    r = await call('/api/runs', { workspace: path.join(tmp, 'x'), requirement: 'x', agents: [{ cli: 'fake', count: 1 }], evalMode: 'score', evalCommand: 'x', metricRegex: '(' });
    assert.equal(r.status, 400);
    assert.ok(r.data.error.includes('Regex'));
    assert.equal((await call('/api/runs', '{bad', 'POST').catch(() => ({ status: 400 }))).status, 400);

    // full run through the API
    const ws = path.join(tmp, 'proj');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'value.txt'), '50');
    const snaps = [];
    const stopListening = listenEvents((s) => snaps.push(s));
    r = await call('/api/runs', {
      workspace: ws,
      requirement: 'giảm value',
      agents: [{ cli: 'fake', count: 2 }],
      timeLimitMin: 0.08,
      evalMode: 'score',
      evalCommand: `node "${EVAL}"`,
      metricRegex: '^score:\\s*([-0-9.]+)',
      direction: 'min',
      maxIterations: 3,
      staggerSec: 0,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const id = r.data.id;

    // a second run on the same repo must be refused while the first is active
    await sleep(1500);
    r = await call('/api/runs', { workspace: ws, requirement: 'x', agents: [{ cli: 'fake', count: 1 }] });
    assert.equal(r.status, 409);

    let snap;
    for (let i = 0; i < 240; i++) {
      snap = (await call(`/api/runs/${id}`)).data;
      if (snap.status === 'stopped' || snap.status === 'error') break;
      await sleep(500);
    }
    stopListening();
    assert.equal(snap.status, 'stopped', snap.error);
    assert.ok(snaps.length > 3, 'SSE pushed updates');
    assert.ok(snaps.some((s) => s.agents.some((a) => a.status === 'working')), 'SSE showed working agents');
    console.log(`  run ${id}: ${snap.results.map((x) => x.status).join(', ')}`);

    // list, git log, logs
    r = await call('/api/runs');
    assert.ok(r.data.some((x) => x.id === id && x.live));
    r = await call(`/api/runs/${id}/gitlog`);
    assert.equal(r.data.length, snap.results.filter((x) => x.status === 'keep').length);
    const withLog = snap.results.find((x) => x.log);
    r = await call(`/api/runs/${id}/log?file=${encodeURIComponent(withLog.log)}`);
    assert.equal(r.status, 200);
    assert.ok(r.data.includes('[swarm]'));
    r = await call(`/api/runs/${id}/log?file=${encodeURIComponent('../../../.git/config')}`);
    assert.equal(r.status, 400, 'path traversal refused');
    assert.equal((await call('/api/runs/nope')).status, 404);

    // merge back
    r = await call(`/api/runs/${id}/merge`, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const head = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: ws, encoding: 'utf8' }).trim();
    assert.equal(head, snap.originalBranch);
    r = await call(`/api/runs/${id}/merge`, {});
    assert.equal(r.status, 200, 'merging twice is harmless');

    // stop endpoint on a long run, then graceful shutdown of the server
    process.env.FAKE_BEHAVIOURS = 'hang';
    r = await call('/api/runs', { workspace: ws, requirement: 'treo', agents: [{ cli: 'fake', count: 2 }], timeLimitMin: 5, staggerSec: 0 });
    assert.equal(r.status, 200);
    const id2 = r.data.id;
    await sleep(4000);
    assert.equal((await call(`/api/runs/${id2}/stop`, { mode: 'now' })).status, 200);
    for (let i = 0; i < 60; i++) {
      snap = (await call(`/api/runs/${id2}`)).data;
      if (snap.status === 'stopped') break;
      await sleep(500);
    }
    assert.equal(snap.status, 'stopped');
    assert.ok(!fs.existsSync(path.join(ws, '.swarm', 'wt', id2)), 'worktrees cleaned');

    console.log('\nALL API TESTS PASSED');
  } catch (e) {
    console.error('\nTEST FAILED:', e);
    console.error('--- server output ---\n' + out);
    process.exitCode = 1;
  } finally {
    server.kill();
    await sleep(500);
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  }
})();
