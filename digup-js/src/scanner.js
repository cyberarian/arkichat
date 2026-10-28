import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { kindOf } from './readers.js';

const run = promisify(execFile);
const PROJECT_MARKERS = ['.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Package.swift', 'Gemfile', 'composer.json'];
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '__pycache__', 'Library', 'AppData', '.Trash', '$RECYCLE.BIN', 'site-packages']);
const SECRET = /\.(pem|key|p12|pfx|crt|cer|kdbx|keystore|jks|ppk|gpg)$|^(id_rsa|id_ed25519|id_ecdsa|\.env.*|.*passw.*|.*secret.*|.*credential.*|\.netrc)$/i;
const APP_DIR = /\.(app|framework|bundle|xcodeproj|photoslibrary|lproj)$/i;

const exists = (p) => fsp.access(p).then(() => true, () => false);

/**
 * Yields { path, kind, scope, mtime, size }.
 * Never: hidden folders, apps, caches, keys/certs/password files, cloud-only (dataless) files, dataset-sized folders.
 * Inside a code project: screenshots only, unless code search is on for this root.
 */
export async function* scan(root, { code = false, skipDirs = [], skipExts = [] } = {}) {
  const extraDirs = new Set(skipDirs), extraExts = new Set(skipExts.map(e => e.toLowerCase()));
  async function* walk(dir, inProject) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (ents.length > 5000) return;                                   // looks like a dataset
    const names = new Set(ents.map(e => e.name));
    const project = inProject || PROJECT_MARKERS.some(m => names.has(m));

    if (code && names.has('.git') && !inProject) {                    // code: honor .gitignore through git itself
      try {
        const { stdout } = await run('git', ['-C', dir, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 1 << 28 });
        for (const rel of stdout.split('\0').filter(Boolean)) yield* one(path.join(dir, rel), true);
        return;
      } catch { /* fall through to a plain walk */ }
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || APP_DIR.test(e.name) || extraDirs.has(e.name) || extraDirs.has(p)) continue;
        yield* walk(p, project);
      } else if (e.isFile()) yield* one(p, project);
    }
  }
  async function* one(p, project) {
    const name = path.basename(p);
    if (name.startsWith('.') || SECRET.test(name) || extraExts.has(path.extname(p).toLowerCase())) return;
    let kind = kindOf(p);
    if (!kind) return;
    if (kind === 'code' && !code) kind = path.extname(p).toLowerCase() === '.md' ? 'doc' : null;
    if (kind === 'code' && path.extname(p).toLowerCase() === '.md') kind = 'doc';
    if (!kind) return;
    if (project && !code && kind !== 'image') return;                 // code projects: screenshots only
    let st; try { st = await fsp.stat(p); } catch { return; }
    if (st.size === 0 || (st.blocks === 0 && st.size > 0)) return;    // empty, or cloud-only placeholder
    yield { path: p, kind, scope: kind === 'code' ? 'code' : 'general', mtime: Math.floor(st.mtimeMs), size: st.size };
  }
  yield* walk(root, false);
}
