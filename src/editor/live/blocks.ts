// The block decorations: the frontmatter fold, and the widgets registered for block nodes (a
// table, block maths, an image alone on its line).
//
// CodeMirror takes a decoration that replaces whole lines only from a state field, never from
// a view plugin, so these live in `blockField`. A keystroke must not cost a walk of the whole
// document, so the field maps its decorations through each change and rebuilds regions only:
// the blocks an edit can have changed, what the parser newly covers, and the blocks whose
// reveal moved. A caret moving along its line rebuilds nothing.
//
// The walk goes into the containers a block can sit in (lists, quotes; paragraphs only when a
// widget draws an inline-level node as a block) and stops at every other block, so it costs
// the number of blocks, not the number of nodes.

import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { runWidget } from './registry.ts';
import { revealedSpans, revealer, revealing, spansKey } from './reveal.ts';
import { widgetContext } from './inline.ts';

/** Nodes a block may sit inside. */
const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);
/** Block nodes that are never found inside a paragraph. */
const TOP_BLOCKS = new Set(['Frontmatter', 'Table', 'FencedCode', 'CodeBlock', 'HTMLBlock']);
/** How many property names the folded frontmatter lists. */
const SHOWN_KEYS = 3;
/** How many blocks past an edit are compared with the old tree before the rest is redone. */
const RESYNC_LIMIT = 64;

/**
 * The top-level keys of a frontmatter block's text, in order.
 * @param text   the whole block, fences included
 */
export function frontmatterKeys(text: string) {
  const keys: any[] = [];
  const lines = text.split('\n').slice(1, -1);
  for (const line of lines) {
    const m = /^([^\s#:'"-][^:]*?)[ \t]*:(?:[ \t]|$)/.exec(line);
    if (m && m[1]) keys.push(m[1]);
  }
  return keys;
}

/** The folded frontmatter: "Properties" and the first keys. A click or Enter opens it raw. */
class PropertiesWidget extends WidgetType {
  declare keys: string[];
  constructor(keys: string[]) { super(); this.keys = keys; }

  eq(o: PropertiesWidget) { return o.keys.length === this.keys.length && o.keys.every((k, i) => k === this.keys[i]); }

  toDOM(view: EditorView) {
    const box = document.createElement('div');
    box.className = 'cm-live-props';
    box.tabIndex = 0;
    box.setAttribute('role', 'button');
    box.setAttribute('aria-label', 'Properties: edit the frontmatter');
    const label = document.createElement('span');
    label.className = 'cm-live-props-label';
    label.textContent = 'Properties';
    box.appendChild(label);
    if (this.keys.length) {
      const names = document.createElement('span');
      names.className = 'cm-live-props-keys';
      const more = this.keys.length - SHOWN_KEYS;
      names.textContent = this.keys.slice(0, SHOWN_KEYS).join(', ') + (more > 0 ? ` +${more}` : '');
      box.appendChild(names);
    }
    const open = (e: Event) => { e.preventDefault(); e.stopPropagation(); openFrontmatter(view); };
    box.addEventListener('mousedown', (e) => { if (e.button === 0) open(e); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); });
    return box;
  }

  ignoreEvent() { return true; }
}

/**
 * Put the caret inside the frontmatter, on its first key line, which reveals it raw.
 */
export function openFrontmatter(view: EditorView) {
  const doc = view.state.doc;
  const at = doc.lines > 1 ? doc.line(2).from : 0;
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: 'select.live.frontmatter' });
  view.focus();
}

/**
 * The block decorations of `state` between `from` and `to` (the whole document by default).
 */
function blockRanges(state: import('@codemirror/state').EditorState, env: import('./inline.ts').Env, from: number = 0, to: number = state.doc.length): import('@codemirror/state').Range<Decoration>[] {
  const tree = syntaxTree(state);
  const { collected, revealed } = env;
  const ctx = widgetContext(state, env);
  const deep = [...collected.block.keys()].some((n) => !TOP_BLOCKS.has(n));
  const out: import('@codemirror/state').Range<Decoration>[] = [];
  const add = (a: number, b: number, deco: Decoration) => { if (a <= b && b <= state.doc.length) out.push(deco.range(a, b)); };
  tree.iterate({
    from,
    to,
    enter(ref) {
      const name = ref.name;
      if (name === 'Frontmatter') {
        if (!revealed(ref.from, ref.to)) {
          const keys = frontmatterKeys(state.doc.sliceString(ref.from, ref.to));
          add(ref.from, ref.to, Decoration.replace({ block: true, widget: new PropertiesWidget(keys) }));
        }
        return false;
      }
      const widgets = collected.block.get(name);
      if (widgets) {
        if (!revealed(ref.from, ref.to)) {
          for (const w of widgets) if (runWidget(w, ctx, ref, add)) break;
        }
        return false;
      }
      if (CONTAINERS.has(name)) return true;
      return deep && name === 'Paragraph';
    },
  });
  return out;
}

/**
 * The block decorations of `state`, over the whole document.
 */
export function buildBlocks(state: import('@codemirror/state').EditorState, env: import('./inline.ts').Env): import('@codemirror/state').RangeSet<Decoration> {
  return Decoration.set(blockRanges(state, env), true);
}

// ---------------------------------------------------------------------------
// regions

export type Region = { from: number, to: number };

/**
 * The top-level block that holds `pos`, or null between blocks.
 */
function topBlock(tree: import('@lezer/common').Tree, pos: number, side: -1 | 1) {
  let n = tree.resolve(pos, side);
  while (n.parent && n.parent.parent) n = n.parent;
  return n.parent ? n : null;
}

