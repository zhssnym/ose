// `codeEditor(el, opts)` (docs/KERNEL.md `ose:editor`): CodeMirror as a component.
//
// The same editor source mode mounts, with two things added: a language from the CodeMirror
// language pack (the one the code-block feature uses, so a `python` block and a `.py` file are
// highlighted by the same rules), and, when it is given a `path`, the page editor's save: the
// file is read back before every write and must still be the text this editor was opened from,
// or the user decides what happens (CONTRACT.md batch 9, B1). With `text` instead of `path`
// nothing is read and nothing is written; `onSave` is handed the text and does what it likes.
//
// A module uses this for a script beside its data, the rice for a `.json` or a `.css` of its
// own; source mode inside a page stays where it is, in page.js, because it shares the page's
// title strip, baseline and conflict dialog.

import { Compartment, StateEffect } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages as LANGUAGE_PACK } from '@codemirror/language-data';
import { bridge } from './host.js';
import { choose, toast } from './deps.js';
import { HIGHLIGHT } from './code.js';
import { createSourceView } from './source.js';
import { keepVersion, keepDiskVersion } from './versions.js';
import * as P from './paths.js';

/** The pack entry for a language name, an alias, or a file name. */
function describe(language, path) {
  const name = String(language || '').trim();
  if (name) {
    return LanguageDescription.matchLanguageName(LANGUAGE_PACK, name, true)
      || LANGUAGE_PACK.find((l) => l.alias.includes(name.toLowerCase()))
      || null;
  }
  if (path) return LanguageDescription.matchFilename(LANGUAGE_PACK, P.basename(path));
  return null;
}

/**
 * What Tab inserts. Two spaces is the app's own and is right for markdown and for most of the
 * pack; Python is four, because that is Python's convention, it is what a seeded stub is
 * written with, and a file that mixes the two is a `TabError` waiting to happen (K3).
 */
const INDENT = { python: '    ' };

/**
 * @param {HTMLElement} el
 * @param {object} opts  { path | text, language, readOnly, onChange, onSave, gutter,
 *                         placeholder, indent }
 */
