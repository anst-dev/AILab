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
  node src/chat.js --catalog, -c     Xem danh mục agent CLI đã cài và lệnh chạy (-c)
  node src/chat.js --inspect <p>, -I Kiểm tra thư mục workspace trước khi chạy swarm (-I <path>)
  node src/chat.js --runs, -l        Liệt kê tất cả các phiên swarm (cả đang chạy và lịch sử)
  node src/chat.js --run <id>, -i    Xem thông tin chi tiết của một phiên swarm (-i <id>)
  node src/chat.js --gitlog <id>, -g  Xem lịch sử commit git đã tích lũy trong phiên swarm (-g <id>)
  node src/chat.js --diff <id>, -d   Xem diff các thay đổi mã nguồn đã tích lũy (-d <id> [--stat])
  node src/chat.js --logs <id>       Liệt kê danh sách các file log trong phiên swarm
  node src/chat.js --log <id> [f], -L Xem log của agent/đánh giá trong phiên swarm (-L <id> [file])
  node src/chat.js --stop <id>, -k   Dừng một phiên swarm đang chạy (--graceful để chờ vòng hiện tại) (-k <id>)
  node src/chat.js --delete <id>, -D Xóa dữ liệu của một phiên đã dừng (-D <id>)
  node src/chat.js --merge <id>, -m  Merge nhánh của phiên đã dừng vào nhánh gốc của dự án (-m <id>)
  node src/chat.js --export <id|harvest> [f] Xuất kết quả phiên swarm hoặc tri thức ra file CSV/JSON (-e)
  node src/chat.js --export-harvest [f], -E  Xuất toàn bộ kho tri thức ra file CSV/JSON (-E [file])
  node src/chat.js --rebaseline <id> Chấm lại baseline cho một phiên đang chạy (-r <id>)
  node src/chat.js --harvest, -H     Gom kết quả các phiên swarm vào knowledge/improvements_log.jsonl
  node src/chat.js --stats, -S       Xem thống kê tổng hợp từ kho tri thức improvements_log.jsonl (-S)
  node src/chat.js --knowledge [n], -K Xem các dòng tri thức đã gom (mặc định 20 dòng gần nhất) (-K [n])
  node src/chat.js --clear           Xóa lịch sử trò chuyện của điều phối viên
  node src/chat.js --shutdown, -X    Tắt server điều phối agent-swarm (-X)
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

  if (args.includes('--catalog') || args.includes('-c')) {
    const cat = await fetch(`${url}/api/catalog`).then((r) => r.json()).catch(() => null);
    if (!cat || !cat.agents) {
      throw new Error('Không thể lấy thông tin danh mục agent từ server.');
    }
    console.log(`Hệ điều hành: ${cat.platform || process.platform}`);
    console.log(`Danh mục Agent CLI (${cat.agents.length} loại):`);
    for (const a of cat.agents) {
      const tag = a.found ? '[ĐÃ CÀI]' : '[CHƯA CÀI]';
      console.log(`  - ${a.id.padEnd(12)} ${tag.padEnd(11)} ${a.name}`);
      if (a.path) console.log(`      Đường dẫn: ${a.path}`);
      if (a.template) console.log(`      Lệnh chạy: ${a.template}`);
    }
    if (cat.coordinator && cat.coordinator.cli) {
      console.log(`Điều phối viên: ${cat.coordinator.cli}`);
    }
    if (Array.isArray(cat.recentWorkspaces) && cat.recentWorkspaces.length) {
      console.log('Thư mục làm việc gần đây:');
      for (const ws of cat.recentWorkspaces) {
        console.log(`  - ${ws}`);
      }
    }
    return;
  }

  const inspectIdx = args.indexOf('--inspect') !== -1 ? args.indexOf('--inspect') : args.indexOf('-I');
  if (inspectIdx !== -1) {
    const targetPath = args[inspectIdx + 1];
    if (!targetPath || targetPath.startsWith('-')) {
      throw new Error('Vui lòng chỉ định đường dẫn workspace cần kiểm tra: node src/chat.js --inspect <path> (-I <path>)');
    }
    const resolved = path.resolve(targetPath);
    const r = await fetch(`${url}/api/inspect?path=${encodeURIComponent(resolved)}`);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `Lỗi khi kiểm tra thư mục (HTTP ${r.status})`);
    }
    const info = await r.json();
    console.log(`Kiểm tra workspace: ${info.path || resolved}`);
    if (info.error) {
      console.log(`  ! Lỗi: ${info.error}`);
    } else {
      console.log(`  * Tồn tại:      ${info.exists ? 'Có' : 'Không'}`);
      if (info.isDir) console.log(`  * Loại:         Thư mục`);
      console.log(`  * Git repo:     ${info.isRepo ? `Có (nhánh: ${info.branch || '—'}, commit HEAD: ${info.head || '—'})` : 'Chưa có'}`);
      if (info.isRepo && info.dirty != null) {
        console.log(`  * File sửa đổi: ${info.dirty > 0 ? `${info.dirty} file chưa commit` : 'Sạch (clean)'}`);
      }
      if (info.hasProgram) console.log(`  * File cấu hình: Tìm thấy program.md`);
      if (info.hasTrainPy) console.log(`  * File script:   Tìm thấy train.py`);
      if (info.note) console.log(`  * Ghi chú:      ${info.note}`);
      if (Array.isArray(info.files) && info.files.length) {
        console.log(`  * Danh sách tệp (${info.files.length}): ${info.files.slice(0, 10).join(', ')}${info.files.length > 10 ? '...' : ''}`);
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

  const runIdx = args.indexOf('--run') !== -1 ? args.indexOf('--run') : args.indexOf('-i');
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

  const gitlogIdx = args.indexOf('--gitlog') !== -1 ? args.indexOf('--gitlog') : args.indexOf('-g');
  if (gitlogIdx !== -1) {
    const runId = args[gitlogIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên cần xem git log: node src/chat.js --gitlog <id> (-g <id>)');
    }
    const rRun = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    if (!rRun.ok) {
      const j = await rRun.json().catch(() => ({}));
      throw new Error(j.error || `Không tìm thấy phiên ${runId} (HTTP ${rRun.status})`);
    }
    const snap = await rRun.json();
    const rLog = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/gitlog?repo=${encodeURIComponent(snap.repoRoot || '')}`);
    if (!rLog.ok) {
      throw new Error(`Lỗi khi lấy git log của phiên ${runId} (HTTP ${rLog.status})`);
    }
    const commits = await rLog.json();
    if (!Array.isArray(commits) || !commits.length) {
      console.log(`Phiên ${runId} chưa có commit nào được tích lũy vào nhánh trung tâm.`);
    } else {
      console.log(`Git log phiên ${runId} (${commits.length} commit):`);
      for (const c of commits) {
        console.log(`  * ${c.hash} (${c.when || '—'}, ${c.author || '—'}): ${c.subject || ''}`);
      }
    }
    return;
  }

  const diffIdx = args.indexOf('--diff') !== -1 ? args.indexOf('--diff') : args.indexOf('-d');
  if (diffIdx !== -1) {
    const runId = args[diffIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên cần xem diff: node src/chat.js --diff <id> (-d <id>) [--stat]');
    }
    const rRun = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    if (!rRun.ok) {
      const j = await rRun.json().catch(() => ({}));
      throw new Error(j.error || `Không tìm thấy phiên ${runId} (HTTP ${rRun.status})`);
    }
    const snap = await rRun.json();
    const statParam = args.includes('--stat') ? '&stat=1' : '';
    const rDiff = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/diff?repo=${encodeURIComponent(snap.repoRoot || '')}${statParam}`);
    if (!rDiff.ok) {
      throw new Error(`Lỗi khi lấy diff của phiên ${runId} (HTTP ${rDiff.status})`);
    }
    const diffText = await rDiff.text();
    if (!diffText.trim()) {
      console.log(`Phiên ${runId} chưa có thay đổi nào so với commit gốc.`);
    } else {
      console.log(`Git diff phiên ${runId}${args.includes('--stat') ? ' (--stat)' : ''}:`);
      console.log(diffText);
    }
    return;
  }

  const logsIdx = args.indexOf('--logs');
  if (logsIdx !== -1) {
    const runId = args[logsIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên cần xem danh sách log: node src/chat.js --logs <id>');
    }
    const rRun = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    if (!rRun.ok) {
      const j = await rRun.json().catch(() => ({}));
      throw new Error(j.error || `Không tìm thấy phiên ${runId} (HTTP ${rRun.status})`);
    }
    const snap = await rRun.json();
    const rLogs = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/logs?repo=${encodeURIComponent(snap.repoRoot || '')}`);
    if (!rLogs.ok) {
      throw new Error(`Lỗi khi lấy danh sách log của phiên ${runId} (HTTP ${rLogs.status})`);
    }
    const { files = [] } = await rLogs.json();
    if (!files.length) {
      console.log(`Phiên ${runId} chưa có file log nào.`);
    } else {
      console.log(`Danh sách file log của phiên ${runId} (${files.length} file):`);
      for (const f of files) {
        const sz = f.size != null ? `${(f.size / 1024).toFixed(1)} KB` : '—';
        console.log(`  - ${f.name.padEnd(35)} (${sz})`);
      }
      console.log(`\nXem nội dung log: node src/chat.js --log ${runId} <tên_file>`);
    }
    return;
  }

  const logIdx = args.indexOf('--log') !== -1 ? args.indexOf('--log') : args.indexOf('-L');
  if (logIdx !== -1) {
    const runId = args[logIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên cần xem log: node src/chat.js --log <id> [file] (-L <id>)');
    }
    const rRun = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    if (!rRun.ok) {
      const j = await rRun.json().catch(() => ({}));
      throw new Error(j.error || `Không tìm thấy hoặc không đọc được phiên ${runId} (HTTP ${rRun.status})`);
    }
    const snap = await rRun.json();
    let file = args[logIdx + 2] && !args[logIdx + 2].startsWith('-') ? args[logIdx + 2] : null;
    if (file) {
      if (Array.isArray(snap.agents)) {
        const ag = snap.agents.find((a) => a.name === file);
        if (ag && ag.lastLog) file = ag.lastLog;
      }
      if (Array.isArray(snap.results) && !file.endsWith('.log')) {
        const res = snap.results.slice().reverse().find((r) => r.agent === file && r.log);
        if (res) file = res.log;
      }
    } else {
      const lastRes = Array.isArray(snap.results) ? snap.results.slice().reverse().find((r) => r.log) : null;
      const lastAg = Array.isArray(snap.agents) ? snap.agents.find((a) => a.lastLog) : null;
      if (lastRes && lastRes.log) file = lastRes.log;
      else if (lastAg && lastAg.lastLog) file = lastAg.lastLog;
    }
    if (!file) {
      throw new Error(`Phiên ${runId} chưa có file log nào.`);
    }
    const rLog = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/log?repo=${encodeURIComponent(snap.repoRoot || '')}&file=${encodeURIComponent(file)}`);
    if (!rLog.ok) {
      const errText = await rLog.text();
      let msg = errText;
      try {
        const j = JSON.parse(errText);
        if (j.error) msg = j.error;
      } catch {}
      throw new Error(msg || `Lỗi khi lấy log file ${file} (HTTP ${rLog.status})`);
    }
    const logText = await rLog.text();
    console.log(`=== Log: ${file} (phiên ${runId}) ===`);
    console.log(logText);
    return;
  }

  if (args.includes('--clear')) {
    const r = await fetch(`${url}/api/chat/clear`, { method: 'POST' });
    if (!r.ok) throw new Error('Không thể xóa lịch sử chat.');
    console.log('Đã xóa toàn bộ lịch sử trò chuyện.');
    return;
  }

  if (args.includes('--shutdown') || args.includes('-X')) {
    try {
      const res = await fetch(`${url}/api/shutdown`, { method: 'POST' }).then((r) => r.json());
      console.log(res.message || 'Đã gửi yêu cầu tắt server.');
    } catch (e) {
      console.log(`Lỗi khi tắt server: ${e.message}`);
    }
    return;
  }

  const stopIdx = args.indexOf('--stop') !== -1 ? args.indexOf('--stop') : args.indexOf('-k');
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

  const delIdx = args.indexOf('--delete') !== -1 ? args.indexOf('--delete') : args.indexOf('-D');
  if (delIdx !== -1) {
    const runId = args[delIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên cần xóa: node src/chat.js --delete <id> (-D <id>)');
    }
    const rRun = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    let repoParam = '';
    if (rRun.ok) {
      const snap = await rRun.json().catch(() => ({}));
      if (snap && snap.repoRoot) repoParam = `?repo=${encodeURIComponent(snap.repoRoot)}`;
    }
    const r = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}${repoParam}`, {
      method: 'DELETE',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Lỗi khi xóa phiên ${runId} (HTTP ${r.status})`);
    console.log(`Đã xóa thành công dữ liệu phiên ${runId}.`);
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

  const expHarvIdx = args.indexOf('--export-harvest') !== -1 ? args.indexOf('--export-harvest') : args.indexOf('-E');
  if (expHarvIdx !== -1) {
    const outFile = args[expHarvIdx + 1] && !args[expHarvIdx + 1].startsWith('-') ? args[expHarvIdx + 1] : null;
    const isJson = (outFile && outFile.endsWith('.json')) || args.includes('--json');
    const endpoint = isJson ? 'export.json' : 'export.csv';
    const r = await fetch(`${url}/api/harvest/${endpoint}`);
    if (!r.ok) {
      const errText = await r.text();
      let msg = errText;
      try {
        const j = JSON.parse(errText);
        if (j.error) msg = j.error;
      } catch {}
      throw new Error(msg || `Lỗi khi xuất ${isJson ? 'JSON' : 'CSV'} kho tri thức (HTTP ${r.status})`);
    }
    const outData = await r.text();
    if (outFile) {
      fs.writeFileSync(outFile, outData, 'utf8');
      console.log(`Đã lưu kho tri thức ra file: ${outFile}`);
    } else {
      process.stdout.write(outData);
    }
    return;
  }

  const exportIdx = args.indexOf('--export') !== -1 ? args.indexOf('--export') : args.indexOf('-e');
  if (exportIdx !== -1) {
    const runId = args[exportIdx + 1];
    if (!runId || runId.startsWith('-')) {
      throw new Error('Vui lòng chỉ định ID phiên hoặc "harvest" cần export: node src/chat.js --export <id|harvest> [file.csv|file.json]');
    }
    const outFile = args[exportIdx + 2] && !args[exportIdx + 2].startsWith('-') ? args[exportIdx + 2] : null;
    const isJson = (outFile && outFile.endsWith('.json')) || args.includes('--json');
    const endpoint = isJson ? 'export.json' : 'export.csv';
    const isKnowledge = runId.toLowerCase() === 'knowledge' || runId.toLowerCase() === 'harvest';
    const targetUrl = isKnowledge
      ? `${url}/api/harvest/${endpoint}`
      : `${url}/api/runs/${encodeURIComponent(runId)}/${endpoint}`;
    const r = await fetch(targetUrl);
    if (!r.ok) {
      const errText = await r.text();
      let msg = errText;
      try {
        const j = JSON.parse(errText);
        if (j.error) msg = j.error;
      } catch {}
      throw new Error(msg || `Lỗi khi export ${isJson ? 'JSON' : 'CSV'} ${isKnowledge ? 'kho tri thức' : `phiên ${runId}`} (HTTP ${r.status})`);
    }
    const outData = await r.text();
    if (outFile) {
      fs.writeFileSync(outFile, outData, 'utf8');
      console.log(`Đã lưu kết quả ${isKnowledge ? 'kho tri thức' : `phiên ${runId}`} ra file: ${outFile}`);
    } else {
      process.stdout.write(outData);
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

  if (args.includes('--harvest') || args.includes('-H')) {
    const r = await fetch(`${url}/api/harvest`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Lỗi khi harvest (HTTP ${r.status})`);
    console.log(`Đã gom kết quả swarm thành công:`);
    console.log(`  Thư mục:  ${j.runsDir || '—'}`);
    console.log(`  Số phiên: ${(j.runIds || []).length} (${(j.runIds || []).join(', ') || 'không có'})`);
    console.log(`  Kết quả:  +${j.freshCount || 0} dòng mới (tổng ${j.totalCount || 0} dòng trong ${j.outPath || 'knowledge/improvements_log.jsonl'})`);
    return;
  }

  const statsIdx = args.indexOf('--stats') !== -1 ? args.indexOf('--stats') : args.indexOf('-S');
  if (statsIdx !== -1) {
    const isJson = args.includes('--json');
    const r = await fetch(`${url}/api/harvest?limit=1`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Lỗi khi lấy thống kê tri thức (HTTP ${r.status})`);
    if (!j.exists || !j.stats || !j.stats.total) {
      console.log('Kho tri thức (knowledge/improvements_log.jsonl) chưa có dữ liệu.');
      console.log('Chạy "node src/chat.js --harvest" để gom kết quả từ các phiên swarm.');
      return;
    }
    if (isJson) {
      console.log(JSON.stringify(j.stats, null, 2));
      return;
    }
    const s = j.stats;
    console.log(`Thống kê kho tri thức (${j.outPath || 'knowledge/improvements_log.jsonl'}):`);
    console.log(`  Tổng số bản ghi: ${s.total}`);
    console.log(`  Tỷ lệ keep:      ${s.keepRate}% (keep: ${s.keepCount}, discard: ${s.discardCount}, conflict: ${s.conflictCount}, error: ${s.errorCount})`);
    if (s.byStatus && Object.keys(s.byStatus).length > 0) {
      console.log('  Theo trạng thái:');
      for (const [st, c] of Object.entries(s.byStatus)) {
        console.log(`    - ${st}: ${c}`);
      }
    }
    if (s.byBot && Object.keys(s.byBot).length > 0) {
      console.log('  Theo agent:');
      for (const [bot, c] of Object.entries(s.byBot)) {
        console.log(`    - ${bot}: ${c}`);
      }
    }
    return;
  }

  const knowIdx = args.indexOf('--knowledge') !== -1 ? args.indexOf('--knowledge') : args.indexOf('-K');
  if (knowIdx !== -1) {
    const rawLimit = args[knowIdx + 1];
    const limit = (rawLimit && !rawLimit.startsWith('-') && parseInt(rawLimit, 10)) ? parseInt(rawLimit, 10) : 20;
    const r = await fetch(`${url}/api/harvest?limit=${limit}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Lỗi khi lấy tri thức (HTTP ${r.status})`);
    if (!j.exists || !j.items || !j.items.length) {
      console.log('Kho tri thức (knowledge/improvements_log.jsonl) chưa có dữ liệu.');
      console.log('Chạy "node src/chat.js --harvest" để gom kết quả từ các phiên swarm.');
      return;
    }
    console.log(`Kho tri thức cải tiến (${j.items.length}/${j.totalCount} dòng gần nhất từ ${j.outPath}):`);
    for (const item of j.items) {
      const t = item.ts ? item.ts.slice(0, 19).replace('T', ' ') : '—';
      const bot = item.bot || item.agent || '—';
      const c = item.commit ? item.commit.slice(0, 7) : '—';
      const score = item.score != null ? item.score : '—';
      const st = item.status || '—';
      const desc = [item.feature, item.note].filter(Boolean).join(' — ') || item.desc || item.raw || '';
      console.log(`  [${t}] ${c} | ${bot} | ${st} | điểm: ${score}`);
      if (desc) console.log(`    ${desc}`);
    }
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
