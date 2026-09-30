// The inline decorations: what Live draws over the lines, off the caret's.
//
// One walk over the syntax tree of the given ranges (the visible ones in the view, the whole
// document for `liveDecorations`). Markup is hidden only where it is not revealed (reveal.ts);
// where it is revealed it is shown dimmed, and the styling of what it marks (a heading's size,
// a bold run) stays either way, so moving the caret onto a line only uncovers its markup.
//
// What it draws:
//   headings      `#…` and the space after it hidden, the line `cm-live-h1`…`h6`, the first H1
//                 `cm-live-title`
//   emphasis      `_ _`, `* *`, `** **`, `__ __`, `~~ ~~`, `` ` ` `` hidden, the content styled
//   links         `[text](url "title")` shows the text as a link; autolinks and bare URLs styled
//   wikilinks     `[[target#heading|alias]]` shows the alias, else the target; missing ones
//                 `cm-live-missing`
//   lists         a `-`, `*` or `+` bullet becomes a bullet widget, ordered numbers stay
//   tasks         `- [ ]` / `- [x]` become a checkbox (tasks.ts); a done task's line `cm-live-done`
//   quotes        `>` hidden, the lines `cm-live-quote`; `>>` lines are a frame, as in Rich
//   callouts      `> [!type] Title` becomes a header widget; the lines `cm-live-callout(-type)`
//   rules         `---` becomes a rule widget
//   HTML          tags, blocks and comments shown raw, dimmed, never rendered
//
// Widgets registered for an inline node (an image, inline maths) are called here through the
// registry; block constructs (frontmatter, a table, block maths) are blocks.ts's, and this walk
// does not go inside them unless they are revealed. Building decorations never dispatches.

import { Decoration, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { calloutOf, wikiParts } from './syntax.ts';
import { runWidget } from './registry.ts';
import { BulletWidget, CheckboxWidget } from './tasks.ts';

/**
 * What the builders read. `revealed` is the reveal rule for the state being drawn; the rest
 * comes from the view's options (view.ts), or answers nothing in a pure build (state.ts).
 */
export interface Env {
  collected: import('./registry.ts').Collected;
  revealed: (from: number, to: number) => boolean;
  path: string;
  resolveAsset: (src: string) => string | null;
  resolveWikilink: ((target: string) => { path: string | null, exists: boolean }) | null;
  openLink: (href: string, o: { newTab: boolean }) => void;
  inlineHtml: (md: string) => string;
  toggleTask: (view: import('@codemirror/view').EditorView, dom: HTMLElement) => boolean;
  openFrontmatter: (view: import('@codemirror/view').EditorView) => void;
}

// ---------------------------------------------------------------------------
// the small widgets

/** `---` off the caret's line. */
class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const hr = document.createElement('span');
    hr.className = 'cm-live-rule';
    hr.setAttribute('role', 'separator');
    return hr;
  }
  ignoreEvent() { return false; }
}
const RULE = new RuleWidget();

/** `> [!type] Title` off the caret: the type as a label and the title as written. */
class CalloutHeadWidget extends WidgetType {
  declare type: string;
  declare word: string;
  declare title: string;
  constructor(type: string, word: string, title: string) { super(); this.type = type; this.word = word; this.title = title; }

  eq(o: CalloutHeadWidget) { return o.type === this.type && o.word === this.word && o.title === this.title; }

  toDOM() {
    const head = document.createElement('span');
    head.className = `cm-live-callout-head cm-live-callout-head-${this.type}`;
    const label = document.createElement('span');
    label.className = 'cm-live-callout-label';
    label.textContent = this.word || this.type;
    head.appendChild(label);
    if (this.title) {
      const title = document.createElement('span');
      title.className = 'cm-live-callout-title';
      title.textContent = this.title;
      head.appendChild(title);
    }
    return head;
  }
  ignoreEvent() { return false; }
}

