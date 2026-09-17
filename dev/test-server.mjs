// A second dev server for testing against a throwaway vault, so nobody edits the real one
// while proving a change. Serves `work/vault` (a copy of the vault's small files) on 5174.
// `npm run dev:test`, or the `ose-test` entry in .claude/launch.json. `OSE_TEST_ROOT` names
// another vault and `OSE_TEST_PORT` another port, which is how several agents run one each.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.OSE_TEST_ROOT || path.join(repo, 'work', 'vault');
const port = process.env.OSE_TEST_PORT || '5174';

const r = spawnSync('npx', ['vite', '--port', port, '--strictPort'], {
  stdio: 'inherit', shell: true, cwd: repo,
  env: { ...process.env, OSE_ROOT: root },
});
process.exit(r.status ?? 1);
