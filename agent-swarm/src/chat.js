'use strict';
// Talk to the coordinator of a running Agent Swarm server from the terminal.
//   node src/chat.js "tối ưu dự án X bằng 3 agent agy"   -> send, wait for the reply, exit
//   node src/chat.js                                      -> interactive chat (Ctrl+C to quit)
// Starts the background server first if none is running.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const DATA_DIR = process.env.SWARM_DATA_DIR ? path.resolve(process.env.SWARM_DATA_DIR) : path.join(__dirname, '..', 'data');

async function serverUrl() {
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'server.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const alive = async (info) =>
    !!info &&
    (await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json())
      .then((j) => j.pid === info.pid, () => false));
  let info = read();
  if (await alive(info)) return info.url;
  console.log('Chưa có server chạy nền, đang khởi động...');
  spawnSync(process.execPath, [path.join(__dirname, 'server.js'), '--background'], { stdio: 'inherit', env: process.env });
  info = read();
  if (await alive(info)) return info.url;
  throw new Error('Không khởi động được server.');
}

const ROLE = { user: 'Bạn', agent: 'Điều phối', system: 'Hệ thống' };

function print(m) {
  const t = new Date(m.t).toLocaleTimeString('vi-VN', { hour12: false });
  console.log(`\n[${t}] ${ROLE[m.role] || m.role}: ${m.text}`);
  for (const a of m.actions || []) if (!a.info || !a.ok) console.log(`   ${a.ok ? '✓' : '✗'} ${a.text}`);
}

/** Streams chat events; calls onMsg(m) and onBusy(b). */
function listen(url, onMsg, onBusy) {
  const req = http.get(`${url}/api/events`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = (block.match(/^event: (.+)$/m) || [])[1];
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (ev === 'chat') onMsg(JSON.parse(data));
        else if (ev === 'chatbusy') onBusy(JSON.parse(data).busy);
      }
    });
  });
  req.on('error', (e) => console.error('Mất kết nối server:', e.message));
  return () => req.destroy();
}

async function post(url, message) {
  const r = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}

(async () => {
  const url = await serverUrl();
  const oneShot = process.argv.slice(2).join(' ').trim();

  if (oneShot) {
    let sentId = Infinity;
    let sawBusy = false;
    let stop;
    const done = new Promise((resolve) => {
      stop = listen(
        url,
        (m) => m.id > sentId && m.role !== 'user' && print(m),
        (busy) => {
          if (busy) sawBusy = true;
          else if (sawBusy) resolve();
        }
      );
    });
    sentId = (await post(url, oneShot)).id;
    await done;
    stop();
    console.log(`\nWeb: ${url}`);
    return;
  }

  const hist = await (await fetch(`${url}/api/chat`)).json();
  hist.messages.slice(-10).forEach(print);
  console.log(`\nĐã kết nối ${url}. Gõ tin nhắn rồi Enter (Ctrl+C để thoát; server vẫn chạy nền).`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  listen(
    url,
    (m) => {
      if (m.role === 'user') return;
      print(m);
      rl.prompt(true);
    },
    (busy) => busy && console.log('  (agent điều phối đang suy nghĩ...)')
  );
  rl.prompt();
  rl.on('line', async (line) => {
    if (line.trim()) await post(url, line.trim()).catch((e) => console.error(e.message));
    rl.prompt();
  });
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