// ---------------------------------------------------------------------------
// shared decorations

const HIDE = Decoration.replace({});
const DIM = Decoration.mark({ class: 'cm-live-mark' });
const HTML = Decoration.mark({ class: 'cm-live-html' });
const LISTNUM = Decoration.mark({ class: 'cm-live-listmark' });
const STYLE = {
  Emphasis: Decoration.mark({ class: 'cm-live-em' }),
  StrongEmphasis: Decoration.mark({ class: 'cm-live-strong' }),
  Strikethrough: Decoration.mark({ class: 'cm-live-strike' }),
  InlineCode: Decoration.mark({ class: 'cm-live-code' }),
};
const lineDecos: Map<string, Decoration> = new Map();
const lineClass = (cls: string) => {
  let d = lineDecos.get(cls);
  if (!d) { d = Decoration.line({ class: cls }); lineDecos.set(cls, d); }
  return d;
};

const HEADING = /^ATXHeading([1-6])$/;
const SETEXT = /^SetextHeading([12])$/;
const HTML_NODES = new Set(['HTMLTag', 'HTMLBlock', 'Comment', 'CommentBlock', 'ProcessingInstruction', 'ProcessingInstructionBlock']);
const MARKS = new Set(['EmphasisMark', 'StrikethroughMark']);
const LISTS = new Set(['BulletList', 'OrderedList']);

const firstH1Cache: WeakMap<import('@lezer/common').Tree, number> = new WeakMap();

/**
 * Where the first H1 of the page starts, or -1: it takes the page-title style.
 */
function firstH1(tree: import('@lezer/common').Tree) {
  const known = firstH1Cache.get(tree);
  if (known !== undefined) return known;
  let at = -1;
  for (let c = tree.topNode.firstChild; c; c = c.nextSibling) {
    if (c.name === 'ATXHeading1' || c.name === 'SetextHeading1') { at = c.from; break; }
  }
  firstH1Cache.set(tree, at);
  return at;
}

/**
 * How deep a line is quoted, by its `>` markers.
 */
function quoteDepth(text: string) {
  const m = /^[ \t]*((?:>[ \t]?)+)/.exec(text);
  return m ? ((m[1] || '').match(/>/g) || []).length : 0;
}

/**
 * The context a registered widget is handed.
 */
export function widgetContext(state: import('@codemirror/state').EditorState, env: Env): import('./registry.ts').WidgetContext {
  return {
    state, path: env.path, revealed: env.revealed, resolveAsset: env.resolveAsset,
    openLink: env.openLink, inlineHtml: env.inlineHtml,
  };
}

// ---------------------------------------------------------------------------
// the walk

/**
 * The inline decorations of `state` over `ranges`.
 */
