'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { Mutex } = require('./util');

const BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
};

/** Runs git; rejects on non-zero exit unless allowFail. Resolves { code, stdout, stderr }. */
function git(args, cwd, { env, allowFail = false, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      {
        cwd,
        env: { ...process.env, ...BASE_ENV, ...(env || {}) },
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        timeout: timeoutMs,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        const res = { code, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
        if (code !== 0 && !allowFail) {
          const e = new Error(`git ${args.join(' ')} → ${res.stderr || res.stdout || (err && err.message)}`);
          e.result = res;
          reject(e);
        } else {
          resolve(res);
        }
      }
    );
  });
}

async function revParse(ref, cwd) {
  return (await git(['rev-parse', '--verify', `${ref}^{commit}`], cwd)).stdout;
}

/** Changed paths (tracked + untracked, respecting ignores) relative to the repo root. */
async function changedPaths(cwd) {
  const r = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  const out = [];
  const parts = r.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const xy = entry.slice(0, 2);
    out.push({ xy, file: entry.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i++; // rename source follows
  }
  return out;
}

const locks = new Map();
/** One mutex per repository so orchestrator git operations never race each other. */
function repoLock(root) {
  const key = path.resolve(root).toLowerCase();
  if (!locks.has(key)) locks.set(key, new Mutex());
  return locks.get(key);
}

module.exports = { git, revParse, changedPaths, repoLock };
