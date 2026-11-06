'use strict';
// Background server + chat coordinator, driven through the CLI and HTTP API. Run: node test/coordinator.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseReply } = require('../src/coordinator');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // parser
  assert.deepEqual(parseReply('blah {"x":1}\n{"reply":"a","actions":[]} tail'), { reply: 'a', actions: [] });
  assert.equal(parseReply('```json\n{"reply":"b"}\n```').reply, 'b');
  assert.equal(parseReply('no json here'), null);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-swarm-coord-'));
  const env = {
    ...process.env,
    PORT: String(19000 + Math.floor(Math.random() * 500)),
    SWARM_DATA_DIR: path.join(tmp, 'data'),
    FAKE_BEHAVIOURS: 'improve,worse',
    FAKE_EVAL: path.join(__dirname, 'fake-eval.js'),
  };
  const node = (args) => spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 120000 });
  let base;
  try {
    // background start, idempotent
    let r = node([SERVER, '--background']);
    const m = r.stdout.match(/(http:\/\/127\.0\.0\.1:\d+)/);
    assert.ok(m, r.stdout + r.stderr);
    base = m[1];
    console.log(`background server at ${base}`);
    assert.ok(node([SERVER, '--background']).stdout.includes('Đã có server'));
    assert.ok(node([SERVER, '--status']).stdout.includes(base));

    const call = async (p, body) => {
      const res = await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
      return res.json();
    };
    await call('/api/config/agents', { agents: {}, custom: [{ name: 'Fake', template: `node "${path.join(__dirname, 'fake-agent.js')}"` }] });
    await call('/api/config/coordinator', { template: `node "${path.join(__dirname, 'fake-coordinator.js')}" {prompt}` });

    // one-shot chat from the terminal: plain reply + unsupported action reported
    r = node([path.join(ROOT, 'src', 'chat.js'), 'xin chào']);
    assert.ok(r.stdout.includes('Chào bạn: xin chào'), r.stdout + r.stderr);
    assert.ok(r.stdout.includes('Hành động không hỗ trợ'), r.stdout);

    // inspect -> start -> run ends -> coordinator summarises
    const ws = path.join(tmp, 'proj');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'value.txt'), '50');
    await call('/api/chat', { message: `tối ưu ${ws}` });
    let chat;
    for (let i = 0; i < 240; i++) {
      chat = await call('/api/chat');
      if (chat.messages.some((x) => x.text === 'Phiên đã xong, kết quả tốt.')) break;
      await sleep(500);
    }
    const texts = chat.messages.map((x) => `${x.role}: ${x.text} ${(x.actions || []).map((a) => a.text).join(' | ')}`);
    console.log(texts.map((t) => '  ' + t.slice(0, 110)).join('\n'));
    assert.ok(texts.some((t) => t.includes('Để tôi xem thư mục') && t.includes('inspect')));
    assert.ok(texts.some((t) => t.includes('Đã bắt đầu phiên')));
    assert.ok(texts.some((t) => t.startsWith('system: Phiên') && t.includes('kết thúc')));
    assert.ok(texts.some((t) => t.includes('Phiên đã xong, kết quả tốt.')));
    const runs = await call('/api/runs');
    assert.equal(runs[0].status, 'stopped');
    assert.ok(runs[0].kept >= 1, JSON.stringify(runs[0]));
    assert.ok(fs.existsSync(path.join(env.SWARM_DATA_DIR, 'chat.json')), 'chat persisted');
  } finally {
    const r = node([SERVER, '--stop']);
    console.log('  ' + r.stdout.trim());
    for (let i = 0; i < 50 && fs.existsSync(path.join(env.SWARM_DATA_DIR, 'server.json')); i++) await sleep(200);
    assert.ok(!fs.existsSync(path.join(env.SWARM_DATA_DIR, 'server.json')), 'background server stopped');
  }
  console.log('\nALL COORDINATOR TESTS PASSED');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
