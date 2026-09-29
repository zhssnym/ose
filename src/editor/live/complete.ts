// `[[` in Live: a completion of the vault's pages, where the caret is.
//
// Typing `[[` opens CodeMirror's completion list, fed by the same page list Rich's picker and
// `resolveWikilink` read (the page hands it in as `pages`). The rows are the pages' names,
// matched by CodeMirror's own fuzzy filter as more is typed; a name two pages share offers the
// path instead, so the link written names one page. Accepting a row writes `target]]` (or
// only the target when `]]` already follows) in one transaction, `input.live.complete`, and one
// Ctrl+Z takes it back. Esc closes the list and leaves what was typed as it was typed.
//
// Nothing is created from here: a link to a page that does not exist is drawn missing, and
// following it offers to create it, as everywhere else.

import { autocompletion, pickedCompletion } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';

/** A page name longer than this is not what `[[` is for. */
const MAX_QUERY = 64;
/** What may stand between `[[` and the caret while the list stays open. */
const QUERY = /^[^[\]\n|#]*$/;
/** Nodes whose text is literal: no completion inside them. */
const LITERAL = new Set(['InlineCode', 'CodeText', 'FencedCode', 'CodeBlock', 'Frontmatter', 'HTMLBlock', 'Comment']);

/**
 * The `[[` the caret is typing after, as `{ from, query }`, or null.
 */
export function wikiQueryAt(state: import('@codemirror/state').EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const i = before.lastIndexOf('[[');
  if (i < 0) return null;
  const query = before.slice(i + 2);
  if (query.length > MAX_QUERY || !QUERY.test(query)) return null;
  let n: import('@lezer/common').SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  for (; n; n = n.parent) if (LITERAL.has(n.name)) return null;
  return { from: line.from + i + 2, query };
}

const withoutMd = (p: string) => p.replace(/\.md$/i, '');
const baseName = (p: string) => p.split('/').pop() || p;

/**
 * The rows for a page list: a name each, or the path where two pages share a name.
 * @param list   vault paths
 * @param self              this page, left out
 */
export function wikiOptions(list: readonly string[], self: string): import('@codemirror/autocomplete').Completion[] {
  const pages = list.filter((p) => typeof p === 'string' && p && p !== self && /\.md$/i.test(p));
  const count: Map<string, number> = new Map();
  for (const p of pages) {
    const k = withoutMd(baseName(p)).toLowerCase();
    count.set(k, (count.get(k) || 0) + 1);
  }
  return pages.map((p) => {
    const name = withoutMd(baseName(p));
    const shared = (count.get(name.toLowerCase()) || 0) > 1;
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    return {
      label: shared ? withoutMd(p) : name,
      detail: shared ? undefined : dir || undefined,
      type: 'text',
      apply: applyTarget(shared ? withoutMd(p) : name),
    };
  });
}

/**
 * Write `target]]` over what was typed after `[[`, or only the target when `]]` follows.
 */
function applyTarget(target: string): (view: import('@codemirror/view').EditorView, c: import('@codemirror/autocomplete').Completion, from: number, to: number) => void {
  return (view, completion, from, to) => {
    const closed = view.state.sliceDoc(to, to + 2) === ']]';
    const insert = closed ? target : `${target}]]`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length + (closed ? 2 : 0) },
      annotations: pickedCompletion.of(completion),
      scrollIntoView: true,
      userEvent: 'input.live.complete',
    });
  };
}

/**
 * The completion extension. `pages` answers the vault's page paths, now or later; it is asked
 * once per `[[`, so a page created since the last one is in the list.
 * @param self   this page's path
 */
export function wikiCompletion(pages: (() => readonly string[] | Promise<readonly string[]>) | null | undefined, self: string) {
  if (typeof pages !== 'function') return [];
  let asked: { from: number; rows: Promise<import('@codemirror/autocomplete').Completion[]>; } | null = null;
  const rowsFor = (from: number) => {
    if (asked && asked.from === from) return asked.rows;
    const rows = Promise.resolve()
      .then(() => pages())
      .then((list) => wikiOptions(Array.isArray(list) ? list : [], self), () => []);
    asked = { from, rows };
    return rows;
  };
  const source: import('@codemirror/autocomplete').CompletionSource = async (context) => {
    const at = wikiQueryAt(context.state, context.pos);
    if (!at) { asked = null; return null; }
    const options = await rowsFor(at.from);
    if (context.aborted || !options.length) return null;
    return { from: at.from, to: context.pos, options, validFor: QUERY };
  };
  return autocompletion({
    override: [source],
    activateOnTyping: true,
    icons: false,
    closeOnBlur: true,
    maxRenderedOptions: 40,
  });
}
