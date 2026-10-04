// The landing page (site/) is served as it is, with no build, so it carries its own copy of the
// tokens it uses. Every one of them must be the app's: same name, same value, in each theme
// and on the Mac. A token added to site/style.css that the app does not have fails too. Dark is
// a theme set on <html>, under the same selector as the app's.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = process.env.OSE_REPO;
const read = (path) => readFileSync(join(repo, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// The custom properties declared in the first block opened by `selector`, from `from` on.
function block(css, selector, from = 0) {
  const start = css.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const props = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) props[m[1]] = m[2].trim();
  return props;
}

const app = read('src/ui/styles/tokens.css');
const site = read('site/style.css');

const cases = [
  ['light', block(site, ':root'), block(app, ':root')],
  ['mac', block(site, ':root[data-os="mac"]'), block(app, ':root[data-os="mac"]')],
  ['dark', block(site, ':root[data-theme="dark"]'), block(app, ':root[data-theme="dark"]')],
];

describe('site/style.css tokens', () => {
  for (const [name, mine, theirs] of cases) {
    it(`match the app's ${name} tokens`, () => {
      expect(Object.keys(mine).length).toBeGreaterThan(0);
      for (const [prop, value] of Object.entries(mine)) {
        expect({ prop, value }).toEqual({ prop, value: theirs[prop] });
      }
    });
  }
});
