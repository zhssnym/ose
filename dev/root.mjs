// The one place that decides which vault the dev bridge serves and where `ship` copies os.exe.
// Precedence: OSE_ROOT env (OS_ROOT accepted as the older alias) -> ose.config.json at the repo
// root ({"root": "D:/os"}, gitignored, per machine) -> the parent folder of the repo, which is
// the historical behaviour when ose sits inside the vault.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function configPath() {
  return path.join(repoRoot, 'ose.config.json');
}

// Returns the configured root without falling back, or null. Malformed JSON is reported and ignored.
function fromConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = cfg && typeof cfg.root === 'string' ? cfg.root.trim() : '';
    return r ? r : null;
  } catch (e) {
    console.warn(`ose.config.json is not valid JSON (${e.message}); ignoring it.`);
    return null;
  }
}

export function vaultRoot() {
  const env = (process.env.OSE_ROOT || process.env.OS_ROOT || '').trim();
  const chosen = env || fromConfig() || path.join(repoRoot, '..');
  return path.resolve(chosen);
}

export function rootSource() {
  if ((process.env.OSE_ROOT || '').trim()) return 'OSE_ROOT';
  if ((process.env.OS_ROOT || '').trim()) return 'OS_ROOT';
  if (fromConfig()) return 'ose.config.json';
  return 'parent folder';
}
