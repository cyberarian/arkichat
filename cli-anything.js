const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PREFIX = 'cli-anything-';

function createCliAnything(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const spawnProcess = options.spawn || spawn;
  const timeout = options.timeout || 30000;
  const maxOutput = options.maxOutput || 32768;
  const cwd = options.cwd || env.HOME || env.USERPROFILE || os.homedir();
  const localBin = options.localBin || path.join(__dirname, '.arki-tools', 'venv', platform === 'win32' ? 'Scripts' : 'bin');

  function discover() {
    const found = new Map();
    const extensions = platform === 'win32'
      ? (env.PATHEXT || '.EXE').split(';').filter((extension) => extension.toLowerCase() === '.exe')
      : [''];
    for (const dir of [...String(env.PATH || '').split(path.delimiter), localBin].filter(Boolean)) {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        const lower = entry.toLowerCase();
        const ext = extensions.find((item) => lower.endsWith(item.toLowerCase()));
        if (ext === undefined) continue;
        const stem = ext ? entry.slice(0, -ext.length) : entry;
        if (!stem.toLowerCase().startsWith(PREFIX)) continue;
        const id = stem.slice(PREFIX.length);
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) continue;
        const executable = path.join(dir, entry);
        try {
          if (!fs.statSync(executable).isFile()) continue;
          if (platform !== 'win32') fs.accessSync(executable, fs.constants.X_OK);
        } catch { continue; }
        const key = id.toLowerCase();
        if (!found.has(key)) found.set(key, { id, executable });
      }
    }
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  function run(id, args) {
    if (!Array.isArray(args) || args.length > 64 || args.some((arg) =>
      typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
      return Promise.reject(new Error('invalid argument list'));
    }
    const harness = discover().find((entry) => entry.id.toLowerCase() === String(id || '').toLowerCase());
    if (!harness) return Promise.reject(new Error('CLI-Anything harness is not installed'));

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(harness.executable, args, {
          cwd,
          env: { ...env, PATH: [localBin, env.PATH || ''].filter(Boolean).join(path.delimiter) },
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      const output = { stdout: [], stderr: [], bytes: 0, truncated: false };
      let settled = false;
      const append = (stream, chunk) => {
        const remaining = Math.max(0, maxOutput - output.bytes);
        const part = chunk.subarray(0, remaining);
        if (part.length) output[stream].push(part);
        output.bytes += part.length;
        if (part.length < chunk.length) {
          output.truncated = true;
          child.kill('SIGTERM');
        }
      };
      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
      child.once('error', (error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000).unref();
        if (!settled) { settled = true; reject(new Error('CLI-Anything command timed out')); }
      }, timeout);
      timer.unref();
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          code,
          signal,
          stdout: Buffer.concat(output.stdout).toString('utf8'),
          stderr: Buffer.concat(output.stderr).toString('utf8'),
          truncated: output.truncated,
        });
      });
    });
  }

  return { discover, run };
}

module.exports = { createCliAnything };