export function buildInline(state: import('@codemirror/state').EditorState, ranges: readonly { from: number; to: number; }[], env: Env): import('@codemirror/state').RangeSet<Decoration> {
  const tree = syntaxTree(state);
  const doc = state.doc;
  const { revealed, collected } = env;
  const ctx = widgetContext(state, env);
  const out: import('@codemirror/state').Range<Decoration>[] = [];
  /** node -> what its first visit answered */
  const seen: Map<string, boolean> = new Map();
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (!first || !last) return Decoration.none;
  // Line classes are added for the lines of a node inside this window only: a code block of
  // fifty thousand lines should not cost fifty thousand decorations per keystroke.
  const lo = first.from;
  const hi = last.to;
  const eachLine = (from: number, to: number, fn: (line: import('@codemirror/state').Line) => void) => {
    for (let pos = Math.max(from, lo); pos <= Math.min(to, hi);) { const line = doc.lineAt(pos); fn(line); pos = line.to + 1; }
  };
  const title = firstH1(tree);
  const add = (from: number, to: number, deco: Decoration) => { if (from <= to) out.push(deco.range(from, to)); };
  const addLine = (pos: number, cls: string) => { const at = doc.lineAt(pos).from; out.push(lineClass(cls).range(at, at)); };
  /** Hide a piece of markup that does not cross a line, or dim it when revealed. */
  const hideOr = (from: number,to: number,shown: boolean) => {
    if (to <= from) return;
    if (shown) { add(from, to, DIM); return; }
    if (doc.lineAt(from).number !== doc.lineAt(to).number) return;
    add(from, to, HIDE);
  };
  /** The callout being walked: its extent, whether it is revealed, where its header line ends. */
  let callout = { from: -1, to: -1, shown: true, headTo: -1 };

  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(ref) {
        // A node that reaches into two visible ranges is met twice: drawn once, and walked
        // into (or not) the same way both times.
        const key = `${ref.type.id}:${ref.from}:${ref.to}`;
        const known = seen.get(key);
        if (known !== undefined) return known;
        const r = visit(ref) !== false;
        seen.set(key, r);
        return r;
      },
    });
  }
  return Decoration.set(out, true);

  // -------------------------------------------------------------------------

  /**
   * Draw one node; false means its children are not walked.
   */
  function visit(ref: import('@lezer/common').SyntaxNodeRef): boolean {
    const name = ref.name;
    const from = ref.from;
    const to = ref.to;

    // Registered widgets first: an inline one draws its node off the caret; the node of a
    // block one is blocks.ts's, and nothing inside it is walked.
    const inl = collected.inline.get(name);
    if (inl) {
      if (!revealed(from, to)) {
        for (const w of inl) if (runWidget(w, ctx, ref, add)) break;
      }
      return false;
    }
    if (name === 'FencedCode' || name === 'CodeBlock') {
      eachLine(from, to, (line) => addLine(line.from, 'cm-live-fence'));
      return false;
    }
    if (name === 'Frontmatter') {
      if (revealed(from, to)) {
        eachLine(from, to, (line) => addLine(line.from, 'cm-live-fm'));
      }
      return false;
    }
    // A table shown raw (the caret is in it) is monospace, so its pipes line up while it is edited.
    if (name === 'Table' && revealed(from, to)) {
      eachLine(from, to, (line) => addLine(line.from, 'cm-live-table-raw'));
      return false;
    }
    if (collected.block.has(name)) return false;

    let m = HEADING.exec(name);
    if (m) {
      addLine(from, `cm-live-h${m[1]}${from === title ? ' cm-live-title' : ''}`);
      return true;
    }
    m = SETEXT.exec(name);
    if (m) {
      const end = doc.lineAt(to).number;
      for (let n = doc.lineAt(from).number; n < end; n++) {
        addLine(doc.line(n).from, `cm-live-h${m[1]}${from === title ? ' cm-live-title' : ''}`);
      }
      return true;
    }
    if (name === 'HeaderMark') {
      const parent = ref.node.parent;
      if (!parent) return false;
      const shown = revealed(from, to);
      if (SETEXT.test(parent.name)) { add(from, to, DIM); return false; }
      const line = doc.lineAt(from);
      if (from === parent.from) {
        // The opening `#`s and the one space after them, unless the heading is empty.
        const after = doc.sliceString(to, Math.min(line.to, to + 1));
        if (line.to <= to + 1 && !shown) return false;
        hideOr(from, after === ' ' || after === '\t' ? to + 1 : to, shown);
      } else {
        const before = doc.sliceString(Math.max(line.from, from - 1), from);
        hideOr(before === ' ' || before === '\t' ? from - 1 : from, to, shown);
      }
      return false;
    }

    const style = STYLE[(name as keyof typeof STYLE)];
    if (style) {
      add(from, to, style);
      if (name === 'InlineCode') {
        const shown = revealed(from, to);
        for (const mark of ref.node.getChildren('CodeMark')) hideOr(mark.from, mark.to, shown);
        return false;
      }
      return true;
    }
    if (MARKS.has(name)) { hideOr(from, to, revealed(from, to)); return false; }
    if (name === 'Escape') { if (!revealed(from, to)) hideOr(from, from + 1, false); return false; }
    if (HTML_NODES.has(name)) { add(from, to, HTML); return false; }

    if (name === 'Link') return link(ref);
    if (name === 'Autolink') {
      const url = ref.node.getChild('URL');
      if (!url) return false;
      const shown = revealed(from, to);
      hideOr(from, url.from, shown);
      hideOr(url.to, to, shown);
      add(url.from, url.to, linkMark(doc.sliceString(url.from, url.to), shown));
      return false;
    }
    if (name === 'URL') {
      const parent = ref.node.parent;
      if (parent && (parent.name === 'Link' || parent.name === 'Image' || parent.name === 'Autolink' || parent.name === 'LinkReference')) return false;
      add(from, to, linkMark(doc.sliceString(from, to), revealed(from, to)));
      return false;
    }
    if (name === 'Wikilink') { wikilink(from, to); return false; }

    if (name === 'ListMark') { listMark(ref); return false; }
    if (name === 'Task') {
      const marker = ref.node.getChild('TaskMarker');
      if (marker) {
        const c = doc.sliceString(marker.from + 1, marker.from + 2);
        addLine(from, c === 'x' || c === 'X' ? 'cm-live-task cm-live-done' : 'cm-live-task');
      }
      return true;
    }
    if (name === 'TaskMarker') { taskMarker(ref); return false; }

    if (name === 'Blockquote') { blockquote(ref); return true; }
    if (name === 'QuoteMark') {
      const inCallout = from >= callout.from && to <= callout.to;
      if (inCallout && !callout.shown && from <= callout.headTo) return false;   // under the header widget
      const shown = inCallout ? callout.shown : revealed(from, to);
      const after = doc.sliceString(to, to + 1);
      hideOr(from, after === ' ' ? to + 1 : to, shown);
      return false;
    }
    if (name === 'HorizontalRule') {
      if (revealed(from, to)) add(from, to, DIM);
      else add(from, to, Decoration.replace({ widget: RULE }));
      return false;
    }
    return true;
  }

  /**
   * A link mark: the text shown as a link, with the href for a click. `cm-live-follow` says a
   * plain click follows it (the markup is hidden); on a revealed line a plain click places the
   * caret and only a modified click follows.
   */
  function linkMark(href: string, shown: boolean) {
    return Decoration.mark({
      class: shown ? 'cm-live-link' : 'cm-live-link cm-live-follow',
      attributes: { 'data-href': href },
    });
  }

  /** `[text](url "title")`. */
  function link(ref: import('@lezer/common').SyntaxNodeRef) {
    const node = ref.node;
    const marks = node.getChildren('LinkMark');
    const url = node.getChild('URL');
    const open = marks[0];
    const close = marks[1];
    // A reference or shortcut link has no URL here: left as written.
    if (!url || !open || !close || close.from <= open.to) return true;
    const shown = revealed(ref.from, ref.to);
    const href = doc.sliceString(url.from, url.to).replace(/^<|>$/g, '');
    hideOr(open.from, open.to, shown);
    hideOr(close.from, ref.to, shown);
    add(open.to, close.from, linkMark(href, shown));
    return true;
  }

  /** `[[target#heading|alias]]`. */
  function wikilink(from: number, to: number) {
    const parts = wikiParts(doc.sliceString(from, to));
    const shown = revealed(from, to);
    let missing = false;
    if (env.resolveWikilink && parts.target) {
      try { missing = !env.resolveWikilink(parts.target).exists; } catch { missing = false; }
    }
    const textFrom = shown ? from + 2 : from + parts.shownFrom;
    const textTo = to - 2;
    hideOr(from, textFrom, shown);
    hideOr(textTo, to, shown);
    if (textTo > textFrom) {
      add(textFrom, textTo, Decoration.mark({
        class: `cm-live-link cm-live-wiki${missing ? ' cm-live-missing' : ''}${shown ? '' : ' cm-live-follow'}`,
        attributes: { 'data-wiki': parts.ref },
      }));
    }
  }

  /** A list item's marker: a bullet widget, a checkbox with it, or an ordered number. */
  function listMark(ref: import('@lezer/common').SyntaxNodeRef) {
    const item = ref.node.parent;
    const list = item && item.parent;
    if (!item || !list) return;
    const shown = revealed(ref.from, ref.to);
    const next = ref.node.nextSibling;
    const marker = next && next.name === 'Task' ? next.getChild('TaskMarker') : null;
    if (list.name !== 'BulletList') {
      add(ref.from, ref.to, LISTNUM);
      return;
    }
    if (shown) { add(ref.from, ref.to, DIM); return; }
    if (marker && doc.lineAt(marker.from).number === doc.lineAt(ref.from).number) {
      const c = doc.sliceString(marker.from + 1, marker.from + 2);
      add(ref.from, marker.to, Decoration.replace({ widget: new CheckboxWidget(c === 'x' || c === 'X') }));
      return;
    }
    let level = 0;
    let p: import('@lezer/common').SyntaxNode | null = list;
    for (; p; p = p.parent) if (LISTS.has(p.name)) level++;
    add(ref.from, ref.to, Decoration.replace({ widget: new BulletWidget(level) }));
  }

  /** `[ ]` after an ordered number (a bullet's is drawn with its bullet). */
  function taskMarker(ref: import('@lezer/common').SyntaxNodeRef) {
    const task = ref.node.parent;
    const item = task && task.parent;
    const list = item && item.parent;
    const shown = revealed(ref.from, ref.to);
    if (shown) { add(ref.from, ref.to, DIM); return; }
    if (list && list.name === 'BulletList') return;
    const c = doc.sliceString(ref.from + 1, ref.from + 2);
    add(ref.from, ref.to, Decoration.replace({ widget: new CheckboxWidget(c === 'x' || c === 'X') }));
  }

  /** The lines of the outermost quote: a bar, a frame for `>>`, or a callout. */
  function blockquote(ref: import('@lezer/common').SyntaxNodeRef) {
    for (let p = ref.node.parent; p; p = p.parent) if (p.name === 'Blockquote') return;
    const c = calloutOf(state, ref);
    /** The depth of line `n`: its own `>` count, or the line's above for a lazy line. */
    const depthOf = (n: number) => {
      for (let k = n; k >= 1 && doc.line(k).from >= ref.from; k--) {
        const d = quoteDepth(doc.line(k).text);
        if (d) return d;
      }
      return 1;
    };
    const firstLine = doc.lineAt(ref.from).number;
    const lastLine = doc.lineAt(ref.to).number;
    if (c) {
      const shown = revealed(ref.from, ref.to);
      callout = { from: ref.from, to: ref.to, shown, headTo: c.to };
      eachLine(ref.from, ref.to, (line) => {
        let cls = `cm-live-callout cm-live-callout-${c.type}`;
        if (line.number === firstLine) cls += ' cm-live-callout-first';
        if (line.number === lastLine) cls += ' cm-live-callout-last';
        addLine(line.from, cls);
      });
      if (!shown && c.to > c.from) {
        add(c.from, c.to, Decoration.replace({ widget: new CalloutHeadWidget(c.type, c.word, c.title) }));
      }
      return;
    }
    eachLine(ref.from, ref.to, (line) => {
      const n = line.number;
      if (depthOf(n) < 2) { addLine(line.from, 'cm-live-quote'); return; }
      let cls = 'cm-live-frame';
      if (n === firstLine || depthOf(n - 1) < 2) cls += ' cm-live-frame-first';
      if (n === lastLine || depthOf(n + 1) < 2) cls += ' cm-live-frame-last';
      addLine(line.from, cls);
    });
  }
}
