// Code blocks. Languages and highlighting for the CodeMirror feature, the language picker,
// fence-then-Enter, and the keys that stay inside a block.
//
// Exports read by extensions.js: plugins(ctx, o), featureConfig(o), registerCommands(api).
//
// Four things had to be fixed from the outside, because Crepe builds the CodeMirror extension
// array itself and only ever appends ours to it:
//
//   - `languages` was empty, so nothing was ever highlighted. It is the language pack now.
//   - `basicSetup` brings line numbers, a fold gutter and a completion popup, none of which any
//     editor shows inside a note. The gutters go in code.css; the popup is switched off by
//     appending `autocompletion({override: []})`, which wins because `combineConfig` keeps the
//     first value given for a field and Crepe's own `autocompletion()` gives none.
//   - `defaultHighlightStyle` paints hard-coded hexes. Appending a non-fallback highlighter
//     replaces it wholesale (`getHighlighters` prefers any real highlighter over a fallback
//     one), and ours only assigns class names, which code.css colours from tokens.
//   - The picker in @milkdown/components has no free-text entry, no arrow keys and is drawn
//     inside a block that clips it. The trigger button stays; the list is ours, in a popover
//     portalled to document.body.

import { CrepeFeature } from '@milkdown/crepe';
import { languages as LANGUAGE_PACK } from '@codemirror/language-data';
import { EditorView as CodeMirror, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { autocompletion } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { NodeSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state';
import { commands, toast } from './host.js';
import './code.css';

// ---------------------------------------------------------------------------
// colours

/**
 * Every token becomes a class; code.css gives the class a token colour. Tags not listed here
 * (a plain identifier) keep the body colour, which is what a calm code block looks like.
 */
export const HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword,
    t.modifier, t.self, t.bool, t.null, t.atom], class: 'os-t-key' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.docString], class: 'os-t-str' },
  { tag: [t.number, t.integer, t.float, t.unit, t.escape, t.literal, t.constant(t.name)],
    class: 'os-t-num' },
  { tag: [t.definition(t.variableName), t.local(t.variableName), t.special(t.variableName)],
    class: 'os-t-var' },
  { tag: t.inserted, class: 'os-t-ins' },
  { tag: t.deleted, class: 'os-t-del' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'os-t-com' },
  // `meta` is not a comment: in Python it is the `@` of a decorator, in a shell script the
  // shebang, in HTML the doctype — the line that says "this changes what follows", which was
  // being painted the colour of the one thing that changes nothing (ADV-N). Its own class,
  // drawn in the keyword ink. `processingInstruction` keeps the comment colour it had.
  { tag: t.meta, class: 'os-t-meta' },
  { tag: t.processingInstruction, class: 'os-t-com' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)),
    t.macroName, t.labelName, t.propertyName, t.definition(t.propertyName), t.className,
    t.tagName], class: 'os-t-fn' },
  { tag: [t.typeName, t.standard(t.typeName), t.namespace, t.annotation, t.attributeName],
    class: 'os-t-type' },
  { tag: [t.operator, t.derefOperator, t.punctuation, t.separator, t.bracket, t.paren,
    t.brace, t.squareBracket, t.angleBracket, t.contentSeparator], class: 'os-t-punc' },
  { tag: [t.link, t.url], class: 'os-t-link' },
  { tag: t.strong, class: 'os-t-strong' },
  { tag: t.emphasis, class: 'os-t-em' },
  { tag: t.strikethrough, class: 'os-t-strike' },
  { tag: t.heading, class: 'os-t-head' },
  { tag: t.quote, class: 'os-t-quote' },
  { tag: t.invalid, class: 'os-t-invalid' },
]);

// ---------------------------------------------------------------------------
// the CodeMirror side

/** Every live ProseMirror view that has code blocks in it, so a CodeMirror can find its host. */
const hosts = new Set();

const blockDomOf = (el) => (el instanceof Element ? el.closest('.milkdown-code-block') : null);

/** The ProseMirror view a piece of DOM belongs to. */
function hostOf(dom) {
  for (const pm of hosts) if (pm.dom.contains(dom)) return pm;
  return null;
}

/** The document position of the code block a node view's dom stands for. */
function codeBlockPos(pm, dom) {
  let found = null;
  pm.state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type.name !== 'code_block') return true;
    if (pm.nodeDOM(pos) === dom) found = pos;
    return false;
  });
  return found;
}

