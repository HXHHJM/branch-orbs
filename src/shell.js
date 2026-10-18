'use strict';
// 与壳进程的 JSONL 管道
//
// 一行一个 JSON。stdout 只解析 `{...}` 开头的行，其余（Electron 自己的警告）转日志，
// 这样即使有杂音也不会把协议弄坏。

const { spawn } = require('child_process');
const readline = require('readline');

class Shell {
  constructor(opts) {
    this.opts = opts;
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.dead = false;
    this.onEvent = opts.onEvent || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.recentLines = [];
  }

  start() {
    if (this.proc) return true;
    const { electron, args, isBundled } = this.opts.launch;
    const child = spawn(electron, args, {
      cwd: this.opts.root,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = child;
    this.dead = false;
    this.log('spawn', electron, JSON.stringify(args), 'bundled=' + isBundled);

    const out = readline.createInterface({ input: child.stdout, terminal: false });
    out.on('line', (line) => {
      if (!line) return;
      const s = line.trim();
      if (s.startsWith('{')) {
        try {
          this.onMessage(JSON.parse(s));
          return;
        } catch (e) {
          this.log('bad json from shell:', s.slice(0, 200));
          return;
        }
      }
      this.recentLines.push('out: ' + s);
      if (this.recentLines.length > 40) this.recentLines.shift();
    });

    const err = readline.createInterface({ input: child.stderr, terminal: false });
    err.on('line', (line) => {
      if (!line) return;
      this.recentLines.push('err: ' + line);
      if (this.recentLines.length > 40) this.recentLines.shift();
      this.log('shell>', line);
    });

    child.on('error', (e) => {
      this.log('spawn error', e.message);
      this.failAll('spawn error: ' + e.message);
    });
    child.on('exit', (code, sig) => {
      this.log('shell exited', code, sig);
      this.proc = null;
      this.dead = true;
      this.failAll('shell exited ' + code);
      this.onExit(code, sig);
    });
    return true;
  }

  send(msg) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return false;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
      return true;
    } catch (e) {
      this.log('write fail', e.message);
      return false;
    }
  }

  request(msg, timeoutMs) {
    const id = 'r' + ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs || 3000);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      if (!this.send({ ...msg, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  onMessage(m) {
    if (m.id && this.pending.has(m.id) && (m.type === 'diag' || m.type === 'hit-result' || m.type === 'screen-point' || m.type === 'pong')) {
      const fn = this.pending.get(m.id);
      this.pending.delete(m.id);
      fn(m);
      return;
    }
    this.onEvent(m);
  }

  failAll(reason) {
    for (const [, fn] of this.pending) fn(null);
    this.pending.clear();
    this.onEvent({ type: 'fatal', message: reason });
  }

  alive() {
    return !!this.proc && !this.proc.killed;
  }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    try {
      p.stdin.end();
    } catch (_) {}
    setTimeout(() => {
      try {
        if (!p.killed) p.kill('SIGTERM');
      } catch (_) {}
    }, 600);
    this.proc = null;
  }

  /* 强杀：主进程卡死（事件循环冻结）时 SIGTERM 可能无效，直接 SIGKILL。 */
  forceKill() {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try { p.stdin.end(); } catch (_) {}
    try { p.kill('SIGKILL'); } catch (_) {}
    setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 300);
  }

  log(...args) {
    if (this.opts.logger) this.opts.logger(args.join(' '));
  }
}

module.exports = { Shell };
