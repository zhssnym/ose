// Round-trip harness: every *.md in the vault is parsed into a ProseMirror document and
// serialised straight back, with no user edit in between, and compared to the original.
// A difference here is a difference the editor would write to a real file, so this is the
// gate the stringify config has to pass.

import { bridge } from '../bridge/index.js';
import { makeCrepe, roundTrip } from './crepe.js';
import { parseDoc, composeDoc, setFrontmatterValue } from './doc.js';

const $ = (id) => document.getElementById(id);
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '') + '\n';

// Synthetic files for constructs the vault may not contain yet (batch 9). Each runs through
// the same parse / round-trip / compose path as a real file and must come back byte for byte.
// `expect` is for the one case that is an edit, not a round-trip: the frontmatter value
// rewrite of C6, checked against the exact text it must produce.
const FIXTURES = [
  {
    path: 'fixture: strikethrough (C4)',
    raw: '# Strike\n\nDone ~~and dusted~~, about ~10 months, ~2017 or so.\n\n- ~~old item~~ replaced\n- price ~ 40 and ~~50~~\n',
  },
  {
    path: 'fixture: footnotes (C5)',
    raw: '# Notes\n\nA claim[^1] and another[^note].\n\n[^1]: The first source.\n\n[^note]: A named one, with _emphasis_.\n',
  },
  {
    path: 'fixture: callouts (C15)',
    raw: '# Callouts\n\n> [!note] Title here\n> Body of the note.\n\n> [!warning]\n> No title, just text.\n\n> a plain quote with [brackets] (kept)\n',
  },
  {
    path: 'fixture: frontmatter edit (C6)',
    raw: '---\ntitle: Old\ntags:\n  - a\n  - b\n# a comment\nstatus: draft   \n---\n\n# Page\n\nBody.\n',
    edit: { key: 'status', value: 'final' },
    expect: '---\ntitle: Old\ntags:\n  - a\n  - b\n# a comment\nstatus: final\n---\n\n# Page\n\nBody.\n',
  },
  {
    path: 'fixture: frontmatter multi-line stays read-only (C6)',
    raw: '---\ntags:\n  - a\n---\n# P\n',
    edit: { key: 'tags', value: 'x' },
    expect: null,   // setFrontmatterValue must refuse: the value spans lines
  },
];

/** Run one fixture: the edit check when it has one, else the plain round-trip. */
function runFixture(f) {
  if (f.edit) {
    const doc = parseDoc(f.raw);
    const raw = setFrontmatterValue(doc.frontmatterRaw, f.edit.key, f.edit.value);
    if (f.expect === null) return { path: f.path, ok: raw === null, diff: raw === null ? null : ['+' + raw], bytes: f.raw.length };
    if (raw === null) return { path: f.path, ok: false, diff: ['- (edit refused)'], bytes: f.raw.length };
    doc.frontmatterRaw = raw;
    const rebuilt = composeDoc(doc, { title: doc.title, body: doc.body });
    return { path: f.path, ok: rebuilt === f.expect, diff: rebuilt === f.expect ? null : diff(f.expect, rebuilt, 200), bytes: f.raw.length };
  }
  const doc = parseDoc(f.raw);
  const body = roundTrip(crepe, doc.body);
  const rebuilt = composeDoc(doc, { title: doc.title, body });
  const a = norm(f.raw), b = norm(rebuilt);
  return { path: f.path, ok: a === b, diff: a === b ? null : diff(a, b, 200), bytes: f.raw.length };
}

function collect(node, out = []) {
  if (!node) return out;
  if (node.kind === 'file') { if (node.ext === 'md') out.push(node.path); return out; }
  for (const c of node.children || []) collect(c, out);
  return out;
}

