'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  catalog: [],
  suggested: {},
  counts: {},
  runs: [],
  live: new Map(), // id -> snapshot pushed by the server
  view: null, // { id, repo }
  snap: null,
  gitKey: '',
  log: null, // { file, title }
};

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// presets & form
// ---------------------------------------------------------------------------

const AUTORESEARCH_EXTRA = `This project is karpathy/autoresearch: a single-GPU LLM pretraining setup.
- Read README.md and program.md for context. The metric is val_bpb (validation bits per byte) — lower is better.
- ONLY edit train.py. prepare.py (data, tokenizer, evaluation) is read-only. Do not add dependencies.
- NEVER run \`uv run train.py\` or \`uv run prepare.py\` yourself: training takes 5 minutes and you would be killed. The orchestrator trains and evaluates after you stop.
- To sanity check syntax you may run: uv run python -m py_compile train.py
- Keep the code simple: a tiny gain that adds ugly complexity is not worth it; removing code for equal results is a win.
- VRAM is a soft constraint; do not blow it up.`;

const PRESETS = {
  free: { evalMode: 'none', evalCommand: '', metricRegex: '', direction: 'min', protectedFiles: '', extraInstructions: '', evalTimeoutMin: 15, evalConcurrency: 1 },
  pass: { evalMode: 'pass', evalCommand: 'npm test', metricRegex: '', direction: 'min', protectedFiles: '', extraInstructions: '', evalTimeoutMin: 10, evalConcurrency: 2 },
  score: { evalMode: 'score', evalCommand: 'python eval.py', metricRegex: '^score:\\s*([-0-9.eE+]+)', direction: 'max', protectedFiles: 'eval.py', extraInstructions: '', evalTimeoutMin: 10, evalConcurrency: 1 },
  autoresearch: {
    evalMode: 'score',
    evalCommand: 'uv run train.py',
    metricRegex: '^val_bpb:\\s*([0-9.]+)',
    direction: 'min',
    minDelta: 0,
    protectedFiles: 'prepare.py, pyproject.toml, uv.lock, program.md, README.md',
    extraInstructions: AUTORESEARCH_EXTRA,
    evalTimeoutMin: 10,
    evalConcurrency: 1,
    baseline: true,
    requirement: 'Giảm val_bpb (validation bits per byte) của mô hình trong train.py: thử thay đổi kiến trúc, optimizer, siêu tham số, batch size... Mỗi lượt chỉ thử MỘT ý tưởng rõ ràng.',
  },
};

const FIELDS = ['workspace', 'requirement', 'timeLimitMin', 'evalCommand', 'metricRegex', 'direction', 'minDelta', 'evalTimeoutMin', 'evalConcurrency', 'protectedFiles', 'maxIterations', 'maxDurationMin', 'staggerSec', 'extraInstructions'];
const CHECKS = ['baseline', 'keepWorktrees'];

function evalMode() {
  const r = document.querySelector('input[name=evalMode]:checked');
  return r ? r.value : 'none';
}

function setEvalMode(v) {
  const r = document.querySelector(`input[name=evalMode][value="${v}"]`);
  if (r) r.checked = true;
  updateEvalVisibility();
}

function updateEvalVisibility() {
  const m = evalMode();
  $('evalFields').hidden = m === 'none';
  document.querySelectorAll('.score-only').forEach((el) => (el.hidden = m !== 'score'));
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  for (const k of ['evalCommand', 'metricRegex', 'direction', 'protectedFiles', 'extraInstructions', 'evalTimeoutMin', 'evalConcurrency', 'minDelta']) {
    if (p[k] !== undefined) $(k).value = p[k];
  }
  if (p.baseline !== undefined) $('baseline').checked = p.baseline;
  setEvalMode(p.evalMode);
  const presetReqs = Object.values(PRESETS).map((x) => x.requirement).filter(Boolean);
  if (p.requirement && (!$('requirement').value.trim() || presetReqs.includes($('requirement').value.trim()))) $('requirement').value = p.requirement;
  if (name === 'autoresearch' && state.suggested.autoresearch) $('workspace').value = state.suggested.autoresearch;
  saveForm();
}

