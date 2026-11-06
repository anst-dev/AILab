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
  resultFilter: 'all',
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

const FIELDS = ['workspace', 'requirement', 'timeLimitMin', 'evalCommand', 'metricRegex', 'direction', 'minDelta', 'evalTimeoutMin', 'evalConcurrency', 'protectedFiles', 'maxIterations', 'maxDurationMin', 'staggerSec', 'extraInstructions', 'publishCommand', 'envExtra'];
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
  if (live && (s.status === 'running' || s.status === 'preparing') && s.opts && s.opts.evalMode !== 'none') {
    acts.push('<button class="secondary" data-act="rebaseline" title="Chấm lại baseline với rubric/command hiện tại">Đo lại baseline</button>');
  }
  if (s.opts && s.opts.publishCommand) {
    acts.push('<button class="secondary" data-act="publish-log" title="Xem log thực thi publishCommand">Log publish</button>');
  }
  if (!live || s.status === 'stopped') {
    acts.push('<button class="danger" data-act="delete-run" title="Xóa dữ liệu phiên này và nhánh git swarm">Xóa phiên</button>');
  }
  const repoParam = state.view && state.view.repo ? `?repo=${encodeURIComponent(state.view.repo)}` : '';
  acts.push(`<a class="button secondary" href="/api/runs/${esc(s.id)}/export.csv${repoParam}" download="results-${esc(s.id)}.csv" title="Tải kết quả phiên dưới dạng file CSV">Xuất CSV</a>`);
  acts.push(`<a class="button secondary" href="/api/runs/${esc(s.id)}/export.json${repoParam}" download="run-${esc(s.id)}.json" title="Tải toàn bộ trạng thái phiên dưới dạng file JSON">Xuất JSON</a>`);
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
    tiles.push(['Best ' + (s.opts.direction === 'min' ? '(thấp là tốt)' : '(cao là tốt)'), s.best ? s.best.score : '—', s.best ? `${s.best.desc}${delta !== null ? ` · Δ ${delta > 0 ? '+' : ''}${+delta.toFixed(6)}` : ''}` : 'chưa có', 'keep']);
  }
  tiles.push(['Được giữ', cnt('keep'), 'đã merge vào nhánh trung tâm', 'keep']);
  tiles.push(['Bị loại / không đổi', cnt('discard') + cnt('no-change') + cnt('duplicate'), '', 'discard']);
  tiles.push(['Xung đột', cnt('conflict'), 'thay đổi đè lên nhau', 'conflict']);
  tiles.push(['Lỗi', cnt('crash') + cnt('error'), '', 'crash']);
  tiles.push(['Thời gian', dur(end - s.startedAt), `${rows.length} lượt`, 'all']);

  const curFilter = state.resultFilter || 'all';
  $('tiles').innerHTML = tiles.map(([k, v, d, fk]) => `<div class="tile clickable${curFilter === fk && fk !== 'all' ? ' active' : ''}" data-filter="${fk}" title="Nhấn để lọc theo ${esc(k)}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="d" title="${esc(d)}">${esc(d)}</div></div>`).join('');
  $('tiles').querySelectorAll('.tile[data-filter]').forEach((el) => {
    el.addEventListener('click', () => {
      const f = el.dataset.filter;
      state.resultFilter = state.resultFilter === f && f !== 'all' ? 'all' : f;
      renderRun();
    });
  });

  renderScoreChart();
  renderAgents();

  if ($('resultFilter')) $('resultFilter').value = curFilter;

  const filtered = s.results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => {
      if (curFilter === 'all') return true;
      if (curFilter === 'keep') return r.status === 'keep' || r.status === 'keep-merged';
      if (curFilter === 'discard') return r.status === 'discard' || r.status === 'no-change' || r.status === 'duplicate';
      if (curFilter === 'conflict') return r.status === 'conflict';
      if (curFilter === 'crash') return r.status === 'crash' || r.status === 'error';
      return r.status === curFilter;
    });

  $('resultRows').innerHTML =
    filtered
      .slice()
      .reverse()
      .map(
        ({ r, i }) => `<tr class="${r.log ? 'clickable' : ''}" data-i="${i}">
          <td class="mono">${time(r.t)}</td><td>${esc(r.agent)}</td><td>${r.iter || ''}</td>
          <td>${badge(RESULT_STATUS, r.status)}</td><td class="mono">${r.score == null ? '' : esc(r.score)}</td>
          <td class="mono">${esc(r.commit)}</td><td>${esc(r.desc)}</td></tr>`
      )
      .join('') || `<tr><td colspan="7" class="muted">${curFilter === 'all' ? 'Chưa có lượt nào hoàn thành.' : 'Không có lượt nào khớp bộ lọc.'}</td></tr>`;
  $('resultRows').querySelectorAll('tr[data-i]').forEach((tr) => {
    tr.addEventListener('mouseenter', () => {
      const origIdx = Number(tr.dataset.i);
      const svg = $('scoreChart');
      if (svg) {
        const c = svg.querySelector(`circle[data-orig-idx="${origIdx}"]`);
        if (c && !c.classList.contains('active')) c.classList.add('hovered');
      }
    });
    tr.addEventListener('mouseleave', () => {
      const origIdx = Number(tr.dataset.i);
      const svg = $('scoreChart');
      if (svg) {
        const c = svg.querySelector(`circle[data-orig-idx="${origIdx}"]`);
        if (c) c.classList.remove('hovered');
      }
    });
    tr.addEventListener('click', () => {
      const origIdx = Number(tr.dataset.i);
      const r = s.results[origIdx];
      if (!r) return;
      document.querySelectorAll('#resultRows tr.highlight-row').forEach((row) => row.classList.remove('highlight-row'));
      tr.classList.add('highlight-row');
      const svg = $('scoreChart');
      if (svg) {
        svg.querySelectorAll('circle.active').forEach((c) => c.classList.remove('active'));
        const circle = svg.querySelector(`circle[data-orig-idx="${origIdx}"]`);
        if (circle) circle.classList.add('active');
      }
      const detail = $('chartDetail');
      if (detail && r.score != null) {
        detail.dataset.pinned = 'true';
        const basePt = (s.results || []).find((b) => b.status === 'baseline');
        const deltaStr = basePt && basePt.score != null && r.status !== 'baseline'
          ? ` · Δ ${r.score - basePt.score > 0 ? '+' : ''}${+(r.score - basePt.score).toFixed(4)}`
          : '';
        const commitStr = r.commit ? ` · commit ${r.commit.slice(0, 7)}` : '';
        const descStr = r.desc ? ` · ${r.desc}` : '';
        detail.textContent = `Lượt #${r.iter || 0} · ${r.agent || '—'} · điểm: ${r.score}${deltaStr} (${r.status})${commitStr}${descStr}`;
      }
      if (r.log) openLog(r.log, `${r.agent} lượt ${r.iter}`);
    });
  });

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

