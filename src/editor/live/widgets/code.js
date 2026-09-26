// Live's fenced code: highlighted by the language its fence names, in a box, in the mono face.
//
// The highlighting is CodeMirror's own nested parse: `languages` is @codemirror/language-data's
// list, with the short fence names it lacks (```py, ```rs) and ```text as plain, which the core
// hands to the markdown language as its code languages, so a ```python fence is parsed as Python
// and every token gets its tag. The tags become the `os-t-*` classes of ../../highlight.js (the
// style every other code surface of the app uses), coloured in widgets.css by the same
// `--code-*` tokens, inside a code block only.
//
// The box is a line decoration on every line of the block, fences included, and it is drawn
// whether or not the caret is in the block: a code block is edited as it is shown, and a box
// that came and went with the caret would make the column jump. So it comes from this widget's
// own view plugin (`extension`), not from `decorate`. What does depend on the caret is the
// fence markup: off the caret the backticks and the info string are dimmed, and on it they are
// drawn like the code, because that is when they are being read.

import {
  LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting, syntaxTree,
} from '@codemirror/language';
import { languages as PACK } from '@codemirror/language-data';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';
import { HIGHLIGHT } from '../../highlight.js';

// ---------------------------------------------------------------------------
// fence names

/**
 * The short names a fence is written with that the pack does not answer to: its entries match
 * a name or an alias, never an extension, so ```py (what the paste converter writes for
 * `language-py`, and what the vault has beside ```python) found nothing and stayed plain.
 * Keyed by the pack entry's own name, lower case.
 */
export const FENCE_ALIASES = /** @type {Readonly<Record<string, readonly string[]>>} */ ({
  python: ['py', 'py3'],
  rust: ['rs'],
  markdown: ['md'],
  kotlin: ['kt'],
  powershell: ['ps1', 'pwsh'],
  go: ['golang'],
});

/**
 * Fences that name no language at all. The pack's loose match reads `text` as LaTeX (it holds
 * the alias `tex`), so a ```text block of output was coloured as TeX; these are plain.
 */
export const PLAIN_FENCES = /** @type {readonly string[]} */ (['text', 'plaintext', 'plain', 'txt']);

/** A grammar that reads every line as one untagged token: plain text, in the code box. */
const plainText = new LanguageSupport(StreamLanguage.define({
  name: 'plaintext',
  token(stream) { stream.skipToEnd(); return null; },
}));

/**
 * The pack name a fence's info string stands for: `py` is `python`, `text` is `''` (no
 * language), and anything else is itself. The Reading view reads a fence through this too, so
 * the two views colour the same fences.
 * @param {string} info
 * @returns {string}
 */
export function fenceLanguage(info) {
  const name = String(info || '').trim().toLowerCase();
  if (PLAIN_FENCES.includes(name)) return '';
  for (const [canonical, short] of Object.entries(FENCE_ALIASES)) if (short.includes(name)) return canonical;
  return name;
}

/**
 * The pack, with the short names added to their entries (a copy that loads through the
 * original, so a grammar is fetched once) and a plain-text entry in front.
 * @type {LanguageDescription[]}
 */
export const languages = [
  LanguageDescription.of({ name: 'Plain text', alias: [...PLAIN_FENCES], support: plainText }),
  ...PACK.map((d) => {
    const extra = FENCE_ALIASES[d.name.toLowerCase()];
    if (!extra) return d;
    return LanguageDescription.of({
      name: d.name,
      alias: [...d.alias, ...extra],
      extensions: d.extensions,
      filename: d.filename,
      load: () => d.load(),
    });
  }),
];

// ---------------------------------------------------------------------------
// the box

const LINE = Decoration.line({ class: 'cm-live-codeblock' });
const FIRST = Decoration.line({ class: 'cm-live-codeblock cm-live-codeblock-first' });
const LAST = Decoration.line({ class: 'cm-live-codeblock cm-live-codeblock-last' });
const ONLY = Decoration.line({ class: 'cm-live-codeblock cm-live-codeblock-first cm-live-codeblock-last' });
const MARK = Decoration.mark({ class: 'cm-live-code-mark' });

/**
 * The line decorations of every fenced block that shows in `view`.
 *
 * @param {import('@codemirror/view').EditorView} view
 * @returns {import('@codemirror/view').DecorationSet}
 */
export function codeLines(view) {
  const { state } = view;
  /** @type {RangeSetBuilder<import('@codemirror/view').Decoration>} */
  const builder = new RangeSetBuilder();
  let done = -1;                                          // the last line number decorated
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'FencedCode') return;
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(Math.max(node.from, node.to)).number;
        for (let n = Math.max(first, done + 1); n <= last; n++) {
          const line = state.doc.line(n);
          const deco = first === last ? ONLY : n === first ? FIRST : n === last ? LAST : LINE;
          builder.add(line.from, line.from, deco);
        }
        done = Math.max(done, last);
        return false;
      },
    });
  }
  return builder.finish();
}

const boxes = ViewPlugin.fromClass(class {
  /** @param {import('@codemirror/view').EditorView} view */
  constructor(view) { this.decorations = codeLines(view); }

  /** @param {import('@codemirror/view').ViewUpdate} u */
  update(u) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = codeLines(u.view);
    }
  }
}, { decorations: (p) => p.decorations });

/** @type {import('../registry.js').LiveWidget} */
export const code = {
  id: 'code',
  kind: 'inline',
  nodes: ['FencedCode'],
  languages,
  extension: [boxes, syntaxHighlighting(HIGHLIGHT)],
  decorate(_ctx, node, out) {
    // Only the fences' own marks: the backticks and the language name.
    for (let child = node.node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'CodeMark' || child.name === 'CodeInfo') out.add(child.from, child.to, MARK);
    }
  },
};
