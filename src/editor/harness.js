// Round-trip harness: every *.md in the vault is parsed into a ProseMirror document and
// serialised straight back, with no user edit in between, and compared to the original.
// A difference here is a difference the editor would write to a real file, so this is the
// gate the stringify config has to pass.
//
// Two columns, because there are two questions (batch 12, M25):
//
//   bytes    the file that comes back is the file that went in, byte for byte. This is the
//            one the harness fails on. Line endings, the final newline and trailing spaces
//            are part of the file, so they are part of the comparison.
//   lenient  the same comparison through norm(), which forgives CRLF, trailing spaces and the
//            final newline. Kept for reference: it is what batch 9 measured, so the two
//            numbers side by side say how much of the damage the old column was hiding.
//
// And a third run, on its own button, for the question a round trip cannot ask: when the user
// changes one line, does anything *else* in the file change? `run edits` appends one character
// to every non-blank body line in the vault, one line at a time, and counts the other lines
// that moved. The target is zero.

import { parserCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core';
import { Fragment, Slice } from '@milkdown/kit/prose/model';
import { bridge } from './host.js';
import { makeCrepe, roundTrip } from './crepe.js';
import { parseDoc, composeDoc, setFrontmatterValue } from './doc.js';
import { postProcess } from './stringify.js';

// A sweep takes about a minute and the dev server reloads the page whenever anything under
// `src/` is written — in a shared working tree, often, and a run in flight is lost every time.
// So this page opts out of both halves of that: it accepts every hot update itself, and it
// tells Vite the full reload it is about to do belongs to some other page (Vite only reloads
// when the `.html` in the payload is the one on screen). The page therefore keeps running the
// code it started with: press the browser's reload to pick up an edit.
if (import.meta.hot) {
  import.meta.hot.accept(() => {});
  import.meta.hot.on('vite:beforeFullReload', (p) => { p.path = '/__harness_is_running__.html'; });
}

const $ = (id) => document.getElementById(id);
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '') + '\n';

const isTableRow = (l) => /^\s*\|/.test(l);

/**
 * A fence marker or a thematic break. Typing into one of these is a real edit but it is not a
 * prose edit: ```` ``` ```` gains an info string, `---` stops being a break and the heading
 * under it joins the paragraph. The document really did change shape, so the lines around it
 * really do move, and the sweep counts them apart from the question it is asking.
 */