/** Minimal unified-style diff, line based, first `max` hunks. */
function diff(a, b, max = 4) {
  const A = a.split('\n');
  const B = b.split('\n');
  // longest common subsequence over lines, bounded so a big file cannot lock the tab
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return ['(file too large for a line diff)'];
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = A[i] === B[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { ops.push(['-', A[i++]]); }
    else { ops.push(['+', B[j++]]); }
  }
  while (i < n) ops.push(['-', A[i++]]);
  while (j < m) ops.push(['+', B[j++]]);

  const out = [];
  let hunks = 0;
  for (let k = 0; k < ops.length && hunks < max; k++) {
    if (ops[k][0] === ' ') continue;
    const start = Math.max(0, k - 1);
    let end = k;
    while (end + 1 < ops.length && (ops[end + 1][0] !== ' ' || (ops[end + 2] && ops[end + 2][0] !== ' '))) end++;
    end = Math.min(ops.length - 1, end + 1);
    out.push(`@@ line ${start + 1} @@`);
    for (let x = start; x <= end; x++) out.push(ops[x][0] + ops[x][1]);
    hunks++;
    k = end;
  }
  return out;
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Rough bucket name for a changed line, so a run can be read as categories not files. */
function classify(l) {
  const sign = l[0];
  const t = l.slice(1);
  if (!t.trim()) return sign + ' blank line';
  if (/^\s*\|/.test(t)) return sign + ' table row';
  if (/\\[~]/.test(t)) return sign + ' escaped ~';
  if (/\\_/.test(t)) return sign + ' escaped _';
  if (/\\\*/.test(t)) return sign + ' escaped *';
  if (/\\\[/.test(t)) return sign + ' escaped [';
  if (/\\#/.test(t)) return sign + ' escaped #';
  if (/\\-/.test(t)) return sign + ' escaped -';
  if (/\\\./.test(t)) return sign + ' escaped .';
  if (/\\&/.test(t)) return sign + ' escaped &';
  if (/\\</.test(t)) return sign + ' escaped <';
  if (/^\s*[-*+]\s/.test(t)) return sign + ' list item';
  if (/^\s*\d+[.)]\s/.test(t)) return sign + ' ordered item';
  if (/^\s{2,}\S/.test(t)) return sign + ' indented line';
  if (/^#{1,6}\s/.test(t)) return sign + ' heading';
  if (/^\s*(---|\*\*\*|___)\s*$/.test(t)) return sign + ' rule';
  if (/^>/.test(t)) return sign + ' blockquote';
  if (/^\s*```/.test(t)) return sign + ' fence';
  return sign + ' other';
}

function renderDiff(lines) {
  return lines.map((l) => {
    const cls = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctxln';
    return `<span class="${cls}">${esc(l)}</span>`;
  }).join('\n');
}

let crepe = null;

async function run() {
  $('state').textContent = 'starting editor…';
  if (!crepe) {
    crepe = await makeCrepe({ root: $('stage'), markdown: '', slashCommands: false });
    window.__crepe = crepe;
    window.__rt = (md) => roundTrip(crepe, md);
  }

  const tree = await bridge.tree();
  const files = collect(tree).sort();
  const results = [];
  const t0 = performance.now();

  for (const f of FIXTURES) {
    try { results.push(runFixture(f)); } catch (e) { results.push({ path: f.path, error: String(e.message || e) + '\n' + (e.stack || '') }); }
  }

  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    if (i % 10 === 0) {
      $('state').textContent = `${i}/${files.length} ${path}`;
      await new Promise((r) => setTimeout(r));
    }
    let raw;
    try { raw = await bridge.readText(path); } catch (e) { results.push({ path, error: String(e.message || e) }); continue; }
    try {
      const doc = parseDoc(raw);
      const body = roundTrip(crepe, doc.body);
      const rebuilt = composeDoc(doc, { title: doc.title, body });
      const a = norm(raw), b = norm(rebuilt);
      results.push({ path, ok: a === b, diff: a === b ? null : diff(a, b, 200), bytes: raw.length });
    } catch (e) {
      results.push({ path, error: String(e.message || e) + '\n' + (e.stack || '') });
    }
  }

  const ms = Math.round(performance.now() - t0);
  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok && !r.error);
  const err = results.filter((r) => r.error);
  $('summary').innerHTML =
    `<b>${ok}/${results.length} identical</b> · ${bad.length} different · ${err.length} errors · ${ms}ms`;
  $('state').textContent = 'done';

  $('list').innerHTML = [...err, ...bad].map((r) => `
    <details class="file">
      <summary><span class="chip ${r.error ? 'err' : 'warn'}">${r.error ? 'ERROR' : 'DIFF'}</span> ${esc(r.path)}</summary>
      <pre>${r.error ? esc(r.error) : renderDiff(r.diff.slice(0, 120))}</pre>
    </details>`).join('');

  window.__results = results;
  window.__classify = () => {
    const buckets = new Map();
    for (const r of bad) {
      for (let k = 0; k < r.diff.length; k++) {
        const l = r.diff[k];
        if (l[0] !== '-' && l[0] !== '+') continue;
        const key = classify(l);
        if (!buckets.has(key)) buckets.set(key, { n: 0, ex: [] });
        const b = buckets.get(key);
        b.n++;
        if (b.ex.length < 3) b.ex.push(r.path + ' :: ' + l.slice(0, 160));
      }
    }
    return [...buckets.entries()].sort((a, b) => b[1].n - a[1].n);
  };
  console.log('[harness]', { ok, different: bad.length, errors: err.length, ms });
  return results;
}

$('run').onclick = run;
/** Fixtures only, for a quick check from the console: `await __runFixtures()`. */
window.__runFixtures = async () => {
  if (!crepe) { crepe = await makeCrepe({ root: $('stage'), markdown: '', slashCommands: false }); window.__crepe = crepe; }
  return FIXTURES.map((f) => { try { return runFixture(f); } catch (e) { return { path: f.path, error: String(e.message || e) }; } });
};
$('theme').onclick = () => {
  const d = document.documentElement.dataset.theme === 'dark';
  document.documentElement.dataset.theme = d ? 'light' : 'dark';
  try { localStorage.setItem('os.theme', document.documentElement.dataset.theme); } catch {}
};
window.__runHarness = run;
