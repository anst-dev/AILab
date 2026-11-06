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
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Sử dụng:
  node src/chat.js "lệnh/tin nhắn"    Gửi tin nhắn một lần tới điều phối viên và in phản hồi
  node src/chat.js                   Mở chế độ chat tương tác (Ctrl+C để thoát)
  node src/chat.js --status, -s      Xem trạng thái server và các phiên swarm đang chạy
  node src/chat.js --runs, -l        Liệt kê tất cả các phiên swarm (cả đang chạy và lịch sử)
  node src/chat.js --run <id>        Xem thông tin chi tiết của một phiên swarm
  node src/chat.js --stop <id>       Dừng một phiên swarm đang chạy (--graceful để chờ vòng hiện tại)
  node src/chat.js --merge <id>      Merge nhánh của phiên đã dừng vào nhánh gốc của dự án (-m <id>)
  node src/chat.js --export <id> [f] Xuất kết quả phiên swarm ra file CSV (hoặc in ra terminal) (-e <id>)
  node src/chat.js --rebaseline <id> Chấm lại baseline cho một phiên đang chạy (-r <id>)
  node src/chat.js --harvest         Gom kết quả các phiên swarm vào knowledge/improvements_log.jsonl
  node src/chat.js --clear           Xóa lịch sử trò chuyện của điều phối viên
  node src/chat.js --help, -h        Hiện hướng dẫn này`);
    return;
  }

  const url = await serverUrl();

  if (args.includes('--status') || args.includes('-s')) {
    const health = await fetch(`${url}/api/health`).then((r) => r.json()).catch(() => null);
    const runsList = await fetch(`${url}/api/runs`).then((r) => r.json()).catch(() => []);
    console.log(`Server: ${url} (PID: ${health ? health.pid : '?'})`);
    const live = runsList.filter((r) => r.live);
    if (!live.length) {
      console.log('Không có phiên swarm nào đang chạy.');
    } else {
      console.log(`Đang chạy ${live.length} phiên:`);
      for (const r of live) {
        const bestScore = r.best && r.best.score != null ? r.best.score : '—';
        console.log(`  - [${r.id}] ${r.status} | agents: ${r.agents} | giữ: ${r.kept}/${r.total} | best: ${bestScore}`);
        if (r.requirement) console.log(`    Yêu cầu: ${r.requirement}`);
      }
    }
    return;
  }

  if (args.includes('--runs') || args.includes('-l')) {
    const runsList = await fetch(`${url}/api/runs`).then((r) => r.json()).catch(() => []);
    if (!runsList.length) {
      console.log('Chưa có phiên swarm nào được ghi nhận.');
      return;
    }
    console.log(`Danh sách phiên swarm (${runsList.length} phiên):`);
    for (const r of runsList) {
      const bestScore = r.best && r.best.score != null ? r.best.score : '—';
      const liveTag = r.live ? ' (đang chạy)' : '';
      console.log(`  - [${r.id}] ${r.status}${liveTag} | agents: ${r.agents} | giữ: ${r.kept}/${r.total} | best: ${bestScore}`);
      if (r.workspace) console.log(`    Thư mục: ${r.workspace}`);
      if (r.requirement) console.log(`    Yêu cầu: ${r.requirement.length > 100 ? r.requirement.slice(0, 100) + '...' : r.requirement}`);
    }
    return;
  }

  const runIdx = args.indexOf('--run');
  if (runIdx !== -1) {
    const runId = args[runIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên: node src/chat.js --run <id>');
    }
    const r = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `Không tìm thấy hoặc không đọc được phiên ${runId} (HTTP ${r.status})`);
    }
    const snap = await r.json();
    console.log(`Phiên swarm: [${snap.id}]`);
    console.log(`  Trạng thái:    ${snap.status} (pha: ${snap.phase || '—'})`);
    console.log(`  Thư mục:       ${snap.workspace || snap.repoRoot || '—'}`);
    console.log(`  Nhánh gốc:     ${snap.central || '—'}`);
    if (snap.best) {
      console.log(`  Điểm cao nhất: ${snap.best.score != null ? snap.best.score : '—'} (commit: ${snap.best.commit || '—'})`);
    }
    if (snap.opts && snap.opts.requirement) {
      console.log(`  Yêu cầu:       ${snap.opts.requirement}`);
    }
    if (Array.isArray(snap.agents) && snap.agents.length) {
      console.log(`  Agents (${snap.agents.length}):`);
      for (const a of snap.agents) {
        console.log(`    - ${a.name} (${a.cli || 'cli'}): vòng ${a.iter || 0} [${a.status}]${a.note ? ` — ${a.note}` : ''}`);
      }
    }
    if (Array.isArray(snap.results) && snap.results.length) {
      const recent = snap.results.slice(-10);
      console.log(`  Kết quả gần nhất (${recent.length}/${snap.results.length}):`);
      for (const res of recent) {
        console.log(`    - vòng ${res.iter} [${res.agent}]: ${res.status} (score: ${res.score != null ? res.score : '—'}) ${res.desc || ''}`);
      }
    }
    return;
  }

  if (args.includes('--clear')) {
    const r = await fetch(`${url}/api/chat/clear`, { method: 'POST' });
    if (!r.ok) throw new Error('Không thể xóa lịch sử chat.');
    console.log('Đã xóa toàn bộ lịch sử trò chuyện.');
    return;
  }

  const stopIdx = args.indexOf('--stop');
  if (stopIdx !== -1) {
    const runId = args[stopIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên cần dừng: node src/chat.js --stop <id>');
    }
    const mode = args.includes('--graceful') ? 'graceful' : 'now';
    const r = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Lỗi khi dừng phiên ${runId} (HTTP ${r.status})`);
    console.log(`Đã gửi yêu cầu dừng phiên ${runId} (chế độ: ${mode}). Trạng thái hiện tại: ${j.status || 'stopping'}.`);
    return;
  }

  const mergeIdx = args.indexOf('--merge') !== -1 ? args.indexOf('--merge') : args.indexOf('-m');
  if (mergeIdx !== -1) {
    const runId = args[mergeIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên cần merge: node src/chat.js --merge <id>');
    }
    const r = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Lỗi khi merge phiên ${runId} (HTTP ${r.status})`);
    console.log(`Đã merge thành công phiên ${runId} vào nhánh ${j.branch || 'gốc'}.`);
    return;
  }

  const exportIdx = args.indexOf('--export') !== -1 ? args.indexOf('--export') : args.indexOf('-e');
  if (exportIdx !== -1) {
    const runId = args[exportIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên cần export: node src/chat.js --export <id> [file.csv]');
    }
    const outFile = args[exportIdx + 2] && !args[exportIdx + 2].startsWith('-') ? args[exportIdx + 2] : null;
    const r = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/export.csv`);
    if (!r.ok) {
      const errText = await r.text();
      let msg = errText;
      try {
        const j = JSON.parse(errText);
        if (j.error) msg = j.error;
      } catch {}
      throw new Error(msg || `Lỗi khi export CSV phiên ${runId} (HTTP ${r.status})`);
    }
    const csvData = await r.text();
    if (outFile) {
      fs.writeFileSync(outFile, csvData, 'utf8');
      console.log(`Đã lưu kết quả phiên ${runId} ra file: ${outFile}`);
    } else {
      process.stdout.write(csvData);
    }
    return;
  }

  const rebaselineIdx = args.indexOf('--rebaseline') !== -1 ? args.indexOf('--rebaseline') : args.indexOf('-r');
  if (rebaselineIdx !== -1) {
    const runId = args[rebaselineIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên cần re-baseline: node src/chat.js --rebaseline <id>');
    }
    const r = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/rebaseline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Lỗi khi re-baseline phiên ${runId} (HTTP ${r.status})`);
    const bestScore = j.best && j.best.score != null ? j.best.score : '—';
    const bestCommit = j.best && j.best.commit ? ` (${j.best.commit})` : '';
    console.log(`Đã re-baseline thành công phiên ${runId}. Best: ${bestScore}${bestCommit}.`);
    return;
  }

  if (args.includes('--harvest')) {
    const r = await fetch(`${url}/api/harvest`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Lỗi khi harvest (HTTP ${r.status})`);
    console.log(`Đã gom kết quả swarm thành công:`);
    console.log(`  Thư mục:  ${j.runsDir || '—'}`);
    console.log(`  Số phiên: ${(j.runIds || []).length} (${(j.runIds || []).join(', ') || 'không có'})`);
    console.log(`  Kết quả:  +${j.freshCount || 0} dòng mới (tổng ${j.totalCount || 0} dòng trong ${j.outPath || 'knowledge/improvements_log.jsonl'})`);
    return;
  }

  const oneShot = args.join(' ').trim();

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
