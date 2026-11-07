'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { IS_WIN } = require('./proc');

/** The short instruction handed to every CLI; the real task lives in .swarm_task.md. */
const SHORT_PROMPT =
  'Read the file .swarm_task.md in the current directory and carry out the task described there. Work autonomously and never ask questions.';

// {prompt} is replaced by the quoted SHORT_PROMPT.
const KNOWN_AGENTS = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', template: 'claude -p {prompt} --dangerously-skip-permissions' },
  { id: 'codex', name: 'OpenAI Codex CLI', bin: 'codex', template: 'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check {prompt}' },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini', template: 'gemini --yolo -p {prompt}' },
  { id: 'copilot', name: 'GitHub Copilot CLI', bin: 'copilot', template: 'copilot -p {prompt} --allow-all' },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode', template: 'opencode run --auto {prompt}' },
  { id: 'qwen', name: 'Qwen Code', bin: 'qwen', template: 'qwen --yolo -p {prompt}' },
  { id: 'cursor-agent', name: 'Cursor Agent', bin: 'cursor-agent', template: 'cursor-agent -p --force {prompt}' },
  { id: 'agy', name: 'Antigravity CLI (agy)', bin: 'agy', template: 'agy -p {prompt} --dangerously-skip-permissions' },
  { id: 'aider', name: 'Aider', bin: 'aider', template: 'aider --yes-always --no-auto-commits --no-gitignore --message {prompt}' },
  // npm i -g zcode-app-cli; login via `zcode login --oauth`. Start Plan quota (GLM-5.3-Flash) shares the ZCode Desktop session.
  { id: 'zcode', name: 'ZCode CLI (Z.ai)', bin: 'zcode', template: 'zcode --model account:zai-start-plan/GLM-5.3-Flash -p {prompt}' },
];

function findBin(bin) {
  return new Promise((resolve) => {
    if (!bin) return resolve(null);
    execFile(IS_WIN ? 'where' : 'which', [bin], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first || null);
    });
  });
}

function firstWord(cmd) {
  const s = String(cmd || '').trim();
  if (s.startsWith('"')) return s.slice(1, s.indexOf('"', 1) > 0 ? s.indexOf('"', 1) : undefined);
  return s.split(/\s+/)[0] || '';
}

/** Merges built-ins with user config and detects which binaries exist on this machine. */
async function getCatalog(config = {}) {
  const overrides = config.agents || {};
  const list = KNOWN_AGENTS.map((a) => ({ ...a, builtin: true, template: (overrides[a.id] && overrides[a.id].template) || a.template }));
  for (const c of config.custom || []) {
    if (!c || !c.id || !c.template) continue;
    if (list.some((a) => a.id === c.id)) continue;
    list.push({ id: c.id, name: c.name || c.id, bin: firstWord(c.template), template: c.template, builtin: false });
  }
  await Promise.all(
    list.map(async (a) => {
      const bin = a.builtin ? a.bin : firstWord(a.template);
      a.path = /[\\/]/.test(bin) ? (fs.existsSync(bin) ? bin : null) : await findBin(bin);
      a.found = !!a.path;
    })
  );
  return list;
}

function buildAgentCommand(template) {
  const quoted = `"${SHORT_PROMPT}"`;
  const t = String(template || '').trim();
  return t.includes('{prompt}') ? t.split('{prompt}').join(quoted) : `${t} ${quoted}`;
}

module.exports = { KNOWN_AGENTS, SHORT_PROMPT, getCatalog, buildAgentCommand };
