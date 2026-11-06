// evaluate.js — cổng đánh giá cho swarm (evalMode 'pass'): app phải VẪN CHẠY sau khi bot sửa.
// Exit 0 = giữ (app khỏe) · Exit 1 = vứt (hỏng). In lý do ra stdout cho log swarm.
'use strict';
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const PUB = path.join(ROOT, 'public');
const PORT = 7963 + (process.pid % 50);

function sh(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, cwd: ROOT, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err && err.code ? err.code : (err ? 1 : 0), stdout, stderr: stderr || (err ? String(err.message || err) : '') }));
  });
}

function fail(msg) {
  console.log('EVAL-FAIL: ' + msg);
  process.exit(1);
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

(async () => {
  // 1) Syntax check mọi file JS
  const files = [];
  for (const dir of [SRC, PUB]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
  }
  for (const f of files) {
    const r = await sh(process.execPath, ['--check', f], 20000);
    if (r.code !== 0) fail(`syntax ${path.relative(ROOT, f)}: ${r.stderr.slice(0, 200)}`);
  }
  console.log(`CHECK syntax: ${files.length} file OK`);

  // 2) Smoke test: server khởi động + API sống
  const child = spawn(process.execPath, [path.join(SRC, 'server.js'), '--no-open'], {
    env: { ...process.env, PORT: String(PORT) },
    windowsHide: true,
    stdio: 'ignore',
  });
  let ok = false;
  try {
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const code = await httpGet(`http://127.0.0.1:${PORT}/api/catalog`, 1500);
      if (code === 200) { ok = true; break; }
    }
    if (!ok) fail(`server không lên trên cổng ${PORT}`);
    const runs = await httpGet(`http://127.0.0.1:${PORT}/api/runs`, 2000);
    if (runs !== 200) fail(`/api/runs trả ${runs}`);
    console.log('CHECK smoke: server 200 catalog + runs OK');
  } finally {
    try { child.kill(); } catch { /* đã chết */ }
  }

  // 3) Ghi nhận các tính năng roadmap đã có (để bot thấy tiến độ — không chặn)
  const swarmSrc = fs.readFileSync(path.join(SRC, 'swarm.js'), 'utf8');
  const features = [];
  if (/publishCommand/.test(swarmSrc)) features.push('publishCommand');
  if (/RENDER_CACHE_DIR|cacheDir/.test(swarmSrc + fs.readFileSync(path.join(SRC, 'proc.js'), 'utf8'))) features.push('sharedCache');
  if (/rebaseline|re-baseline/i.test(swarmSrc)) features.push('rebaseline');
  if (/export\.csv|exportCsv/.test(swarmSrc)) features.push('exportCsv');
  console.log('FEATURES: ' + (features.join(',') || 'chưa có'));
  console.log('EVAL: PASS');
  process.exit(0);
})().catch((e) => fail(e.message));