// ---------------------------------------------------------------------------
// score chart
// ---------------------------------------------------------------------------

const CHART_COLORS = {
  keep: '#35e6a3',
  'keep-merged': '#35e6a3',
  discard: '#ff5f56',
  'no-change': '#ff7875',
  duplicate: '#ff7875',
  conflict: '#f5a623',
  crash: '#ff4d4f',
  error: '#ff4d4f',
  baseline: '#60a5fa',
};
const fmtScore = (v) => (Math.abs(v) >= 1000 ? String(Math.round(v)) : String(+Number(v).toFixed(4)));

function renderScoreChart() {
  const card = $('chartCard');
  const svg = $('scoreChart');
  const empty = $('chartEmpty');
  const detail = $('chartDetail');
  const bestBadge = $('chartBestScore');
  const statsBadge = $('chartStats');
  const legend = $('chartLegend');
  const s = state.snap;
  if (!svg || !s) return;
  if (card) {
    card.hidden = s.opts && s.opts.evalMode !== 'score';
    if (card.hidden) return;
  }
  const curFilter = state.resultFilter || 'all';
  if (legend) {
    legend.querySelectorAll('.legend-item').forEach((item) => {
      const fk = item.dataset.filter;
      item.classList.toggle('active', curFilter === fk && fk !== 'all');
    });
  }
  const pts = (s.results || []).filter((r) => r.score != null && r.score !== '' && Number.isFinite(Number(r.score)));
  if (!pts.length) {
    svg.innerHTML = '';
    if (empty) empty.hidden = false;
    if (detail) detail.textContent = '';
    if (bestBadge) bestBadge.textContent = '';
    if (statsBadge) statsBadge.textContent = '';
    return;
  }
  if (empty) empty.hidden = true;
  const W = svg.clientWidth || 600;
  const H = 130;
  const padL = 48, padR = 12, padT = 12, padB = 18;
  const innerW = Math.max(10, W - padL - padR);
  const innerH = H - padT - padB;
  const maxIter = Math.max(1, ...pts.map((p) => Number(p.iter) || 0));
  let lo = Math.min(...pts.map((p) => Number(p.score)));
  let hi = Math.max(...pts.map((p) => Number(p.score)));
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  } else {
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
  }
  const x = (it) => padL + (maxIter ? ((Number(it) || 0) / maxIter) * innerW : 0);
  const y = (v) => padT + innerH - ((Number(v) - lo) / (hi - lo)) * innerH;

  const parts = [];
  for (const v of [hi, (hi + lo) / 2, lo]) {
    parts.push(`<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" class="cg"/>`);
    parts.push(`<text x="${padL - 6}" y="${(y(v) + 3).toFixed(1)}" class="ct" text-anchor="end">${fmtScore(v)}</text>`);
  }
  const step = Math.max(1, Math.ceil(maxIter / Math.max(1, Math.floor(innerW / 36))));
  for (let it = 0; it <= maxIter; it += step) {
    parts.push(`<text x="${x(it).toFixed(1)}" y="${H - 2}" class="ct" text-anchor="middle">${it}</text>`);
  }

  // Baseline reference horizontal line
  const basePt = pts.find((r) => r.status === 'baseline');
  if (basePt && basePt.score != null) {
    const bY = y(basePt.score).toFixed(1);
    parts.push(`<line x1="${padL}" y1="${bY}" x2="${W - padR}" y2="${bY}" stroke="#60a5fa" stroke-width="1.2" stroke-dasharray="3,3" stroke-opacity="0.8"/>`);
    parts.push(`<text x="${W - padR}" y="${(Number(bY) - 3).toFixed(1)}" class="ct" text-anchor="end" fill="#60a5fa">baseline: ${fmtScore(basePt.score)}</text>`);
  }

  // Average score reference horizontal line
  const avgScore = pts.reduce((sum, p) => sum + Number(p.score), 0) / pts.length;
  if (pts.length >= 2) {
    const aY = y(avgScore).toFixed(1);
    parts.push(`<line x1="${padL}" y1="${aY}" x2="${W - padR}" y2="${aY}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2,3" stroke-opacity="0.6"/>`);
    parts.push(`<text x="${padL + 4}" y="${(Number(aY) - 3).toFixed(1)}" class="ct" text-anchor="start" fill="#94a3b8">TB: ${fmtScore(avgScore)}</text>`);
  }

  // Best badge display in card header
  if (bestBadge) {
    if (s.best && s.best.score != null) {
      const delta = basePt && basePt.score != null ? s.best.score - basePt.score : null;
      const deltaStr = delta !== null ? ` (Δ ${delta > 0 ? '+' : ''}${+delta.toFixed(4)})` : '';
      bestBadge.textContent = `· tốt nhất: ${fmtScore(s.best.score)}${deltaStr}`;
    } else {
      bestBadge.textContent = '';
    }
  }

  // Stats badge display
  if (statsBadge) {
    statsBadge.textContent = `· TB: ${fmtScore(avgScore)} (${pts.length} điểm)`;
  }

  // Best/keep line progression
  const keeps = pts
    .filter((r) => r.status === 'keep' || r.status === 'baseline')
    .sort((a, b) => (Number(a.iter) || 0) - (Number(b.iter) || 0) || a.t - b.t);
  if (keeps.length > 1) {
    const pathD = keeps.map((k, idx) => `${idx === 0 ? 'M' : 'L'} ${x(k.iter || 0).toFixed(1)} ${y(k.score).toFixed(1)}`).join(' ');
    parts.push(`<path d="${pathD}" fill="none" stroke="var(--ok)" stroke-width="2" stroke-opacity="0.6" stroke-dasharray="4,2"/>`);
  }

  // Draw discard points first, keep/baseline points on top so they stay visible
  const sortedPts = pts.slice().sort((a, b) => {
    const isKeepA = a.status === 'keep' || a.status === 'keep-merged' || a.status === 'baseline' ? 1 : 0;
    const isKeepB = b.status === 'keep' || b.status === 'keep-merged' || b.status === 'baseline' ? 1 : 0;
    return isKeepA - isKeepB;
  });

  const formatDetail = (p) => {
    if (!p) return '';
    const who = p.agent || '—';
    const deltaStr = basePt && basePt.score != null && p.status !== 'baseline'
      ? ` · Δ ${p.score - basePt.score > 0 ? '+' : ''}${+(p.score - basePt.score).toFixed(4)}`
      : '';
    const commitStr = p.commit ? ` · commit ${p.commit.slice(0, 7)}` : '';
    const descStr = p.desc ? ` · ${p.desc}` : '';
    return `Lượt #${p.iter || 0} · ${who} · điểm: ${p.score}${deltaStr} (${p.status})${commitStr}${descStr}`;
  };

  if (detail && !detail.dataset.pinned) {
    const lastPt = sortedPts[sortedPts.length - 1];
    detail.textContent = lastPt ? formatDetail(lastPt) : '';
  }

  const bestScoreVal = s.best && s.best.score != null ? Number(s.best.score) : null;

  for (let i = 0; i < sortedPts.length; i++) {
    const p = sortedPts[i];
    const origIdx = (s.results || []).indexOf(p);
    const color = CHART_COLORS[p.status] || '#ff5f56';
    const cx = x(p.iter || 0).toFixed(1);
    const cy = y(p.score).toFixed(1);
    const tip = formatDetail(p) + (p.log ? ' (click để xem log)' : '');
    let isMatch = true;
    if (curFilter === 'keep') isMatch = (p.status === 'keep' || p.status === 'keep-merged');
    else if (curFilter === 'discard') isMatch = (p.status === 'discard' || p.status === 'no-change' || p.status === 'duplicate');
    else if (curFilter === 'conflict') isMatch = (p.status === 'conflict');
    else if (curFilter === 'crash') isMatch = (p.status === 'crash' || p.status === 'error');
    else if (curFilter !== 'all') isMatch = (p.status === curFilter);
    const dimmedCls = isMatch ? '' : ' dimmed';
    const isBest = bestScoreVal !== null && (p.status === 'keep' || p.status === 'baseline') && Number(p.score) === bestScoreVal;
    if (isBest) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="7" class="best-ring"><title>Điểm tốt nhất: ${fmtScore(p.score)}</title></circle>`);
    }
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="4" fill="${color}" class="cp${dimmedCls}" data-pt-idx="${i}" data-orig-idx="${origIdx}" tabindex="0" role="button" aria-label="${esc(tip)}">` +
        `<title>${esc(tip)}</title>` +
      `</circle>`
    );
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join('');

  svg.onclick = (e) => {
    if (e.target.tagName.toLowerCase() !== 'circle') {
      svg.querySelectorAll('circle.active').forEach((c) => c.classList.remove('active'));
      document.querySelectorAll('#resultRows tr.highlight-row').forEach((row) => row.classList.remove('highlight-row'));
      if (detail) {
        detail.dataset.pinned = '';
        const lastPt = sortedPts[sortedPts.length - 1];
        detail.textContent = lastPt ? formatDetail(lastPt) : '';
      }
    }
  };

  svg.querySelectorAll('circle[data-pt-idx]').forEach((el) => {
    const idx = Number(el.dataset.ptIdx);
    const p = sortedPts[idx];
    const selectPoint = () => {
      svg.querySelectorAll('circle.active').forEach((c) => c.classList.remove('active'));
      el.classList.add('active');
      if (detail) {
        detail.textContent = formatDetail(p);
        detail.dataset.pinned = 'true';
      }
      const origIdx = (s.results || []).indexOf(p);
      if (origIdx >= 0) {
        const tr = document.querySelector(`#resultRows tr[data-i="${origIdx}"]`);
        if (tr) {
          document.querySelectorAll('#resultRows tr.highlight-row').forEach((row) => row.classList.remove('highlight-row'));
          tr.classList.add('highlight-row');
          tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
      if (p && p.log) openLog(p.log, `${p.agent || 'baseline'} lượt ${p.iter || 0}`);
    };
    el.addEventListener('mouseenter', () => {
      if (detail && !detail.dataset.pinned) detail.textContent = formatDetail(p);
    });
    el.addEventListener('mouseleave', () => {
      if (detail && !detail.dataset.pinned) {
        const lastPt = sortedPts[sortedPts.length - 1];
        detail.textContent = lastPt ? formatDetail(lastPt) : '';
      }
    });
    el.addEventListener('focus', () => {
      if (detail && !detail.dataset.pinned) detail.textContent = formatDetail(p);
    });
    el.addEventListener('blur', () => {
      if (detail && !detail.dataset.pinned) {
        const lastPt = sortedPts[sortedPts.length - 1];
        detail.textContent = lastPt ? formatDetail(lastPt) : '';
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectPoint();
      }
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectPoint();
    });
  });
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
      const logHint = a.lastLog ? (working ? ' (click xem live log)' : ' (click xem log)') : '';
      return `<div class="agent${a.lastLog ? ' clickable' : ''}" data-i="${i}" title="${a.lastLog ? esc((working ? 'Xem log đang chạy' : 'Xem log lượt ' + a.iter) + ': ' + a.lastLog) : ''}">
        <div class="h"><span class="n">${esc(a.name)}</span>${badge(AGENT_STATUS, a.status)}</div>
        <div class="c">${esc(a.cliName)} · lượt ${a.iter}${logHint}</div>
        <div class="note" title="${esc(a.note)}">${a.note ? esc(a.note) : '<span class="muted">—</span>'}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="f"><span>✔ ${a.kept} · ✖ ${a.discarded} · ⚠ ${a.crashed}</span><span>${working ? `còn ${dur(left)}` : ''}</span></div>
      </div>`;
    })
    .join('');
  $('agentsGrid').querySelectorAll('.agent.clickable').forEach((el) =>
    el.addEventListener('click', () => {
      const a = s.agents[Number(el.dataset.i)];
      if (a && a.lastLog) openLog(a.lastLog, `${a.name} (${a.cliName}) lượt ${a.iter}`);
    })
  );
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
    } else if (act === 'rebaseline') {
      if (!confirm('Chấm lại baseline hiện tại? Điểm baseline có thể thay đổi.')) return;
      const btn = $('runActions').querySelector('button[data-act="rebaseline"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Đang đo baseline...'; }
      try {
        const res = await api(`/api/runs/${s.id}/rebaseline`, { method: 'POST', body: {} });
        alert(`Đã hoàn tất đo lại baseline: ${res && res.best && res.best.score != null ? res.best.score : 'OK'}`);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Đo lại baseline'; }
      }
    } else if (act === 'publish-log') {
      openLog('publish.log', `Publish log (${s.id})`);
    } else if (act === 'delete-run') {
      if (!confirm(`Xóa vĩnh viễn dữ liệu phiên ${s.id} và nhánh swarm tương ứng? Thao tác này không thể hoàn tác.`)) return;
      const repoParam = state.view && state.view.repo ? `?repo=${encodeURIComponent(state.view.repo)}` : '';
      await api(`/api/runs/${s.id}${repoParam}`, { method: 'DELETE' });
      alert(`Đã xóa phiên ${s.id}.`);
      showNew();
      await refreshRuns();
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
// knowledge viewer
// ---------------------------------------------------------------------------

let knowledgeData = [];

async function loadKnowledge() {
  const meta = $('knowledgeMeta');
  const rows = $('knowledgeRows');
  const statsEl = $('knowledgeStats');
  if (meta) meta.textContent = ' (đang tải...)';
  if (rows) rows.innerHTML = '<tr><td colspan="6" class="muted">Đang tải dữ liệu tri thức...</td></tr>';
  if (statsEl) statsEl.style.display = 'none';
  try {
    const res = await api('/api/harvest?limit=150');
    knowledgeData = Array.isArray(res.items) ? res.items : [];
    if (meta) {
      meta.textContent = res.exists
        ? ` (${knowledgeData.length}/${res.totalCount} dòng gần nhất)`
        : ' (chưa có file)';
    }
    if (statsEl && res.stats && res.stats.total) {
      const s = res.stats;
      statsEl.innerHTML = `<b>Thống kê:</b> ${s.total} dòng · <span style="color:var(--accent,#4caf50)">Tỷ lệ keep: ${s.keepRate}%</span> (${s.keepCount} giữ, ${s.discardCount} loại, ${s.conflictCount} xung đột, ${s.errorCount} lỗi)`;
      statsEl.style.display = 'block';
    }
    renderKnowledge();
  } catch (e) {
    if (meta) meta.textContent = ' (lỗi)';
    if (rows) rows.innerHTML = `<tr><td colspan="6" class="error">${esc(e.message)}</td></tr>`;
  }
}

function renderKnowledge() {
  const q = ($('knowledgeSearch') ? $('knowledgeSearch').value : '').toLowerCase().trim();
  const filter = ($('knowledgeFilter') ? $('knowledgeFilter').value : 'all');
  const rows = $('knowledgeRows');
  if (!rows) return;
  const filtered = knowledgeData.filter((r) => {
    if (filter === 'keep') {
      if (r.status !== 'keep' && r.status !== 'keep-merged') return false;
    } else if (filter === 'committed') {
      if (r.status !== 'committed') return false;
    } else if (filter === 'discard') {
      if (r.status === 'keep' || r.status === 'keep-merged' || r.status === 'committed') return false;
    }
    if (!q) return true;
    const txt = [r.ts, r.bot, r.agent, r.commit, r.score, r.status, r.feature, r.desc, r.note, r.raw]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return txt.includes(q);
  });

  if (!filtered.length) {
    rows.innerHTML = `<tr><td colspan="6" class="muted">${knowledgeData.length === 0 ? 'Chưa có dữ liệu tri thức nào. Hãy bấm "Gom log mới" để quét.' : 'Không có dòng nào khớp với từ khoá hoặc bộ lọc.'}</td></tr>`;
    return;
  }

  rows.innerHTML = filtered
    .slice()
    .reverse()
    .map((r) => {
      const t = r.ts ? (time(r.ts) || r.ts.slice(0, 19).replace('T', ' ')) : '—';
      const bot = r.bot || r.agent || '—';
      const c = r.commit ? esc(String(r.commit).slice(0, 7)) : '—';
      const score = r.score != null ? esc(String(r.score)) : '—';
      const st = r.status || '';
      const b = RESULT_STATUS[st] ? badge(RESULT_STATUS, st) : `<span class="badge b-mute">${esc(st || '—')}</span>`;
      const desc = esc([r.feature, r.note].filter(Boolean).join(' — ') || r.desc || r.raw || '—');
      return `<tr>
        <td class="mono">${t}</td>
        <td>${esc(bot)}</td>
        <td class="mono">${c}</td>
        <td class="mono">${score}</td>
        <td>${b}</td>
        <td>${desc}</td>
      </tr>`;
    })
    .join('');
}

function openKnowledge() {
  const dlg = $('knowledgeDlg');
  if (!dlg) return;
  if (!dlg.open) dlg.showModal();
  loadKnowledge();
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
  const resFilter = $('resultFilter');
  if (resFilter) {
    resFilter.addEventListener('change', () => {
      state.resultFilter = resFilter.value;
      if (state.snap) renderRun();
    });
  }
  const chartLegend = $('chartLegend');
  if (chartLegend) {
    chartLegend.querySelectorAll('.legend-item').forEach((item) => {
      const toggleFilter = () => {
        const f = item.dataset.filter;
        state.resultFilter = state.resultFilter === f && f !== 'all' ? 'all' : f;
        if (state.snap) renderRun();
      };
      item.addEventListener('click', toggleFilter);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleFilter();
        }
      });
    });
  }
  const btnHarvest = $('btnHarvest');
  const btnHarvestView = $('btnHarvestView');
  const btnHarvestDownload = $('btnHarvestDownload');
  if (btnHarvest) {
    const refreshHarvestBadge = async () => {
      try {
        const info = await api('/api/harvest?limit=1');
        if (info && info.ok) {
          const count = info.totalCount || 0;
          btnHarvest.title = `Gom kết quả các phiên vào knowledge/improvements_log.jsonl (hiện có ${count} dòng)`;
          if (count > 0) {
            btnHarvest.textContent = `Gom log (${count})`;
            if (btnHarvestDownload) btnHarvestDownload.style.display = 'inline-flex';
            if (btnHarvestView) btnHarvestView.style.display = 'inline-flex';
          } else {
            btnHarvest.textContent = 'Gom log';
            if (btnHarvestDownload) btnHarvestDownload.style.display = 'none';
            if (btnHarvestView) btnHarvestView.style.display = 'none';
          }
        }
      } catch {}
    };
    refreshHarvestBadge();
    btnHarvest.addEventListener('click', async () => {
      btnHarvest.disabled = true;
      btnHarvest.textContent = 'Đang gom...';
      try {
        const res = await api('/api/harvest', { method: 'POST', body: {} });
        alert(`Đã gom kết quả swarm thành công: +${res.freshCount || 0} dòng mới (tổng ${res.totalCount || 0} dòng trong ${res.outPath || 'knowledge/improvements_log.jsonl'}).`);
        await refreshHarvestBadge();
      } catch (e) {
        alert('Lỗi gom log: ' + e.message);
        btnHarvest.textContent = 'Gom log';
      } finally {
        btnHarvest.disabled = false;
      }
    });
    if (btnHarvestView) {
      btnHarvestView.addEventListener('click', async () => {
        $('logTitle').textContent = 'Knowledge: improvements_log.jsonl';
        $('logLive').textContent = '';
        $('logBody').textContent = 'Đang tải dữ liệu knowledge...';
        if (!$('logDlg').open) $('logDlg').showModal();
        clearInterval(logTimer);
        state.log = null;
        try {
          const info = await api('/api/harvest?limit=200');
          if (!info || !info.ok || !info.items || !info.items.length) {
            $('logBody').textContent = '(Chưa có dòng dữ liệu nào trong improvements_log.jsonl)';
          } else {
            $('logBody').textContent = info.items.map((it) => JSON.stringify(it, null, 2)).join('\n---\n');
            $('logBody').scrollTop = $('logBody').scrollHeight;
          }
        } catch (e) {
          $('logBody').textContent = 'Lỗi tải log: ' + e.message;
        }
      });
    }
  }
  if ($('navKnowledge')) $('navKnowledge').addEventListener('click', openKnowledge);
  if ($('knowledgeClose')) $('knowledgeClose').addEventListener('click', () => $('knowledgeDlg').close());
  if ($('knowledgeSearch')) $('knowledgeSearch').addEventListener('input', renderKnowledge);
  if ($('knowledgeFilter')) $('knowledgeFilter').addEventListener('change', renderKnowledge);
  if ($('btnHarvestDlg')) {
    $('btnHarvestDlg').addEventListener('click', async () => {
      const btn = $('btnHarvestDlg');
      btn.disabled = true;
      btn.textContent = 'Đang gom...';
      try {
        const res = await api('/api/harvest', { method: 'POST', body: {} });
        await loadKnowledge();
        alert(`Đã gom kết quả swarm thành công: +${res.freshCount || 0} dòng mới (tổng ${res.totalCount || 0} dòng).`);
      } catch (e) {
        alert('Lỗi gom log: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Gom log mới';
      }
    });
  }
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
  window.addEventListener('resize', () => { if (state.snap && !$('viewRun').hidden) renderScoreChart(); });
  if ($('workspace').value) inspectWorkspace();
}

init();