export function codeEditor(el, opts = {}) {
  const path = opts.path ? String(opts.path) : null;
  const language = new Compartment();
  const listeners = new Map();

  let baseline = path ? null : String(opts.text ?? '');
  let dirty = false;
  let readOnly = !!opts.readOnly;
  let closed = false;
  let saving = null;
  let hold = false;

  const emit = (event, payload) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[editor:${event}]`, e); }
    }
  };

  const markDirty = () => {
    if (dirty) return;
    dirty = true;
    emit('dirty', { path, dirty: true });
  };
  const markClean = () => {
    if (!dirty) return;
    dirty = false;
    emit('dirty', { path, dirty: false });
  };

  el.innerHTML = '';
  const host = document.createElement('div');
  host.className = 'ed-code';
  el.append(host);

  // `.md` is the one language the pack does not have to load: source mode's own markdown mode
  // is already in the bundle, and `createSourceView` installs it.
  const isMarkdown = !!path && P.extname(path) === 'md' && !opts.language;
  const named = describe(opts.language, path);
  const indent = opts.indent || INDENT[String(named && named.name || '').toLowerCase()] || '  ';
  const view = createSourceView({
    host,
    text: baseline ?? '',
    markdown: isMarkdown,
    gutter: opts.gutter !== false,
    placeholder: opts.placeholder,
    indent,
    readOnly,
    onChange: () => {
      markDirty();
      if (typeof opts.onChange === 'function') { try { opts.onChange(getText()); } catch (e) { console.error('[editor] onChange', e); } }
    },
  });

  // Grown onto the view rather than passed to `createSourceView`: the language slot and the
  // code palette belong to this editor, and source mode inside a page must not gain either.
  // Ctrl+S here as well as in the rice: a code editor inside a dialog or a module's panel is
  // not always under a chord the rice bound (docs/KERNEL.md, keyboard reachable every time).
  const extras = [
    keymap.of([{ key: 'Mod-s', run: () => { void save({ explicit: true }); return true; }, preventDefault: true }]),
    syntaxHighlighting(HIGHLIGHT),
    language.of([]),
  ];
  view.view.dispatch({ effects: StateEffect.appendConfig.of(extras) });

  const getText = () => view.getText();

  /** The language pack entry, loaded once, after the editor is already on screen. */
  const loaded = (async () => {
    const desc = named;
    if (!desc) return;
    try {
      const support = await desc.load();
      if (!closed) view.view.dispatch({ effects: language.reconfigure(support) });
    } catch (e) { console.warn('[editor] language', desc.name, e && e.message ? e.message : e); }
  })();

  const ready = (async () => {
    if (!path) { await loaded; return; }
    let text = '';
    try {
      text = await bridge.readText(path);
    } catch (e) {
      toast(`cannot open ${path}: ${e && e.message ? e.message : e}`, 'err');
      baseline = null;
      readOnly = true;
      view.setReadOnly(true);
      return;
    }
    if (closed) return;
    baseline = text;
    view.setText(text);
    markClean();
    await loaded;
  })();

  /**
   * Write, with the page editor's three guards (B1, C18): never a file the user has not
   * changed, never over a file that moved under us without asking, and never a file that is
   * no longer there. Resolves true when the caller may move on.
   */
  async function save(o = {}) {
    if (!path) {
      if (typeof opts.onSave === 'function') { try { await opts.onSave(getText()); } catch (e) { console.error('[editor] onSave', e); } }
      markClean();
      emit('saved', { path: null, text: getText() });
      return true;
    }
    if (readOnly || baseline === null) return true;
    if (!dirty) return true;
    if (saving) { await saving; return !hold; }
    if (hold && !o.explicit) return true;
    hold = false;

    const text = getText();
    if (text === baseline) { markClean(); return true; }

    let outcome = true;
    saving = (async () => {
      let onDisk = null;
      try {
        onDisk = await bridge.readText(path);
      } catch (e) {
        let there = true;
        try { there = await bridge.exists(path); } catch { /* assume it is */ }
        if (!there) {
          readOnly = true;
          view.setReadOnly(true);
          toast(`${path} was deleted or moved on disk; nothing was written`, 'err', 9000);
          return;
        }
        throw e;
      }
      if (onDisk !== baseline) {
        const choice = await choose({
          title: 'Changed on disk',
          body: `${path} was modified by something else since it was opened here. `
            + 'Keep your version and overwrite the file, or reload the file and lose your edits?',
          options: [
            { label: 'Cancel', value: 'cancel' },
            { label: 'Reload from disk', value: 'reload' },
            { label: 'Keep mine', value: 'keep', kind: 'primary' },
          ],
          cancel: 'cancel',
        });
        emit('conflict', { path, choice: choice || 'cancel' });
        if (choice === 'reload') { baseline = onDisk; view.setText(onDisk); markClean(); return; }
        if (choice !== 'keep') { hold = true; outcome = false; return; }
        await keepDiskVersion(path, onDisk);
      }
      await writeOut(text);
    })();
    try {
      await saving;
    } catch (e) {
      console.error('[editor] save', e);
      toast(`save failed for ${path}: ${e && e.message ? e.message : e}`, 'err');
    } finally { saving = null; }
    return outcome;
  }

  async function writeOut(text) {
    await keepVersion(path, baseline, text);
    await bridge.writeText(path, text);
    baseline = text;
    markClean();
    if (typeof opts.onSave === 'function') { try { await opts.onSave(text); } catch (e) { console.error('[editor] onSave', e); } }
    emit('saved', { path, text });
  }

  return {
    get path() { return path; },
    get dirty() { return dirty; },
    get readOnly() { return readOnly; },
    get ready() { return ready; },
    getText,
    setText(text) { view.setText(String(text ?? '')); },
    setReadOnly(on) { readOnly = !!on; view.setReadOnly(readOnly); },
    save: (o) => save(o),
    focus: () => view.focus(),
    async close() {
      if (closed) return;
      closed = true;
      if (dirty) { try { await save({ explicit: true }); } catch (e) { console.error('[editor] close', e); } }
      view.destroy();
      if (host.parentNode) host.remove();
      emit('closed', { path });
    },
    on(event, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },
  };
}