function collectForm() {
  const f = { preset: $('preset').value, evalMode: evalMode(), counts: state.counts };
  for (const k of FIELDS) f[k] = $(k).value;
  for (const k of CHECKS) f[k] = $(k).checked;
  return f;
}

function saveForm() {
  store.set('swarm.form', collectForm());
}

function restoreForm() {
  const f = store.get('swarm.form', null);
  if (!f) {
    applyPreset('free');
    return;
  }
  for (const k of FIELDS) if (f[k] !== undefined) $(k).value = f[k];
  for (const k of CHECKS) if (f[k] !== undefined) $(k).checked = !!f[k];
  if (f.preset) $('preset').value = f.preset;
  state.counts = f.counts || {};
  setEvalMode(f.evalMode || 'none');
}

function renderAgentRows() {
  const rows = state.catalog.map((a) => {
    const count = a.found ? state.counts[a.id] || 0 : 0;
    return `<tr class="${a.found ? '' : 'missing'}">
      <td><b>${esc(a.name)}</b><div class="muted" style="font-size:12px"><code>${esc(a.template)}</code></div></td>
      <td>${a.found ? '<span class="badge b-ok">có trên máy</span>' : '<span class="badge b-mute">không tìm thấy</span>'}</td>
      <td><input type="number" class="num" min="0" max="32" value="${count}" data-agent="${esc(a.id)}" ${a.found ? '' : 'disabled'}></td>
    </tr>`;
  });
  $('agentRows').innerHTML = rows.join('') || '<tr><td colspan="3">Không có agent nào.</td></tr>';
  $('agentRows').querySelectorAll('input[data-agent]').forEach((inp) =>
    inp.addEventListener('input', () => {
      state.counts[inp.dataset.agent] = Math.max(0, Math.min(32, parseInt(inp.value, 10) || 0));
      updateTotal();
      saveForm();
    })
  );
  updateTotal();
}

function updateTotal() {
  let t = 0;
  for (const a of state.catalog) if (a.found) t += state.counts[a.id] || 0;
  $('agentTotal').textContent = t;
}

async function loadCatalog() {
  const data = await api('/api/catalog');
  state.catalog = data.agents;
  state.suggested = data.suggested || {};
  $('recentWs').innerHTML = (data.recentWorkspaces || []).map((p) => `<option value="${esc(p)}">`).join('');
  // first time: one Claude-like agent by default
  if (!Object.keys(state.counts).length) {
    const first = state.catalog.find((a) => a.found);
    if (first) state.counts[first.id] = 2;
  }
  renderAgentRows();
  renderCoordSelect(data.coordinator);
}

async function inspectWorkspace() {
  const p = $('workspace').value.trim();
  const out = $('inspectOut');
  if (!p) {
    out.textContent = '';
    return;
  }
  out.textContent = 'Đang kiểm tra...';
  try {
    const i = await api(`/api/inspect?path=${encodeURIComponent(p)}`);
    if (i.error) out.innerHTML = `<span style="color:var(--bad)">${esc(i.error)}</span>`;
    else if (!i.exists || !i.isRepo) out.innerHTML = `${esc(i.note)}${i.files && i.files.length ? `<br>Nội dung: ${esc(i.files.join(', '))}` : ''}`;
    else
      out.innerHTML =
        `Git repo <b>${esc(i.root)}</b> · nhánh <b>${esc(i.branch)}</b> · HEAD <code>${esc(i.head)}</code>` +
        (i.dirty ? ` · <span style="color:var(--warn)">${i.dirty} file chưa commit (sẽ được lưu snapshot vào nhánh swarm, nhánh hiện tại giữ nguyên)</span>` : ' · sạch') +
        (i.hasTrainPy && i.hasProgram ? '<br>Phát hiện cấu trúc autoresearch (train.py + program.md): có thể chọn mẫu "autoresearch".' : '');
  } catch (e) {
    out.textContent = e.message;
  }
}