/**
 * The region an edit can have changed, in the new document: from the block before the one the
 * edit starts in (a line typed under a paragraph can make it a heading), to the first block past
 * the edit that the old tree had too, at the same place, of the same kind and the same length.
 * Typing a word re-reads one paragraph; opening a code fence re-reads everything below it.
 * @param back   new positions to old ones
 */
function editRegion(oldTree: import('@lezer/common').Tree, newTree: import('@lezer/common').Tree, back: import('@codemirror/state').ChangeDesc, fromB: number, toB: number, len: number): Region {
  const first = topBlock(newTree, fromB, -1) || topBlock(newTree, fromB, 1);
  const prev = first ? first.prevSibling : null;
  const from = Math.min(fromB, prev ? prev.from : first ? first.from : fromB);
  const last = topBlock(newTree, toB, 1) || topBlock(newTree, toB, -1);
  let to = Math.max(toB, last ? last.to : toB);
  let steps = 0;
  for (let c = last ? last.nextSibling : newTree.topNode.childAfter(toB); c; c = c.nextSibling) {
    const at = back.mapPos(c.from, 1);
    const o = oldTree.topNode.childAfter(at);
    if (o && o.from === at && o.name === c.name && o.to - o.from === c.to - c.from) break;
    to = c.to;
    if (++steps > RESYNC_LIMIT) { to = len; break; }
  }
  return { from, to: Math.min(to, len) };
}

/**
 * The top-level blocks a revealed span touches.
 */
function spanRegion(tree: import('@lezer/common').Tree, span: Region): Region {
  const a = topBlock(tree, span.from, 1) || topBlock(tree, span.from, -1);
  const b = topBlock(tree, span.to, -1) || topBlock(tree, span.to, 1);
  return { from: Math.min(span.from, a ? a.from : span.from), to: Math.max(span.to, b ? b.to : span.to) };
}

/**
 * Regions clamped to the document, sorted and merged.
 */
function merge(list: Region[], len: number) {
  const sorted = list
    .map((r) => ({ from: Math.max(0, Math.min(len, r.from)), to: Math.max(0, Math.min(len, r.to)) }))
    .sort((x, y) => x.from - y.from);
  const out: Region[] = [];
  for (const r of sorted) {
    const top = out[out.length - 1];
    if (top && r.from <= top.to + 1) top.to = Math.max(top.to, r.to);
    else out.push(r);
  }
  return out;
}

/**
 * Draw every decoration again: what they read from outside (a wikilink's target, an image
 * that appeared) may have changed. The view's `refresh()` dispatches it.
 */
export const redraw = StateEffect.define();

/**
 * The state field that holds the block decorations of a view, and provides them.
 */
export function blockField(base: Omit<import('./inline.ts').Env, 'revealed'>) {
  type Value = { deco: import('@codemirror/state').RangeSet<Decoration>, spans: Region[], key: string,
    tree: import('@lezer/common').Tree };
  const build = (state: import('@codemirror/state').EditorState): Value => {
    const spans = revealedSpans(state);
    const deco = buildBlocks(state, { ...base, revealed: revealer(spans) });
    return { deco, spans, key: spansKey(spans), tree: syntaxTree(state) };
  };
  return StateField.define({
    create: build,
    update(value: Value, tr: import('@codemirror/state').Transaction): Value {
      if (tr.effects.some((e) => e.is(redraw))) return build(tr.state);
      const tree = syntaxTree(tr.state);
      const focusMoved = revealing(tr.state) !== revealing(tr.startState);
      if (!tr.docChanged && tree === value.tree && !tr.selection && !focusMoved) return value;
      const spans = revealedSpans(tr.state);
      const key = spansKey(spans);
      const len = tr.state.doc.length;
      const regions: Region[] = [];
      let deco = value.deco;
      let oldSpans = value.spans;
      if (tr.docChanged) {
        deco = deco.map(tr.changes);
        oldSpans = oldSpans.map((s) => ({ from: tr.changes.mapPos(s.from, -1), to: tr.changes.mapPos(s.to, 1) }));
        const back = tr.changes.invertedDesc;
        tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
          regions.push(editRegion(value.tree, tree, back, fromB, toB, len));
        });
      } else if (tree !== value.tree) {
        // The parser moved on over the same text: redo what it newly covers, from the block its
        // old end cut through. A tree of the same length is a nested language arriving, which
        // changes no block; a shorter one is a reset, and everything is redone.
        if (tree.length < value.tree.length) return build(tr.state);
        if (tree.length > value.tree.length) {
          const cut = topBlock(tree, Math.max(0, value.tree.length - 1), 1);
          regions.push({ from: cut ? Math.min(cut.from, value.tree.length) : value.tree.length, to: tree.length });
        }
      }
      if (key !== value.key) {
        const now = new Set(spans.map((s) => `${s.from}-${s.to}`));
        const was = new Set(oldSpans.map((s) => `${s.from}-${s.to}`));
        for (const s of oldSpans) if (!now.has(`${s.from}-${s.to}`)) regions.push(spanRegion(tree, s));
        for (const s of spans) if (!was.has(`${s.from}-${s.to}`)) regions.push(spanRegion(tree, s));
      }
      if (!regions.length) {
        return !tr.docChanged && key === value.key && tree === value.tree ? value : { deco, spans, key, tree };
      }
      const merged = merge(regions, len);
      const env = { ...base, revealed: revealer(spans) };
      const add: import('@codemirror/state').Range<Decoration>[] = [];
      for (const r of merged) add.push(...blockRanges(tr.state, env, r.from, r.to));
      const lo = merged[0] ? merged[0].from : 0;
      const last = merged[merged.length - 1];
      const hi = last ? last.to : len;
      deco = deco.update({
        filterFrom: lo,
        filterTo: hi,
        filter: (f, t) => !merged.some((r) => t >= r.from && f <= r.to),
        add,
        sort: true,
      });
      return { deco, spans, key, tree };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
}