function isMarkerLine(l) {
  if (/^\s{0,3}(`{3,}|~{3,})/.test(l)) return true;
  const t = l.trim();
  return t.length >= 3 && /^[-*_ \t]+$/.test(t) && new Set(t.replace(/[ \t]/g, '')).size === 1;
}

// ---------------------------------------------------------------------------
// Fixtures.
//
// Synthetic files for constructs the vault may not contain yet, and one per numbered finding
// of the batch-12 markdown research, so a regression has a name. Three kinds:
//
//   raw only              open + save with no edit must give back the same bytes.
//   raw + edit.key        the frontmatter value rewrite of C6, against the exact expected text.
//   raw + edit.line       append `edit.append` to that 1-based line of the *body*; every other
//                         line of the body must come back byte for byte. `expect` (the whole
//                         expected body) defaults to exactly that.
//   raw + compose.body    the body the *editor* holds, composed back into the file: the title,
//                         the gap under it and the body's own leading blank lines, which are
//                         the space the user put at the top of the page (space.js).
//   raw + canonical       the body written with no file underneath — a page the editor made,
//                         where there is nothing to reconcile against and the canonical text
//                         is what lands on disk.
//
// `todo: true` marks a fixture for a finding that is not fixed yet: it still runs and still
// reports, but it is counted apart so the gate stays honest about what is green today. Nothing
// carries it today — every fixture is in the failing column, which is where a fixture that
// passes belongs (batch 12, QA D7).

const LONG_LIST = Array.from({ length: 90 }, (_, i) => `- item ${i + 1}`).join('\n');

const FIXTURES = [
  // ---- batch 9 constructs -------------------------------------------------
  {
    path: 'C4 strikethrough',
    raw: '# Strike\n\nDone ~~and dusted~~, about ~10 months, ~2017 or so.\n\n- ~~old item~~ replaced\n- price ~ 40 and ~~50~~\n',
  },
  {
    path: 'C5 footnotes',
    raw: '# Notes\n\nA claim[^1] and another[^note].\n\n[^1]: The first source.\n\n[^note]: A named one, with _emphasis_.\n',
  },
  {
    path: 'C15 callouts',
    raw: '# Callouts\n\n> [!note] Title here\n> Body of the note.\n\n> [!warning]\n> No title, just text.\n\n> a plain quote with [brackets] (kept)\n',
  },
  {
    path: 'C6 frontmatter edit',
    raw: '---\ntitle: Old\ntags:\n  - a\n  - b\n# a comment\nstatus: draft   \n---\n\n# Page\n\nBody.\n',
    edit: { key: 'status', value: 'final' },
    expect: '---\ntitle: Old\ntags:\n  - a\n  - b\n# a comment\nstatus: final\n---\n\n# Page\n\nBody.\n',
  },
  {
    path: 'C6 frontmatter multi-line stays read-only',
    raw: '---\ntags:\n  - a\n---\n# P\n',
    edit: { key: 'tags', value: 'x' },
    expect: null,   // setFrontmatterValue must refuse: the value spans lines
  },

  // ---- M: markdown fidelity ----------------------------------------------
  {
    path: 'M1 one table cell edited, the rest of the table untouched',
    raw: '# T\n\n| Name     | Qty |\n|----------|-----|\n| Apples   | 3   |\n| Oranges  | 12  |\n',
    edit: { line: 3, append: '0' },   // body line 3 = `| Apples   | 3   |`, cell `3` -> `30`
    // the other three rows byte for byte, and the edited one in the table's own column widths
    expect: '| Name     | Qty |\n|----------|-----|\n| Apples   | 30  |\n| Oranges  | 12  |\n',
  },
  {
    // the shape the vault actually writes: a heading and the table under it with no blank line
    // between them, which is one block. Asking whether the block *starts* with a table is what
    // reflowed twenty tables in seven files on every edit (QA D1).
    path: 'M1 a table under a heading, one cell edited',
    raw: '# T\n\n### Head\n| Name     | Qty |\n|----------|-----|\n| Apples   | 3   |\n| Oranges  | 12  |\n',
    edit: { line: 4, append: '0' },
    expect: '### Head\n| Name     | Qty |\n|----------|-----|\n| Apples   | 30  |\n| Oranges  | 12  |\n',
  },
  {
    path: 'M1 a table under a heading, the heading edited and the table untouched',
    raw: '# T\n\n### Head\n| Name     | Qty |\n|----------|-----|\n| Apples   | 3   |\n| Oranges  | 12  |\n',
    edit: { line: 1, append: '!' },
  },
  {
    path: 'M2 paragraph followed by --- is a setext heading',
    raw: '# S\n\nSome prose that is really a heading\n---\n\nBody after.\n',
  },
  {
    path: 'M2 setext block edited stays setext',
    raw: '# S\n\nSome prose that is really a heading\n---\n\nBody after.\n',
    edit: { line: 1, append: '!' },
    expect: 'Some prose that is really a heading!\n---\n\nBody after.\n',
  },
  {
    path: 'M3 <br> kept',
    raw: '# B\n\nline one<br>line two\n',
  },
  {
    path: 'M3 <br> kept in the block being edited',
    raw: '# B\n\nline one<br>line two\n',
    edit: { line: 1, append: '!' },
  },
  {
    path: 'M4 four-space nested list, one item edited',
    raw: '# N\n\n- one\n    - nested a\n    - nested b\n- two\n    - nested c\n',
    edit: { line: 2, append: '!' },
  },
  {
    path: 'M5 an unparseable line does not reformat the file',
    raw: '# U\n\nfirst paragraph\n\n<div class="x">raw html</div>\n\n-   loose   bullet\n\nlast paragraph\n',
    edit: { line: 1, append: '!' },
  },
  {
    path: 'M6 an edit at the top of a 90-line list changes nothing below',
    raw: `# L\n\n${LONG_LIST}\n`,
    edit: { line: 1, append: '!' },
  },
  {
    path: 'M7 alt text and an Obsidian width on a standalone image',
    raw: '# I\n\n![a photo of the door](door.png)\n\n![the wiring|420](wiring.png)\n\n![|300](bare.png)\n',
  },
  {
    path: 'M8 no escapes added to a rewritten line',
    raw: '# E\n\nA `snake_case_var` and snake_case_var and #tag and 100 * 200.\n\n- item with a_b_c inside\n',
    edit: { line: 3, append: '!' },
  },
  {
    // remark is right that these asterisks are literal — `%**` before a letter cannot close a
    // strong run — but it is wrong to write the backslashes the file never had (QA D2)
    path: 'M8 a strong run that stops being one gains no backslash',
    raw: '# E\n\n**Success Rate: 70%**\n',
    edit: { line: 1, append: 'x' },
  },
  {
    path: 'M8 a leading underscore gains no backslash',
    raw: '# E\n\n_gap: written at the end of the month.\n',
    edit: { line: 1, append: 'x' },
  },
  {
    // the other direction: an escape the file wrote itself is content, and the block the user
    // edited keeps every one of them
    path: 'M8 a backslash the file wrote itself is kept on an edited line',
    raw: '# E\n\nliterally a \\_word\\_ and a \\*star\\* here\n',
    edit: { line: 1, append: '.' },
  },
  {
    path: 'M9 html entities kept',
    raw: '# H\n\nAT&amp;T and a&nbsp;gap and &copy; 2026.\n',
  },
  {
    // the entity itself cannot survive the parse — remark decodes it into the character it
    // names — but the character must come back as itself and not as a backslash escape
    path: 'M9 an edited entity line gains no backslash',
    raw: '# H\n\nAT&amp;T and a&nbsp;gap and &copy; 2026.\n',
    edit: { line: 1, append: '!' },
    expect: 'AT&T and a\u00A0gap and \u00A9 2026.!\n',
  },
  {
    path: 'M11 reference links and their definitions kept',
    raw: '# R\n\nSee [the docs][docs] and [more].\n\n[docs]: https://example.com/docs\n[more]: https://example.com/more\n',
  },
  {
    path: 'M12 markers preserved: * bullets, 1), ***, ~~~',
    raw: '# M\n\n* star one\n* star two\n\n1) first\n2) second\n\n***\n\n~~~js\nconst a = 1;\n~~~\n',
  },
  {
    path: 'M13 fence info string beyond the language',
    raw: '# F\n\n```js title="a.js" {1,3}\nconst a = 1;\n```\n',
  },
  {
    path: 'M13 the fence info string survives an edit inside the block',
    raw: '# F\n\n```js title="a.js" {1,3}\nconst a = 1;\nconst b = 2;\n```\n',
    edit: { line: 2, append: ' // x' },
  },
  { path: 'M14 no final newline', raw: '# N\n\nlast line with no newline' },
  { path: 'M15 mixed line endings kept per line', raw: '# X\r\n\r\nCRLF line\r\nLF line\nCRLF again\r\n' },
  {
    path: 'M16 BOM kept and the title still found',
    raw: '\uFEFF# Title\n\nBody.\n',
    expectDoc: { bom: true, title: 'Title' },
  },
  {
    path: 'M17 --- on line 1 with prose is not frontmatter',
    raw: '---\nthis is not yaml, it is a rule then prose\n---\n\n# Later heading\n',
    expectDoc: { frontmatter: false, titleLine: null },
  },
  {
    path: 'M21 callout with a list gains no quote line',
    raw: '# C\n\n> [!tip] T\n> - a\n> - b\n',
  },
  {
    path: 'M21 an edited callout with a list gains no quote line',
    raw: '# C\n\n> [!tip] T\n> - a\n> - b\n',
    edit: { line: 2, append: '!' },
  },
  {
    path: 'M22 a code span containing a pipe inside a table cell',
    raw: '# P\n\n| a | b |\n|---|---|\n| `x \\| y` | c |\n',
  },
  {
    path: 'M22 the code span keeps its pipe when the row is edited',
    raw: '# P\n\n| a | b |\n|---|---|\n| `x \\| y` | c |\n| d | e |\n',
    edit: { line: 4, append: '!' },
  },
  {
    path: 'M23 mailto link stays a mailto link',
    raw: '# M\n\nWrite to [Hassan](mailto:h@example.com) about it.\n',
    edit: { line: 1, append: '!' },
  },
  {
    // the vault's own shape (`6-documents/3-hassan/PROFILE.md`): the label *is* the address,
    // which is the one case `resourceLink: false` collapses to an autolink (QA D4)
    path: 'M23 a mailto link whose label is the address keeps its brackets',
    raw: '# M\n\nMail [a@b.com](mailto:a@b.com) about it.\n',
    edit: { line: 1, append: '!' },
  },
  { path: 'M24 trailing spaces on untouched lines', raw: '# W\n\nline with two trailing spaces  \nnext line\n' },
  {
    path: 'M24 trailing spaces survive an edit elsewhere',
    raw: '# W\n\nline with two trailing spaces  \n\nnext paragraph\n',
    edit: { line: 3, append: '!' },
  },
  {
    path: 'M26 closing hash sequence on the title',
    raw: '# Title #\n\nBody.\n',
    expectDoc: { title: 'Title' },
  },

  {
    // one list to remark, because of the blank line before the last bullet, and a loose list is
    // written with a blank line between every item. The file has none and editing one item is
    // no reason to gain three (QA D3).
    path: 'M12 a tight list stays tight when the list is loose further down',
    raw: '# T\n\n- Finance management\n- Backup cash reserve\n- Car fix\n\n- writing something?\n',
    edit: { line: 3, append: 'X' },
  },
  {
    path: 'M10 an empty paragraph at the top of the body is space, and is written',
    raw: '# QA blank\n\nonly paragraph\n',
    // what the editor holds after pressing Enter at the very start of the page. A run of N
    // blank lines is N minus 1 lines of space (space.js): the blank line the gap after the
    // title already leaves, plus this one, is one empty paragraph, and it stays where it was
    // put. Batch 12 wrote the opposite here, which is what took deliberate space away.
    compose: { body: '\nonly paragraph' },
    expect: '# QA blank\n\n\nonly paragraph\n',
  },

  // ---- L: the live editor -------------------------------------------------
  { path: 'L1 an empty list item keeps the file\'s own bytes', raw: '# L\n\n- one\n- \n- two\n' },
  {
    // and one the *editor* makes is written `-`: a marker with nothing after it, which reads
    // back as the same empty item and leaves no trailing space on the line (QA D6)
    path: 'L1 an empty list item the editor writes is a bare `-`',
    raw: '# L\n\n- one\n- \n- two\n',
    canonical: true,
    expect: '- one\n-\n- two\n',
  },
  {
    path: 'L20 the table delimiter row is left as written',
    raw: '# D\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| c | d |\n|:---|---:|\n| 3 | 4 |\n',
  },
  { path: 'L17/E33 a bare newline inside a paragraph is a hard break', raw: '# HB\n\nfirst half\nsecond half\n' },
  {
    path: 'E33 a break the editor inserts in a paragraph is a bare newline',
    raw: 'first half\n',
    insert: { after: 'first half', text: 'second half' },
    expect: 'first half\nsecond half\n',
  },
  {
    path: 'M3/E33 a break the editor inserts in a table cell is <br>',
    raw: '| a | b |\n| --- | --- |\n| x | c |\n',
    insert: { after: 'x', text: 'y' },
    expect: '| a | b |\n| --- | --- |\n| x<br>y | c |\n',
  },
  {
    path: 'L17/E33 the hard break stays a bare newline when the paragraph is edited',
    raw: '# HB\n\nfirst half\nsecond half\n',
    edit: { line: 1, append: '!' },
  },

  // ---- E: editing ---------------------------------------------------------
  { path: 'E22 an inline link gains no stray backslash', raw: '# E\n\nSee [label](http://x.com) for more.\n' },
  {
    path: 'E22 an inline link typed into a paragraph',
    raw: '# E\n\nSee [label](http://x.com) for more.\n',
    edit: { line: 1, append: '!' },
  },
];

// ---------------------------------------------------------------------------
// Running one fixture.

/**
 * One character typed into a line, the way a user types it: at the end of a paragraph line,
 * and inside the last cell of a table row — appending after the closing `|` would add a
 * column, which is a different question from the one M1 asks.
 */
export function typeInto(line, ch = 'x') {
  if (!isTableRow(line)) return line + ch;
  const m = /([^|\s])([ \t]*\|[ \t]*)$/.exec(line);
  if (m) return line.slice(0, m.index + 1) + ch + m[2];
  // an empty last cell: put the character in it rather than past the closing pipe, which
  // would add a column and ask a different question
  const p = line.lastIndexOf('|');
  return p > 0 ? line.slice(0, p) + ch + line.slice(p) : line + ch;
}

/** Apply the edit to the 1-based `line` of `body`; returns the edited body. */
function applyLineEdit(body, edit) {
  const lines = body.split('\n');
  const i = edit.line - 1;
  if (i < 0 || i >= lines.length) throw new Error(`line ${edit.line} out of range (${lines.length})`);
  lines[i] = edit.text !== undefined ? edit.text : typeInto(lines[i], edit.append);
  return lines.join('\n');
}

/**
 * The one document a fixture cannot spell in markdown: a hard break the *editor* inserted.
 * That is a `hardbreak` node, not the inline html node a `<br>` in a file becomes, and mdast's
 * own handler writes a space for it wherever a newline is unsafe — which is exactly inside a
 * table row, where P2's Shift+Enter puts one. `raw` is the body; the result is what a save
 * would write for it (E33, and P2's message).
 */
function insertHardBreak(f) {
  return crepe.editor.action((ctx) => {
    const doc = ctx.get(parserCtx)(f.raw);
    const schema = ctx.get(schemaCtx);
    let pos = null;
    doc.descendants((node, p) => { if (pos === null && node.isText && node.text === f.insert.after) pos = p + node.nodeSize; });
    if (pos === null) throw new Error(`no text node "${f.insert.after}"`);
    const parts = [schema.nodes.hardbreak.create(), schema.text(f.insert.text)];
    return postProcess(ctx.get(serializerCtx)(doc.replace(pos, pos, new Slice(Fragment.from(parts), 0, 0))));
  });
}

function runFixture(f) {
  // 0. a break inserted by the editor, which no markdown source can produce
  if (f.insert) {
    const got = insertHardBreak(f);
    return result(f, got === f.expect, got === f.expect ? null : diff(f.expect, got, 200));
  }

  // 1. the frontmatter value rewrite (C6)
  if (f.edit && f.edit.key) {
    const doc = parseDoc(f.raw);
    const raw = setFrontmatterValue(doc.frontmatterRaw, f.edit.key, f.edit.value);
    if (f.expect === null) {
      return result(f, raw === null, raw === null ? null : ['+' + raw]);
    }
    if (raw === null) return result(f, false, ['- (edit refused)']);
    doc.frontmatterRaw = raw;
    const rebuilt = composeDoc(doc, { title: doc.title, body: doc.body });
    return result(f, rebuilt === f.expect, rebuilt === f.expect ? null : diff(f.expect, rebuilt, 200));
  }

  // 1b. a body the editor holds that no markdown source can spell, composed back into the file
  if (f.compose) {
    const doc = parseDoc(f.raw);
    const body = roundTrip(crepe, f.compose.body, doc.body);
    const rebuilt = composeDoc(doc, { title: doc.title, body });
    return result(f, rebuilt === f.expect, rebuilt === f.expect ? null : diff(f.expect, rebuilt, 200));
  }

  // 1c. the body written with no file underneath: a page the editor made, where there is
  //     nothing to reconcile against and the canonical text is what lands on disk
  if (f.canonical) {
    const doc = parseDoc(f.raw);
    const got = roundTrip(crepe, doc.body, '');
    return result(f, got === f.expect, got === f.expect ? null : diff(f.expect, got, 200));
  }

  // 2. one line edited: only that line may change
  if (f.edit && f.edit.line) {
    const doc = parseDoc(f.raw);
    const edited = applyLineEdit(doc.body, f.edit);
    const expect = f.expect != null ? f.expect : edited;
    const got = roundTrip(crepe, edited, doc.body);
    return result(f, got === expect, got === expect ? null : diff(expect, got, 200));
  }

  // 3. open + save, no edit: the same bytes back, and the document read the way it should be
  const doc = parseDoc(f.raw);
  const body = roundTrip(crepe, doc.body);
  const rebuilt = composeDoc(doc, { title: doc.title, body });
  const notes = [];
  for (const [k, want] of Object.entries(f.expectDoc || {})) {
    const got = k === 'frontmatter' ? !!doc.frontmatterRaw : doc[k];
    if (got !== want) notes.push(`-doc.${k} should be ${JSON.stringify(want)}, is ${JSON.stringify(got)}`);
  }
  const same = rebuilt === f.raw && !notes.length;
  return result(f, same, same ? null : [...notes, ...(rebuilt === f.raw ? [] : diff(f.raw, rebuilt, 200))],
    norm(f.raw) === norm(rebuilt) && !notes.length);
}

function result(f, exact, d, lenient) {
  return { path: f.path, todo: !!f.todo, exact, lenient: lenient === undefined ? exact : lenient, diff: d, bytes: f.raw.length };
}

function collect(node, out = []) {
  if (!node) return out;
  if (node.kind === 'file') { if (node.ext === 'md') out.push(node.path); return out; }
  for (const c of node.children || []) collect(c, out);
  return out;
}

// ---------------------------------------------------------------------------
// Diffing.

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

/**
 * The changed region between two nearly identical line arrays: trim the common prefix and the
 * common suffix, and report what is left. O(n) on the usual case (nothing changed, or one
 * line changed), which is what makes a 4,000-edit sweep finish in a tab.
 */
function changedRegion(A, B) {
  let p = 0;
  const max = Math.min(A.length, B.length);
  while (p < max && A[p] === B[p]) p++;
  let s = 0;
  while (s < max - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  return { start: p, aEnd: A.length - s, bEnd: B.length - s };
}

/**
 * @returns {{exact:boolean, collateral:number, table:number, sample:string[]}}
 * `collateral` counts the lines that changed other than the one the user edited.
 */
function editDelta(expected, actual, editedIndex) {
  if (expected === actual) return { exact: true, collateral: 0, table: 0, sample: [] };
  const A = expected.split('\n');
  const B = actual.split('\n');
  const r = changedRegion(A, B);
  const aLines = A.slice(r.start, r.aEnd);
  const bLines = B.slice(r.start, r.bEnd);
  let n = Math.max(aLines.length, bLines.length);
  const inside = editedIndex >= r.start && editedIndex < r.aEnd;
  if (inside) n -= 1;
  const sample = [];
  for (let i = 0; i < aLines.length && sample.length < 4; i++) {
    if (r.start + i !== editedIndex) sample.push('-' + aLines[i]);
  }
  for (let i = 0; i < bLines.length && sample.length < 8; i++) sample.push('+' + bLines[i]);
  const table = [...aLines, ...bLines].filter(isTableRow).length;
  return { exact: false, collateral: Math.max(0, n), table, sample };
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Rough bucket name for a changed line, so a run can be read as categories not files. */
function classify(l) {
  const sign = l[0];
  const t = l.slice(1);
  if (!t.trim()) return sign + ' blank line';
  if (isTableRow(t)) return sign + ' table row';
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

async function ready() {
  if (crepe) return crepe;
  $('state').textContent = 'starting editor…';
  crepe = await makeCrepe({ root: $('stage'), markdown: '', slashCommands: false });
  window.__crepe = crepe;
  window.__rt = (md, original) => roundTrip(crepe, md, original);
  return crepe;
}

async function files() {
  return collect(await bridge.tree()).sort();
}

// ---------------------------------------------------------------------------
// Run 1: open + save, no edit.

async function run() {
  await ready();
  const list = await files();
  const results = [];
  const t0 = performance.now();

  for (const f of FIXTURES) {
    try { results.push(runFixture(f)); } catch (e) { results.push({ path: f.path, todo: !!f.todo, error: String(e.message || e) + '\n' + (e.stack || '') }); }
  }

  for (let i = 0; i < list.length; i++) {
    const path = list[i];
    $('state').textContent = `${i}/${list.length} ${path}`;
    await new Promise((r) => setTimeout(r));
    let raw;
    try { raw = await bridge.readText(path); } catch (e) { results.push({ path, error: String(e.message || e) }); continue; }
    try {
      const doc = parseDoc(raw);
      const body = roundTrip(crepe, doc.body);
      const rebuilt = composeDoc(doc, { title: doc.title, body });
      const exact = rebuilt === raw;
      const lenient = norm(raw) === norm(rebuilt);
      results.push({ path, exact, lenient, diff: exact ? null : diff(raw, rebuilt, 200), bytes: raw.length });
    } catch (e) {
      results.push({ path, error: String(e.message || e) + '\n' + (e.stack || '') });
    }
  }

  const ms = Math.round(performance.now() - t0);
  const live = results.filter((r) => !r.todo);
  const todo = results.filter((r) => r.todo);
  const exact = live.filter((r) => r.exact).length;
  const lenient = live.filter((r) => r.lenient).length;
  const bad = live.filter((r) => !r.exact && !r.error);
  const err = results.filter((r) => r.error);
  const todoOk = todo.filter((r) => r.exact).length;

  $('summary').innerHTML =
    `<b>bytes ${exact}/${live.length}</b> · lenient ${lenient}/${live.length} · ` +
    `${bad.length} different · ${err.length} errors · ` +
    (todo.length ? `known-broken fixtures ${todoOk}/${todo.length} · ` : '') + `${ms}ms`;
  $('state').textContent = 'done';

  $('list').innerHTML = [...err, ...bad, ...todo.filter((r) => !r.exact && !r.error)].map((r) => `
    <details class="file">
      <summary><span class="chip ${r.error ? 'err' : r.todo ? 'info' : 'warn'}">${r.error ? 'ERROR' : r.todo ? 'TODO' : 'DIFF'}</span> ${esc(r.path)}${r.lenient && !r.exact ? ' <span class="ctxln">(lenient: same)</span>' : ''}</summary>
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
  const out = { bytes: exact, lenient, of: live.length, different: bad.length, errors: err.length, todoOk, todo: todo.length, ms };
  console.log('[harness]', out);
  return out;
}

// ---------------------------------------------------------------------------
// Run 2: one unrelated edit.
//
// The measurement CLAUDE.md's rule is written against. For every non-blank line of every body
// in the vault: append one character to that line, run the save path (serialise, reconcile
// against what is on disk, verify), and compare with the file that has only that line changed.
// Anything else that moved is collateral damage. Tables are counted apart because they were
// the bulk of it (M1) and are fixed by their own pass.
//
// The comparison is the *file*, not the body: the edited body goes back through `composeDoc`,
// so the BOM, the final newline and every line's own ending are part of what is measured and
// the vault's ten CRLF files are swept with their endings intact. The sweep used to strip CRLF
// before it started, which meant those ten files were never tested against an edit at all
// (QA D8).

const SAVE_KEY = 'os.harness.edits';
const saved = () => { try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { return null; } };

/**
 * The sweep takes about a minute and the dev server reloads the page whenever anything under
 * `src/` is written, so progress is checkpointed after every file. `resume: true` picks the run
 * back up where the reload cut it off; `done` says the whole list was covered.
 */
async function runEdits(opt = {}) {
  await ready();
  const list = (await files()).filter((p) => !opt.filter || p.includes(opt.filter));
  const t0 = performance.now();
  const prev = opt.resume ? saved() : null;
  const stats = prev ? prev.stats : {
    engine: opt.legacy ? 'batch 9 (lines)' : 'batch 12 (blocks)',
    files: 0, edits: 0, exact: 0, dirty: 0,
    spread: 0, spreadTable: 0, spreadMarker: 0, spreadOther: 0, collateral: 0,
    tableEdits: 0, tableDirty: 0, done: false,
  };
  const examples = prev ? prev.examples : [];
  const start = prev ? prev.next : 0;

  for (let f = start; f < list.length; f++) {
    const path = list[f];
    let raw;
    try { raw = await bridge.readText(path); } catch { continue; }
    const doc = parseDoc(raw);
    const lines = doc.body.split('\n');
    // Everything `composeDoc` puts in front of the body, so a line of the body can be named by
    // its line in the file — which is what the two texts being compared are.
    const head = doc.frontmatterRaw + doc.preTitle + (doc.titleLine !== null ? doc.titleLine + doc.gap : '');
    const offset = head ? head.split('\n').length - 1 : 0;
    const file = (body) => composeDoc(doc, { title: doc.title, body });
    stats.files++;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      if (opt.max && stats.edits >= opt.max) break;
      const edited = lines.slice();
      edited[i] = typeInto(edited[i]);
      const expected = file(edited.join('\n'));
      let got;
      try { got = file(roundTrip(crepe, edited.join('\n'), doc.body, opt)); } catch (e) { got = 'ERROR ' + String(e.message || e); }
      const d = editDelta(expected, got, offset + i);
      stats.edits++;
      const onTable = isTableRow(lines[i]);
      if (onTable) stats.tableEdits++;
      if (d.exact) { stats.exact++; continue; }
      stats.dirty++;
      stats.collateral += d.collateral;
      // `spread` is the number the rule in CLAUDE.md is about: edits that changed a line other
      // than the one the user was on. `dirty` also counts an edit whose own line came back
      // spelled differently — escaped, or repadded inside a table — which is allowed.
      // One bucket each, decided by the line the user was on, so the three add up to `spread`.
      if (d.collateral > 0) {
        stats.spread++;
        if (isMarkerLine(lines[i])) stats.spreadMarker++;
        else if (onTable) stats.spreadTable++;
        else stats.spreadOther++;
      }
      if (onTable || d.table) stats.tableDirty++;
      if (d.collateral > 0 && examples.length < 40) examples.push({ path, line: i + 1, src: lines[i].slice(0, 90), collateral: d.collateral, table: d.table, sample: d.sample });
    }
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ next: f + 1, stats, examples })); } catch {}
    if (f % 5 === 0) {
      $('state').textContent = `edits ${f}/${list.length} · ${stats.edits} edits · ${stats.dirty} dirty`;
      await new Promise((r) => setTimeout(r));
    }
    if (opt.max && stats.edits >= opt.max) break;
  }

  stats.done = !opt.max || stats.edits < opt.max;
  stats.ms = Math.round(performance.now() - t0);
  $('summary').innerHTML =
    `<b>${stats.edits} one-line edits · ${stats.spread} changed another line</b> ` +
    `(${(100 * stats.spread / Math.max(1, stats.edits)).toFixed(1)}%) · ${stats.collateral} collateral lines · ` +
    `tables ${stats.spreadTable} · fence/rule markers ${stats.spreadMarker} · elsewhere ${stats.spreadOther} · ` +
    `${stats.dirty} rewrote their own line · ${stats.engine}, whole files · ${stats.ms}ms`;
  $('state').textContent = 'done';
  $('list').innerHTML = examples.map((e) => `
    <details class="file">
      <summary><span class="chip warn">${e.collateral}</span> ${esc(e.path)}:${e.line} ${esc(e.src)}</summary>
      <pre>${renderDiff(e.sample)}</pre>
    </details>`).join('');
  window.__editStats = stats;
  window.__editExamples = examples;
  console.log('[harness edits]', stats);
  return stats;
}

$('run').onclick = run;
$('runEdits').onclick = () => runEdits();
$('runLegacy').onclick = () => runEdits({ legacy: true });

/** Fixtures only, for a quick check from the console: `await __runFixtures()`. */
window.__runFixtures = async () => {
  await ready();
  return FIXTURES.map((f) => { try { return runFixture(f); } catch (e) { return { path: f.path, todo: !!f.todo, error: String(e.message || e) }; } });
};
$('theme').onclick = () => {
  const d = document.documentElement.dataset.theme === 'dark';
  document.documentElement.dataset.theme = d ? 'light' : 'dark';
  try { localStorage.setItem('os.theme', document.documentElement.dataset.theme); } catch {}
};
window.__runHarness = run;
window.__runEdits = runEdits;