/** Esc: out of CodeMirror, onto the block, which is then an ordinary block selection (E19). */
function escapeToBlock(cm) {
  const dom = blockDomOf(cm.dom);
  const pm = dom && hostOf(dom);
  if (!pm) return false;
  const pos = codeBlockPos(pm, dom);
  if (pos == null) return false;
  selectBlock(pm, pos);
  return true;
}

function selectBlock(pm, pos) {
  const tr = pm.state.tr.setSelection(NodeSelection.create(pm.state.doc, pos)).scrollIntoView();
  pm.dispatch(tr);
  // The node view focuses CodeMirror on selectNode; take the focus back so the block behaves
  // like any other selected block and blocks.js sees the keys.
  pm.focus();
}

/** Enter on a selected block: back inside, caret at the end of the text. */
function enterBlock(pm, pos) {
  const node = pm.state.doc.nodeAt(pos);
  if (!node) return false;
  const end = pos + 1 + node.content.size;
  pm.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, end)).scrollIntoView());
  pm.focus();
  return true;
}

const CM_EXTENSIONS = [
  syntaxHighlighting(HIGHLIGHT),
  // No completion popup inside a note. `override: []` leaves the sources empty, so the
  // autocompletion Crepe installs has nothing to offer and never opens.
  autocompletion({ activateOnTyping: false, override: [] }),
  Prec.highest(keymap.of([{ key: 'Escape', run: escapeToBlock }])),
];

// ---------------------------------------------------------------------------
// the language pack

/** name -> the pack entry, plus every alias, all lower case. */
const PACK = LANGUAGE_PACK.map((l) => ({
  name: l.name,
  value: l.name.toLowerCase(),
  alias: l.alias.filter((a) => a !== l.name.toLowerCase()),
}));

const known = (name) => {
  const q = String(name || '').toLowerCase();
  return PACK.some((l) => l.value === q || l.alias.includes(q));
};

/** Name first, then alias; a prefix match before a match in the middle. */
function search(query) {
  const q = query.trim().toLowerCase();
  if (!q) return PACK;
  const hit = [];
  for (const l of PACK) {
    const inName = l.value.indexOf(q);
    const inAlias = l.alias.findIndex((a) => a.includes(q));
    if (inName < 0 && inAlias < 0) continue;
    const rank = inName === 0 ? 0 : l.alias.some((a) => a.startsWith(q)) ? 1 : inName > 0 ? 2 : 3;
    hit.push({ l, rank });
  }
  hit.sort((a, b) => a.rank - b.rank || a.l.value.localeCompare(b.l.value));
  return hit.map((h) => h.l);
}

// ---------------------------------------------------------------------------
// the picker

/** @type {null | {el: HTMLElement, close: (refocus?: boolean) => void, pos: number}} */
let picker = null;

/** The api index.js hands over at boot (registerCommands): `touch` is what marks the page dirty. */
let api = null;

function closePicker(refocus = true) {
  if (picker) picker.close(refocus);
}

function setLanguage(pm, pos, language) {
  const node = pm.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'code_block') return;
  if ((node.attrs.language || '') === language) return;
  pm.dispatch(pm.state.tr.setNodeAttribute(pos, 'language', language));
  // The picker is portalled to document.body, so not one of its keystrokes reaches the page's
  // own listeners and `p.touched` stays false — which made the change dirty nothing, save
  // nothing and vanish on the next open (QA defect 1). The language is a user edit like any
  // other; say so through the editor's own API.
  if (api && typeof api.touch === 'function') api.touch();
}

/**
 * The list the popover shows: what was typed comes first, so any name at all can be set, known
 * or not; an empty box offers "Plain text" first, which clears the language.
 */
function rowsFor(query, current) {
  const q = query.trim();
  const rows = [];
  // The first row is always what Enter will write: what has been typed, or — with an empty
  // box — the language the block already has, spelled the way the file spells it.
  if (q) rows.push({ value: q, name: q, hint: known(q) ? 'as typed' : 'as typed · not highlighted' });
  else if (current) rows.push({ value: current, name: current, hint: 'unchanged' });
  if (!q) rows.push({ value: '', name: 'Plain text', hint: 'no language' });
  for (const l of search(q)) {
    if (l.value === (q ? q.toLowerCase() : current)) continue;
    rows.push({ value: l.value, name: l.name, hint: l.alias.slice(0, 4).join(' ') });
  }
  const resolves = (r) => r.value === current
    || (!!current && PACK.some((l) => l.value === r.value && (l.value === current || l.alias.includes(current))));
  return rows.map((r) => ({ ...r, current: resolves(r) }));
}

