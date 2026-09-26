// Whether a source file another role owns exists yet (wave 2): a suite for a module that has
// not landed is skipped, not failed, so `npm test` stays green while the wave is built, and
// runs in full once the file is there. Paths are repo-relative. The repo root comes from
// vitest.config.js (`OSE_REPO`), because `import.meta.url` is not a file URL under happy-dom.

import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO = process.env.OSE_REPO || process.cwd();

/**
 * @param {...string} rels repo-relative paths
 * @returns {boolean} true when every one of them exists
 */
export function present(...rels) {
  return rels.every((rel) => existsSync(path.join(REPO, ...rel.split('/'))));
}
