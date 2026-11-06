'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const live = new Set(); // pids of children still running, killed when the app exits

function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function killAll() {
  for (const pid of live) killTree(pid);
  live.clear();
}

/**
 * Runs a shell command with stdout+stderr appended to `logFile`.
 * The whole process tree is killed on timeout or when kill() is called.
 * Returns { promise, kill(reason), pid }; the promise never rejects.
 */
function runCommand({ command, cwd, env, logFile, timeoutMs }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const started = Date.now();
  let child = null;
  let timer = null;
  let hangTimer = null;
  let killedReason = null;
  let settled = false;
  let resolveFn;
  const promise = new Promise((r) => (resolveFn = r));

  const writeLog = (text) => {
    try { fs.writeSync(fd, text); } catch {}
  };

  const finish = (code, signal, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(hangTimer);
    if (child && child.pid) live.delete(child.pid);
    if (killedReason) writeLog(`\n[swarm] process killed: ${killedReason}\n`);
    try { fs.closeSync(fd); } catch {}
    resolveFn({
      code,
      signal,
      error: error || null,
      killedReason,
      timedOut: killedReason === 'timeout',
      durationMs: Date.now() - started,
    });
  };

  const kill = (reason = 'killed') => {
    if (settled || !child) return;
    if (!killedReason) killedReason = reason;
    killTree(child.pid);
    // If the exit event never arrives (zombie / stuck handle), settle anyway.
    if (!hangTimer) hangTimer = setTimeout(() => finish(null, 'SIGKILL'), 15000);
  };

  try {
    child = spawn(command, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      shell: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      detached: !IS_WIN,
    });
  } catch (e) {
    writeLog(`\n[swarm] spawn error: ${e.message}\n`);
    finish(-1, null, e.message);
    return { promise, kill: () => {}, pid: null };
  }

  if (child.pid) live.add(child.pid);
  child.on('error', (e) => {
    writeLog(`\n[swarm] process error: ${e.message}\n`);
    finish(-1, null, e.message);
  });
  child.on('exit', (code, signal) => finish(code, signal));
  if (timeoutMs > 0) timer = setTimeout(() => kill('timeout'), timeoutMs);

  return { promise, kill, pid: child.pid };
}

module.exports = { runCommand, killTree, killAll, IS_WIN };