function openPicker(pm, pos, blockDom) {
  closePicker(false);

  const current = (pm.state.doc.nodeAt(pos)?.attrs.language || '').toLowerCase();
  const trigger = blockDom.querySelector('.language-button');
  const cm = CodeMirror.findFromDOM ? CodeMirror.findFromDOM(blockDom) : null;

  const el = document.createElement('div');
  el.className = 'os-lang';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Code block language');
  const head = document.createElement('div');
  head.className = 'os-lang-head';
  const input = document.createElement('input');
  input.className = 'os-lang-input';
  input.type = 'text';
  input.placeholder = 'Language';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-autocomplete', 'list');
  head.appendChild(input);
  const list = document.createElement('ul');
  list.className = 'os-lang-list';
  list.setAttribute('role', 'listbox');
  el.append(head, list);
  document.body.appendChild(el);
  if (trigger instanceof HTMLElement) trigger.dataset.osOpen = 'true';

  let rows = [];
  let active = 0;

  function render() {
    rows = rowsFor(input.value, current);
    if (active >= rows.length) active = rows.length - 1;
    if (active < 0) active = 0;
    list.textContent = '';
    rows.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'os-lang-row';
      li.id = `os-lang-row-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      if (r.current) li.dataset.current = 'true';
      if (i === active) li.dataset.active = 'true';
      const name = document.createElement('span');
      name.className = 'os-lang-name';
      name.textContent = r.name;
      const hint = document.createElement('span');
      hint.className = 'os-lang-hint';
      hint.textContent = r.hint;
      li.append(name, hint);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); apply(i); });
      list.appendChild(li);
    });
    input.setAttribute('aria-activedescendant', rows.length ? `os-lang-row-${active}` : '');
    scrollActiveIntoView();
  }

  function scrollActiveIntoView() {
    const li = list.children[active];
    if (!(li instanceof HTMLElement)) return;
    const top = li.offsetTop;
    const bottom = top + li.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }

  function move(step) {
    if (!rows.length) return;
    active = (active + step + rows.length) % rows.length;
    for (const li of Array.from(list.children)) {
      const i = Number(li.id.slice('os-lang-row-'.length));
      li.setAttribute('aria-selected', String(i === active));
      if (i === active) li.dataset.active = 'true'; else delete li.dataset.active;
    }
    input.setAttribute('aria-activedescendant', `os-lang-row-${active}`);
    scrollActiveIntoView();
  }

  function apply(i) {
    const row = rows[i];
    if (row) setLanguage(pm, pos, row.value);
    close(true);
  }

  function place() {
    // A block that is still a placeholder (scrolled out of view, its CodeMirror not built yet)
    // has no trigger button; the block itself is the anchor then.
    const anchor = trigger || blockDom;
    const r = anchor.getBoundingClientRect();
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const below = window.innerHeight - r.bottom;
    const top = below < h + 8 && r.top > h + 8 ? r.top - h - 4 : r.bottom + 4;
    el.style.top = `${Math.max(4, top)}px`;
    el.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
  }

  function close(refocus) {
    if (picker !== handle) return;
    picker = null;
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('mousedown', onOutside, true);
    if (trigger instanceof HTMLElement) delete trigger.dataset.osOpen;
    el.remove();
    if (!refocus) return;
    if (cm) cm.focus();
    else if (trigger instanceof HTMLElement) trigger.focus();
  }

  function onOutside(e) {
    if (e.target instanceof Node && el.contains(e.target)) return;
    // The trigger closes it through the click handler, which toggles; closing here too would
    // leave that handler with nothing open and it would open a second one.
    if (e.target instanceof Element && e.target.closest('.language-button') === trigger) return;
    close(false);
  }

  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Home') { e.preventDefault(); active = 0; move(0); return; }
    if (e.key === 'End') { e.preventDefault(); active = rows.length - 1; move(0); return; }
    if (e.key === 'Enter') { e.preventDefault(); apply(active); return; }
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(true); }
  });

  const handle = { el, close, pos };
  picker = handle;
  render();
  place();
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  window.addEventListener('mousedown', onOutside, true);
  input.focus();
}

// ---------------------------------------------------------------------------
// the ProseMirror side

const FENCE = /^```([^\s`]*)$/;

/** ``` and Enter, or ```lang and Enter: input rules never see Enter, so this does (E16). */
function openFence(view) {
  const { $from, empty } = view.state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph') return false;
  const text = $from.parent.textContent;
  if ($from.parentOffset !== text.length) return false;
  const m = FENCE.exec(text);
  if (!m) return false;
  const type = view.state.schema.nodes.code_block;
  if (!type) return false;
  const from = $from.before();
  const tr = view.state.tr.replaceRangeWith(from, from + $from.parent.nodeSize,
    type.create({ language: m[1] || '' }));
  tr.setSelection(TextSelection.create(tr.doc, from + 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** The code block a NodeSelection is on, if it is on one. */
function selectedCodeBlock(view) {
  const sel = view.state.selection;
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'code_block') return null;
  return sel.from;
}

/**
 * The code block the document selection is in or on. The node view forwards CodeMirror's
 * selection into ProseMirror, so this answers while the caret is inside CodeMirror too — which
 * is what the commands need, because by the time the palette runs one the focus is in the
 * palette's own input and the DOM says nothing.
 */
function codeBlockAt(view) {
  const onNode = selectedCodeBlock(view);
  if (onNode != null) return onNode;
  const $from = view.state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'code_block') return $from.before(d);
  }
  return null;
}

function handleKeyDown(view, event) {
  if (event.isComposing || event.keyCode === 229) return false;      // E44
  if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const pos = selectedCodeBlock(view);
  if (pos != null) return enterBlock(view, pos);
  return openFence(view);
}

/** The trigger button opens our picker, never Crepe's: taken in the capture phase. */
function onClickCapture(e) {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('.milkdown-code-block .language-button');
  if (!button) return;
  e.preventDefault();
  e.stopPropagation();
  const dom = blockDomOf(button);
  const pm = dom && hostOf(dom);
  if (!pm || !dom) return;
  if (picker) { closePicker(true); return; }
  const pos = codeBlockPos(pm, dom);
  if (pos != null) openPicker(pm, pos, dom);
}

export function plugins() {
  return [
    new Plugin({
      props: { handleKeyDown },
      view(pm) {
        hosts.add(pm);
        pm.dom.addEventListener('click', onClickCapture, true);
        return {
          destroy() {
            hosts.delete(pm);
            pm.dom.removeEventListener('click', onClickCapture, true);
            closePicker(false);
          },
        };
      },
    }),
  ];
}

export function featureConfig() {
  return {
    [CrepeFeature.CodeMirror]: {
      languages: LANGUAGE_PACK,
      extensions: CM_EXTENSIONS,
    },
  };
}

// ---------------------------------------------------------------------------
// commands

/** The code block the caret is in, whether the caret is inside CodeMirror or on the block. */
function currentBlock(api) {
  const pm = typeof api.getView === 'function' ? api.getView() : null;
  if (!pm) return null;
  let pos = codeBlockAt(pm);
  if (pos == null) {
    // Nothing in the document selection: fall back to the block the focus is in, for the case
    // where CodeMirror has the caret but has not forwarded a selection yet.
    const dom = blockDomOf(document.activeElement);
    if (!dom || !pm.dom.contains(dom)) return null;
    pos = codeBlockPos(pm, dom);
  }
  if (pos == null) return null;
  const dom = pm.nodeDOM(pos);
  return dom instanceof HTMLElement ? { pm, dom, pos } : null;
}

export function registerCommands(a) {
  api = a;
  const at = () => currentBlock(api);
  commands.register({
    id: 'code.language', title: 'Set code block language…', group: 'editor',
    when: () => !!at(),
    run: () => { const c = at(); if (c) openPicker(c.pm, c.pos, c.dom); },
  });
  commands.register({
    id: 'code.copy', title: 'Copy code block', group: 'editor',
    when: () => !!at(),
    run: () => {
      const c = at();
      if (!c) return;
      const node = c.pm.state.doc.nodeAt(c.pos);
      if (!node) return;
      Promise.resolve(navigator.clipboard?.writeText(node.textContent))
        .then(() => toast('code block copied', 'info', 1600))
        .catch(() => {
          // No clipboard permission in this context: the block's own button has a fallback.
          const button = c.dom.querySelector('.copy-button');
          if (button instanceof HTMLElement) button.click();
        });
    },
  });
}
