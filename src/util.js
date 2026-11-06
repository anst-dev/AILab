'use strict';

const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serialises async functions: run(fn) waits until every earlier fn has settled. */
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }
  run(fn) {
    const result = this._tail.then(() => fn());
    this._tail = result.catch(() => {});
    return result;
  }
}

/** Allows at most `n` concurrent holders. */
class Semaphore {
  constructor(n) {
    this.free = Math.max(1, n | 0);
    this.queue = [];
  }
  acquire() {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((r) => this.queue.push(r));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.free++;
  }
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

function makeTag(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Reads at most the last `maxBytes` of a file as UTF-8 (empty string if missing). */
function tailFile(file, maxBytes = 200000) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { sleep, Mutex, Semaphore, makeTag, tailFile };