async function startRun(ev) {
  ev.preventDefault();
  const err = $('formError');
  err.hidden = true;
  const f = collectForm();
  const agents = state.catalog.filter((a) => a.found && (state.counts[a.id] || 0) > 0).map((a) => ({ cli: a.id, count: state.counts[a.id] }));
  const body = {
    ...f,
    agents,
    timeLimitMin: Number(f.timeLimitMin),
    minDelta: Number(f.minDelta),
    evalTimeoutMin: Number(f.evalTimeoutMin),
    evalConcurrency: Number(f.evalConcurrency),
    maxIterations: Number(f.maxIterations),
    maxDurationMin: Number(f.maxDurationMin),
    staggerSec: Number(f.staggerSec),
  };
  $('btnStart').disabled = true;
  try {
    const { id } = await api('/api/runs', { method: 'POST', body });
    saveForm();
    await refreshRuns();
    showRun(id, '');
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    $('btnStart').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// run list
// ---------------------------------------------------------------------------

const RUN_STATUS = {
  preparing: ['chuẩn bị', 'b-info'],
  running: ['đang chạy', 'b-ok'],
  stopping: ['đang dừng', 'b-warn'],
  stopped: ['đã dừng', 'b-mute'],
  error: ['lỗi', 'b-bad'],
  interrupted: ['gián đoạn', 'b-warn'],
};
const badge = (map, key) => {
  const [label, cls] = map[key] || [key, 'b-mute'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
};

async function refreshRuns() {
  try {
    state.runs = await api('/api/runs');
  } catch {
    return;
  }
  renderRunList();
}

function renderRunList() {
  const el = $('runList');
  if (!state.runs.length) {
    el.innerHTML = '<p class="muted">Chưa có phiên nào.</p>';
    return;
  }
  el.innerHTML = state.runs
    .map((r) => {
      const live = state.live.get(r.id);
      const status = live ? live.status : r.status;
      const active = state.view && state.view.id === r.id ? ' active' : '';
      const best = r.best ? ` · best ${r.best.score}` : '';
      return `<button class="run-item${active}" data-id="${esc(r.id)}" data-repo="${esc(r.repoRoot || '')}">
        <div class="t"><span>${esc(r.id)}</span>${badge(RUN_STATUS, status)}</div>
        <div class="s">${esc(r.requirement)}</div>
        <div class="s">${r.agents} agent · giữ ${r.kept}/${r.total}${esc(best)}</div>
      </button>`;
    })
    .join('');
  el.querySelectorAll('.run-item').forEach((b) => b.addEventListener('click', () => showRun(b.dataset.id, b.dataset.repo)));
}

// ---------------------------------------------------------------------------
// run view
// ---------------------------------------------------------------------------

function showNew() {
  state.view = null;
  state.snap = null;
  $('viewRun').hidden = true;
  $('viewChat').hidden = true;
  $('viewNew').hidden = false;
  renderRunList();
}

async function showRun(id, repo) {
  state.view = { id, repo };
  state.gitKey = '';
  $('viewNew').hidden = true;
  $('viewChat').hidden = true;
  $('viewRun').hidden = false;
  renderRunList();
  const snap = state.live.get(id) || (await api(`/api/runs/${id}?repo=${encodeURIComponent(repo || '')}`).catch(() => null));
  if (snap && state.view && state.view.id === id) {
    state.snap = snap;
    renderRun();
  }
}

const AGENT_STATUS = {
  idle: ['chờ', 'b-mute'],
  syncing: ['đồng bộ', 'b-info'],
  working: ['đang làm', 'b-ok'],
  committing: ['commit', 'b-info'],
  'waiting-eval': ['chờ đánh giá', 'b-warn'],
  evaluating: ['đang đánh giá', 'b-warn'],
  merging: ['merge', 'b-info'],
  done: ['xong', 'b-mute'],
};
const RESULT_STATUS = {
  keep: ['giữ', 'b-ok'],
  discard: ['loại', 'b-mute'],
  crash: ['lỗi', 'b-bad'],
  error: ['lỗi hệ thống', 'b-bad'],
  conflict: ['xung đột', 'b-warn'],
  duplicate: ['trùng', 'b-mute'],
  'no-change': ['không đổi', 'b-mute'],
  stopped: ['dừng', 'b-mute'],
  baseline: ['baseline', 'b-info'],
};

function dur(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}g${String(m).padStart(2, '0')}p` : `${m}:${String(ss).padStart(2, '0')}`;
}
const time = (t) => new Date(t).toLocaleTimeString('vi-VN', { hour12: false });

function renderRun() {
  const s = state.snap;
  if (!s) return;
  const live = state.live.has(s.id);
  $('runTitle').innerHTML = `Phiên ${esc(s.id)} ${badge(RUN_STATUS, s.status)}`;
  $('runSub').innerHTML = `${esc(s.workspace)} · nhánh trung tâm <code>${esc(s.central)}</code>${s.originalBranch ? ` · nhánh gốc <code>${esc(s.originalBranch)}</code>` : ''} · ${esc(s.phase || '')}`;
  $('runReq').textContent = s.opts.requirement;
  $('centralName').textContent = s.central;

  const acts = [];
  if (live && (s.status === 'running' || s.status === 'preparing' || s.status === 'stopping')) {
    if (!s.stopMode) acts.push('<button class="secondary" data-act="graceful">Dừng sau lượt này</button>');
    acts.push('<button class="danger" data-act="now">■ Dừng ngay</button>');
  }
  if (live && s.status === 'stopped' && s.originalBranch && !s.mergedBack) {
    acts.push(`<button class="primary" data-act="merge">Merge kết quả vào ${esc(s.originalBranch)}</button>`);
  }
  if (s.mergedBack) acts.push(`<span class="badge b-ok">Đã merge vào ${esc(s.mergedBack.branch)}</span>`);
  $('runActions').innerHTML = acts.join('');
  $('runActions').querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => runAction(b.dataset.act)));

  const rows = s.results.filter((r) => r.agent !== 'orchestrator');
  const cnt = (st) => rows.filter((r) => r.status === st).length;
  const end = s.endedAt || Date.now();
  const tiles = [];
  if (s.opts.evalMode === 'score') {
    const base = s.results.find((r) => r.status === 'baseline');
    const delta = s.best && base && base.score != null ? s.best.score - base.score : null;
    tiles.push(['Best ' + (s.opts.direction === 'min' ? '(thấp là tốt)' : '(cao là tốt)'), s.best ? s.best.score : '—', s.best ? `${s.best.desc}${delta !== null ? ` · Δ ${delta > 0 ? '+' : ''}${+delta.toFixed(6)}` : ''}` : 'chưa có']);
  }
  tiles.push(['Được giữ', cnt('keep'), 'đã merge vào nhánh trung tâm']);
  tiles.push(['Bị loại / không đổi', cnt('discard') + cnt('no-change') + cnt('duplicate'), '']);
  tiles.push(['Xung đột', cnt('conflict'), 'thay đổi đè lên nhau']);
  tiles.push(['Lỗi', cnt('crash') + cnt('error'), '']);
  tiles.push(['Thời gian', dur(end - s.startedAt), `${rows.length} lượt`]);
  $('tiles').innerHTML = tiles.map(([k, v, d]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="d" title="${esc(d)}">${esc(d)}</div></div>`).join('');

  renderAgents();
  renderScoreChart();

  $('resultRows').innerHTML =
    s.results
      .slice()
      .reverse()
      .map(
        (r, i) => `<tr class="${r.log ? 'clickable' : ''}" data-i="${s.results.length - 1 - i}">
          <td class="mono">${time(r.t)}</td><td>${esc(r.agent)}</td><td>${r.iter || ''}</td>
          <td>${badge(RESULT_STATUS, r.status)}</td><td class="mono">${r.score == null ? '' : esc(r.score)}</td>
          <td class="mono">${esc(r.commit)}</td><td>${esc(r.desc)}</td></tr>`
      )
      .join('') || '<tr><td colspan="7" class="muted">Chưa có lượt nào hoàn thành.</td></tr>';
  $('resultRows').querySelectorAll('tr.clickable').forEach((tr) =>
    tr.addEventListener('click', () => {
      const r = s.results[Number(tr.dataset.i)];
      openLog(r.log, `${r.agent} lượt ${r.iter}`);
    })
  );

  $('events').innerHTML = s.events
    .slice()
    .reverse()
    .map((e) => `<li class="${esc(e.level)}"><span class="muted">${time(e.t)}</span> ${esc(e.msg)}</li>`)
    .join('');

  const key = `${s.id}:${cnt('keep')}:${s.status}`;
  if (key !== state.gitKey) {
    state.gitKey = key;
    loadGitLog();
  }
}

function renderAgents() {
  const s = state.snap;
  if (!s) return;
  const limit = s.opts.timeLimitMin * 60000;
  $('agentsGrid').innerHTML = s.agents
    .map((a, i) => {
      const working = a.status === 'working' && a.deadline;
      const left = working ? Math.max(0, a.deadline - Date.now()) : 0;
      const pct = working ? Math.min(100, 100 - (left / limit) * 100) : 0;
      return `<div class="agent" data-i="${i}">
        <div class="h"><span class="n">${esc(a.name)}</span>${badge(AGENT_STATUS, a.status)}</div>
        <div class="c">${esc(a.cliName)} · lượt ${a.iter}</div>
        <div class="note" title="${esc(a.note)}">${a.note ? esc(a.note) : '<span class="muted">—</span>'}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="f"><span>✔ ${a.kept} · ✖ ${a.discarded} · ⚠ ${a.crashed}</span><span>${working ? `còn ${dur(left)}` : ''}</span></div>
      </div>`;
    })
    .join('');
  $('agentsGrid').querySelectorAll('.agent').forEach((el) =>
    el.addEventListener('click', () => {
      const a = s.agents[Number(el.dataset.i)];
      if (a.lastLog) openLog(a.lastLog, `${a.name} lượt ${a.iter}`);
    })
  );
}

function renderScoreChart() {
  const card = $('chartCard');
  const container = $('scoreChart');
  if (!card || !container) return;
  const s = state.snap;
  if (!s || !s.results) {
    card.hidden = true;
    return;
  }

  const valid = s.results.filter(
    (r) => r.score !== null && r.score !== undefined && r.score !== '' && !isNaN(Number(r.score))
  );

  if (!valid.length) {
    if (s.opts && s.opts.evalMode === 'score') {
      card.hidden = false;
      container.innerHTML = '<p class="muted" style="margin:8px 0">Chưa có kết quả điểm số để vẽ biểu đồ.</p>';
    } else {
      card.hidden = true;
    }
    return;
  }

  card.hidden = false;

  const iters = valid.map((r) => (r.iter != null && !isNaN(Number(r.iter)) ? Number(r.iter) : 0));
  const scores = valid.map((r) => Number(r.score));

  const minIter = 0;
  let maxIter = Math.max(1, ...iters);
  if (minIter === maxIter) maxIter = minIter + 1;

  let minScore = Math.min(...scores);
  let maxScore = Math.max(...scores);
  if (minScore === maxScore) {
    minScore -= 1;
    maxScore += 1;
  } else {
    const pad = (maxScore - minScore) * 0.1;
    minScore -= pad;
    maxScore += pad;
  }

  const svgW = 640;
  const svgH = 220;
  const padL = 60;
  const padR = 25;
  const padT = 20;
  const padB = 35;
  const W = svgW - padL - padR;
  const H = svgH - padT - padB;

  const toX = (it) => padL + ((it - minIter) / (maxIter - minIter)) * W;
  const toY = (sc) => padT + H - ((sc - minScore) / (maxScore - minScore)) * H;

  // Grid & Y labels
  const yTicksCount = 4;
  let gridSvg = '';
  for (let i = 0; i <= yTicksCount; i++) {
    const val = minScore + (i / yTicksCount) * (maxScore - minScore);
    const y = toY(val);
    const formatted = Math.abs(val) >= 100 ? val.toFixed(1) : Math.abs(val) >= 1 ? val.toFixed(3) : val.toFixed(5);
    gridSvg += `<line x1="${padL}" y1="${y}" x2="${padL + W}" y2="${y}" stroke="var(--border)" stroke-dasharray="3,3" />`;
    gridSvg += `<text x="${padL - 8}" y="${y + 4}" fill="var(--muted)" font-size="11" text-anchor="end">${formatted}</text>`;
  }

  // X ticks
  const maxTicks = 10;
  const iterSpan = maxIter - minIter;
  const step = Math.max(1, Math.ceil(iterSpan / maxTicks));
  for (let it = minIter; it <= maxIter; it += step) {
    const x = toX(it);
    gridSvg += `<line x1="${x}" y1="${padT + H}" x2="${x}" y2="${padT + H + 4}" stroke="var(--border)" />`;
    gridSvg += `<text x="${x}" y="${padT + H + 18}" fill="var(--muted)" font-size="11" text-anchor="middle">${it}</text>`;
  }

  // Best/keep line progression
  const keeps = valid
    .filter((r) => r.status === 'keep' || r.status === 'baseline')
    .sort((a, b) => (Number(a.iter) || 0) - (Number(b.iter) || 0) || a.t - b.t);

  let lineSvg = '';
  if (keeps.length > 1) {
    const pathD = keeps.map((k, idx) => `${idx === 0 ? 'M' : 'L'} ${toX(Number(k.iter) || 0)} ${toY(Number(k.score))}`).join(' ');
    lineSvg = `<path d="${pathD}" fill="none" stroke="var(--ok)" stroke-width="2" stroke-opacity="0.5" stroke-dasharray="4,2" />`;
  }

  // Points
  let pointsSvg = '';
  for (const r of valid) {
    const it = r.iter != null && !isNaN(Number(r.iter)) ? Number(r.iter) : 0;
    const sc = Number(r.score);
    const cx = toX(it);
    const cy = toY(sc);
    const color = r.status === 'keep' ? 'var(--ok)' : r.status === 'discard' ? 'var(--bad)' : 'var(--info)';
    const tip = `Vòng ${it}: ${sc} (${r.status}) · ${r.agent}${r.desc ? ` · ${r.desc}` : ''}`;
    pointsSvg += `<circle cx="${cx}" cy="${cy}" r="5" fill="${color}" stroke="var(--panel)" stroke-width="1.5" style="cursor:pointer">
      <title>${esc(tip)}</title>
    </circle>`;
  }

  container.innerHTML = `
    <div style="display:flex;gap:16px;font-size:12px;margin-bottom:10px;align-items:center;">
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--ok);margin-right:5px;vertical-align:middle;"></span>Điểm giữ (keep)</span>
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--bad);margin-right:5px;vertical-align:middle;"></span>Điểm loại (discard)</span>
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--info);margin-right:5px;vertical-align:middle;"></span>Khác</span>
    </div>
    <div style="width:100%;overflow-x:auto;">
      <svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%;max-width:800px;height:auto;display:block;font-family:sans-serif;">
        <!-- Axes -->
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + H}" stroke="var(--border)" stroke-width="1.5" />
        <line x1="${padL}" y1="${padT + H}" x2="${padL + W}" y2="${padT + H}" stroke="var(--border)" stroke-width="1.5" />
        <text x="${padL}" y="${padT - 6}" fill="var(--muted)" font-size="11">Điểm (score)</text>
        <text x="${padL + W}" y="${padT + H + 30}" fill="var(--muted)" font-size="11" text-anchor="end">Vòng (iter)</text>
        ${gridSvg}
        ${lineSvg}
        ${pointsSvg}
      </svg>
    </div>
  `;
}

async function loadGitLog() {
  const s = state.snap;
  if (!s) return;
  try {
    const log = await api(`/api/runs/${s.id}/gitlog?repo=${encodeURIComponent(s.repoRoot || '')}`);
    $('gitLog').innerHTML = log.length
      ? log.map((c) => `<li><code>${esc(c.hash)}</code>${esc(c.subject)} <span class="muted">· ${esc(c.author)} · ${esc(c.when)}</span></li>`).join('')
      : '<li class="muted">Chưa có commit nào được merge.</li>';
  } catch {
    $('gitLog').innerHTML = '';
  }
}

async function runAction(act) {
  const s = state.snap;
  if (!s) return;
  try {
    if (act === 'now') {
      if (!confirm('Dừng ngay: kill tất cả agent đang chạy, bỏ các thay đổi chưa đánh giá. Tiếp tục?')) return;
      await api(`/api/runs/${s.id}/stop`, { method: 'POST', body: { mode: 'now' } });
    } else if (act === 'graceful') {
      await api(`/api/runs/${s.id}/stop`, { method: 'POST', body: { mode: 'graceful' } });
    } else if (act === 'merge') {
      await api(`/api/runs/${s.id}/merge`, { method: 'POST', body: {} });
      alert(`Đã merge ${s.central} vào ${s.originalBranch}.`);
    }
  } catch (e) {
    alert(e.message);
  }
}

// ---------------------------------------------------------------------------
// log viewer
// ---------------------------------------------------------------------------

let logTimer = null;
async function openLog(file, title) {
  const s = state.snap;
  if (!s || !file) return;
  state.log = { file, title, id: s.id, repo: s.repoRoot };
  $('logTitle').textContent = `${title} — ${file}`;
  $('logBody').textContent = 'Đang tải...';
  if (!$('logDlg').open) $('logDlg').showModal();
  await refreshLog(true);
  clearInterval(logTimer);
  logTimer = setInterval(() => refreshLog(false), 2000);
}

async function refreshLog(scroll) {
  const l = state.log;
  if (!l) return;
  const body = $('logBody');
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  try {
    const txt = await api(`/api/runs/${l.id}/log?repo=${encodeURIComponent(l.repo || '')}&file=${encodeURIComponent(l.file)}`);
    if (body.textContent !== txt) {
      body.textContent = txt;
      if (scroll || atBottom) body.scrollTop = body.scrollHeight;
    }
    $('logLive').textContent = state.live.has(l.id) && state.snap && state.snap.status !== 'stopped' ? 'tự cập nhật' : '';
  } catch (e) {
    body.textContent = e.message;
  }
}

function closeLog() {
  clearInterval(logTimer);
  state.log = null;
  $('logDlg').close();
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function openSettings() {
  const builtins = state.catalog.filter((a) => a.builtin);
  $('setRows').innerHTML = builtins
    .map((a) => `<div class="set-row"><label>${esc(a.name)} ${a.found ? '<span class="badge b-ok">có</span>' : ''}</label><input data-id="${esc(a.id)}" value="${esc(a.template)}"></div>`)
    .join('');
  $('customRows').innerHTML = '';
  state.catalog.filter((a) => !a.builtin).forEach((a) => addCustomRow(a.name, a.template));
  $('setDlg').showModal();
}

function addCustomRow(name = '', template = '') {
  const div = document.createElement('div');
  div.className = 'cust-row';
  div.innerHTML = `<input class="c-name" placeholder="Tên" value="${esc(name)}"><input class="c-tpl" placeholder="mycli --auto {prompt}" value="${esc(template)}"><button type="button" class="ghost">✕</button>`;
  div.querySelector('button').addEventListener('click', () => div.remove());
  $('customRows').appendChild(div);
}

async function saveSettings() {
  const agents = {};
  $('setRows').querySelectorAll('input[data-id]').forEach((i) => (agents[i.dataset.id] = { template: i.value }));
  const custom = [...$('customRows').querySelectorAll('.cust-row')]
    .map((r) => ({ name: r.querySelector('.c-name').value.trim(), template: r.querySelector('.c-tpl').value.trim() }))
    .filter((c) => c.name && c.template);
  try {
    const data = await api('/api/config/agents', { method: 'POST', body: { agents, custom } });
    state.catalog = data.agents;
    renderAgentRows();
    $('setDlg').close();
  } catch (e) {
    alert(e.message);
  }
}

// ---------------------------------------------------------------------------
// coordinator chat
// ---------------------------------------------------------------------------

const ROLE = { user: 'Bạn', agent: 'Điều phối', system: 'Hệ thống' };

function showChat() {
  state.view = null;
  state.snap = null;
  $('viewRun').hidden = true;
  $('viewNew').hidden = true;
  $('viewChat').hidden = false;
  renderRunList();
  scrollChat();
}

function scrollChat() {
  const el = $('chatLog');
  el.scrollTop = el.scrollHeight;
}

function msgHtml(m) {
  const cls = m.role + (m.level === 'error' ? ' error' : '');
  const acts = (m.actions || [])
    .filter((a) => !a.info || !a.ok)
    .map((a) => `<div class="act">${a.ok ? '✓' : '✗'} ${esc(a.text)}${a.runId ? ` · <a data-run="${esc(a.runId)}">xem phiên</a>` : ''}</div>`)
    .join('');
  return `<div class="msg ${cls}"><div class="meta">${esc(ROLE[m.role] || m.role)} · ${time(m.t)}</div>${esc(m.text)}${acts}</div>`;
}

function addMsg(m) {
  const el = $('chatLog');
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.insertAdjacentHTML('beforeend', msgHtml(m));
  el.lastElementChild.querySelectorAll('a[data-run]').forEach((a) => a.addEventListener('click', () => showRun(a.dataset.run, '')));
  if (stick) scrollChat();
}

async function loadChat() {
  const data = await api('/api/chat');
  $('chatLog').innerHTML = data.messages.length ? '' : '<p class="muted">Chưa có tin nhắn. Hãy mô tả việc bạn muốn các agent làm.</p>';
  data.messages.forEach(addMsg);
  $('chatBusy').hidden = !data.busy;
  scrollChat();
}

async function sendChat(ev) {
  ev.preventDefault();
  const message = $('chatText').value.trim();
  if (!message) return;
  try {
    if (!$('chatLog').querySelector('.msg')) $('chatLog').innerHTML = '';
    await api('/api/chat', { method: 'POST', body: { message } });
    $('chatText').value = '';
  } catch (e) {
    alert(e.message);
  }
}

function renderCoordSelect(current) {
  const found = state.catalog.filter((a) => a.found);
  $('coordCli').innerHTML = `<option value="">Điều phối: tự chọn</option>` + found.map((a) => `<option value="${esc(a.id)}">Điều phối: ${esc(a.name)}</option>`).join('');
  $('coordCli').value = (current && current.cli) || '';
}

// ---------------------------------------------------------------------------
// live updates
// ---------------------------------------------------------------------------

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('run', (ev) => {
    const snap = JSON.parse(ev.data);
    const prev = state.live.get(snap.id);
    state.live.set(snap.id, snap);
    if (!prev || prev.status !== snap.status) refreshRuns();
    if (state.view && state.view.id === snap.id) {
      state.snap = snap;
      renderRun();
    }
  });
  es.addEventListener('chat', (ev) => addMsg(JSON.parse(ev.data)));
  es.addEventListener('chatbusy', (ev) => ($('chatBusy').hidden = !JSON.parse(ev.data).busy));
  es.addEventListener('chatclear', () => loadChat());
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function init() {
  restoreForm();
  updateEvalVisibility();
  $('preset').addEventListener('change', () => applyPreset($('preset').value));
  document.querySelectorAll('input[name=evalMode]').forEach((r) => r.addEventListener('change', () => (updateEvalVisibility(), saveForm())));
  $('newForm').addEventListener('input', saveForm);
  $('newForm').addEventListener('submit', startRun);
  $('btnInspect').addEventListener('click', inspectWorkspace);
  $('workspace').addEventListener('change', inspectWorkspace);
  $('navNew').addEventListener('click', showNew);
  $('navChat').addEventListener('click', showChat);
  $('chatForm').addEventListener('submit', sendChat);
  $('chatText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) sendChat(e);
  });
  $('chatClear').addEventListener('click', () => confirm('Xoá toàn bộ hội thoại?') && api('/api/chat/clear', { method: 'POST' }));
  $('coordCli').addEventListener('change', () => api('/api/config/coordinator', { method: 'POST', body: { cli: $('coordCli').value } }).catch((e) => alert(e.message)));
  showChat();
  loadChat().catch(() => {});
  $('navSettings').addEventListener('click', openSettings);
  $('addCustom').addEventListener('click', () => addCustomRow());
  $('setSave').addEventListener('click', saveSettings);
  $('setClose').addEventListener('click', () => $('setDlg').close());
  $('logClose').addEventListener('click', closeLog);
  $('logDlg').addEventListener('close', () => {
    clearInterval(logTimer);
    state.log = null;
  });
  loadCatalog().catch((e) => ($('agentRows').innerHTML = `<tr><td colspan="3" class="error">${esc(e.message)}</td></tr>`));
  refreshRuns();
  connectEvents();
  setInterval(() => {
    if (state.snap && state.snap.agents.some((a) => a.status === 'working')) renderAgents();
  }, 1000);
  setInterval(refreshRuns, 15000);
  if ($('workspace').value) inspectWorkspace();
}

init();
