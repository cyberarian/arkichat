import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.DIGUP_HOME || path.join(os.homedir(), '.digup');
export const DB_PATH = path.join(HOME, 'index.sqlite');
const CFG = path.join(HOME, 'config.json');

export function loadConfig() {
  fs.mkdirSync(HOME, { recursive: true });
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch { return { roots: [], skipDirs: [], skipExts: [] }; }
}
export function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
}
