// `codeEditor(el, opts)` (docs/KERNEL.md `ose:editor`): CodeMirror as a component.
//
// The same editor source mode mounts, with two things added: a language from the CodeMirror
// language pack (the one the code-block feature uses, so a `python` block and a `.py` file are
// highlighted by the same rules), and, when it is given a `path`, the page editor's save: the
// file is read back before every write and must still be the text this editor was opened from,
// or the user decides what happens. With `text` instead of `path` nothing is read and nothing
// is written; `onSave` is handed the text and does what it likes.
//
// A plugin uses this for a script beside its data, the shell for a `.json` or a `.css` of its
// own; source mode inside a page stays where it is, in page.js, because it shares the page's
// title strip, baseline and conflict dialog. Both ask `createSourceView` for `code: true` and
// get exactly the same editor, so a `.py` file looks and behaves the same in either.
//
// `grow` makes the editor as tall as its text, so the column scrolls; it is described where
// it is built, below.

import { Prec, StateEffect } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { bridge } from './host.js';
import { choose, toast } from './deps.js';
import { describe, indentFor, loadLanguage } from './highlight.js';
import { createSourceView } from './source.js';
import { keepVersion, keepDiskVersion } from './versions.js';
import * as P from './paths.js';

/**
 * CodeMirror normalises every line ending to `\n` when it builds a document, so the text in
 * the buffer is never quite the bytes on disk in a CRLF file. Everything this file compares —
 * the baseline, the copy read back before a write — is normalised, and `eol` below remembers
 * what the file had so the write puts it back.
 */
const normalize = (s) => String(s ?? '').replace(/\r\n?/g, '\n');

/**
 * The ending a file is written with: the one most of its lines already had. A file that was
 * CRLF stays CRLF, because one keystroke in it used to rewrite every line in the file to LF —
 * a diff of the whole file for a one-character edit, and "a user edit must not reformat the
 * rest of the file" is not negotiable (CLAUDE.md; A, finding 6). A file with both kinds is
 * settled on its majority the first time it is written, which is the one case this cannot do
 * perfectly without tracking an ending per line; it is written down in docs/KERNEL.md.
 */
function endingOf(raw) {
  const all = (String(raw).match(/\n/g) || []).length;
  const crlf = (String(raw).match(/\r\n/g) || []).length;
  return crlf > all - crlf ? '\r\n' : '\n';
}

/**
 * @param {HTMLElement} el
 * @param {object} opts  { path | text, language, readOnly, onChange, onSave, gutter,
 *                         placeholder, indent, grow }
 */
export function codeEditor(el, opts = {}) {
  const path = opts.path ? String(opts.path) : null;
  const listeners = new Map();

  let baseline = path ? null : normalize(opts.text);
  let dirty = false;
  let readOnly = !!opts.readOnly;
  let closed = false;
  let saving = null;
  let hold = false;
  // True until the file is in. A path editor used to mount editable and empty — which is what
  // an empty file looks like — and the read then replaced whatever had been typed into it,
  // quietly, with `markClean()` on top (A, finding 5). It is read-only for the duration
  // instead: the user cannot lose what they cannot type.
  let loading = !!path;
  let eol = '\n';
  const onWire = (t) => (eol === '\n' ? t : t.replace(/\n/g, eol));

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
  // `grow: true` (round five): the editor is as tall as its text and the column around it
  // scrolls, the bargain source mode already makes with the page. The default is the round-four
  // shape — fill the box, scroll inside it — so no caller changes meaning by standing still.
  host.className = 'ed-code' + (opts.grow ? ' ed-code-grow' : '');
  el.append(host);

  // Ctrl+S for the whole editor and not only for its text.
  //
  // CodeMirror binds its keymap on `.cm-content`. The search panel is a sibling of the
  // scroller, not a child of the content, so a chord typed in the Find field reaches no keymap
  // at all — and since the shell now stands down for everything inside `.ed-code`
  // (`OWN_EDITOR_KEYS` in keys.js), Ctrl+S there meant nothing whatsoever and the browser's own
  // Save dialog came up over the app (A, finding 10). The host catches what falls through.
  // `defaultPrevented` is the test for "CodeMirror already has it": the `Mod-s` binding below
  // is declared `preventDefault: true`, so a Ctrl+S with the caret in the text never reaches
  // this and the file is never written twice.
  host.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (e.key !== 's' && e.key !== 'S') return;
    if (e.altKey || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    void save({ explicit: true });
  });

  /**
   * Escape with no search panel open: leave the text and put the keyboard back on the page
   * around it. Tab inside CodeMirror is the indent unit and Escape used to do nothing here, so
   * the only way out of a plugin's code editor was a command — a keyboard trap in an app whose
   * rule is that nothing needs the mouse. The nearest page container takes the focus so the
   * next Tab starts from the page, not from the top of the window; Escape with the search
   * panel open still closes the panel first (`source.js`).
   */
  function leaveEditor() {
    try { view.view.contentDOM.blur(); } catch { /* already gone */ }
    const home = host.closest('.page-col') || host.closest('.view-root') || host.closest('.page-host');
    if (!home) return;
    if (!home.hasAttribute('tabindex')) home.tabIndex = -1;
    home.focus({ preventScroll: true });
  }

  // `.md` is the one language the pack does not have to load: source mode's own markdown mode
  // is already in the bundle, and `createSourceView` installs it.
  const isMarkdown = !!path && P.extname(path) === 'md' && !opts.language;
  const named = describe(opts.language, path);
  const indent = opts.indent || indentFor(named);
  const view = createSourceView({
    host,
    text: baseline ?? '',
    markdown: isMarkdown,
    code: !isMarkdown,
    gutter: opts.gutter !== false,
    placeholder: opts.placeholder,
    indent,
    readOnly: readOnly || loading,
    onChange: () => {
      markDirty();
      if (typeof opts.onChange === 'function') { try { opts.onChange(getText()); } catch (e) { console.error('[editor] onChange', e); } }
    },
    onEscape: leaveEditor,
  });

  // The grammar, the token colours and the comforts of a program are `code: true` above: they
  // are the same in a code file open as a page and here, and they live in one place so they
  // cannot differ (`ide()` in source.js). What is only this editor's is Ctrl+S.
  //
  // Ctrl+S here as well as in the shell: a code editor inside a dialog or a plugin's panel is
  // not always under a chord the shell bound (docs/KERNEL.md, keyboard reachable every time).
  // `keys.js` binds `mod+s` on `window` in the capture phase, so the shell's `page.save` would
  // otherwise take it first and nothing inside CodeMirror could outrank a listener that runs
  // before the event ever descends. The exemption belongs in the key engine rather than here,
  // and that is where it is: `OWN_EDITOR_KEYS` stands down for `mod+s` and `mod+f` inside
  // `.ed-code`. `Prec.high` because `appendConfig` puts this *after* the view's own keymap.
  view.view.dispatch({
    effects: StateEffect.appendConfig.of(Prec.high(keymap.of([
      { key: 'Mod-s', run: () => { void save({ explicit: true }); return true; }, preventDefault: true },
    ]))),
  });

  const getText = () => view.getText();

  /** The grammar, fetched once, after the editor is already on screen. */
  const loaded = loadLanguage(named).then((support) => {
    if (support && !closed) view.setLanguage(support);
  });

  const ready = (async () => {
    if (!path) { await loaded; return; }
    let raw = '';
    try {
      raw = await bridge.readText(path);
    } catch (e) {
      toast(`cannot open ${path}: ${e && e.message ? e.message : e}`, 'err');
      baseline = null;
      loading = false;
      readOnly = true;
      view.setReadOnly(true);
      return;
    }
    if (closed) return;
    eol = endingOf(raw);
    baseline = normalize(raw);
    // Something may be in the buffer already. The view is read-only to the keyboard for the
    // whole read, so it is not a keystroke — it is a caller's own `setText`, or a bench
    // dispatching past the DOM — but whichever it is, it is text that exists in exactly one
    // place and the file that has just arrived is on disk. Keep it, and let the editor be
    // dirty against the file: the next save asks the changed-on-disk question if it must.
    // The load used to replace it and call `markClean()` on top (A, finding 5).
    const already = getText();
    if (already && already !== baseline) markDirty();
    // `history: 'drop'`: putting the file into the buffer is not an edit and must leave no
    // undo step behind it, or Ctrl+Z walks back into the empty buffer the editor mounted with
    // and the next save writes that to disk (A, finding 1).
    else view.setText(baseline, { history: 'drop' });
    view.clearHistory();
    loading = false;
    view.setReadOnly(readOnly);
    await loaded;
  })();

  /**
   * Write, with the page editor's three guards (B1, C18): never a file the user has not
   * changed, never over a file that moved under us without asking, and never a file that is
   * no longer there.
   *
   * **Resolves true when there is nothing left unwritten**, and false whenever text the user
   * typed is still only in this editor. The old wording was "true when the caller may move
   * on", and four different paths answered true having written nothing: a conflict the user
   * had cancelled, a read-only editor holding changes, an editor whose file never loaded, and
   * a write that finished after the user had typed again. A caller that closes its panel when
   * `save()` resolves truthy — the obvious reading — threw the text away (A, findings 2, 8).
   * The rule now has one sentence and `close()` below relies on it.
   */
  async function save(o = {}) {
    if (!path) {
      if (typeof opts.onSave === 'function') { try { await opts.onSave(getText()); } catch (e) { console.error('[editor] onSave', e); } }
      markClean();
      emit('saved', { path: null, text: getText() });
      return true;
    }
    if (!dirty) return true;
    // Dirty and unwritable: the text is only here, and saying otherwise is the lie that loses
    // it. A deleted file no longer lands here — it keeps its buffer editable (finding 7).
    if (readOnly || baseline === null) return false;
    if (saving) { await saving; return !dirty; }
    if (hold && !o.explicit) return false;
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
          // The file went away under a dirty editor. What is in the buffer is now the only
          // copy of it anywhere, and the old answer — freeze the editor read-only and toast —
          // put that copy out of the user's reach: `close()` saves nothing on a read-only
          // editor, so the text went with the view (A, finding 7). Ask instead, and whichever
          // way it is answered the buffer stays editable and stays dirty.
          const choice = await choose({
            title: 'No longer there',
            body: `${path} has been deleted or moved since it was opened here. `
              + 'Write it again with what is in the editor, or keep the text here and decide later?',
            // Shaped like the changed-on-disk dialog above: Cancel first, where the focus
            // lands and where Esc resolves, the action last.
            options: [
              { label: 'Cancel', value: 'hold' },
              { label: 'Write it again', value: 'write', kind: 'primary' },
            ],
            cancel: 'hold',
          });
          if (choice === 'write') { await writeOut(text); return; }
          hold = true;
          outcome = false;
          toast(`${path} is not on disk; nothing was written and your text is still here`, 'warn', 9000);
          return;
        }
        throw e;
      }
      if (normalize(onDisk) !== baseline) {
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
        if (choice === 'reload') {
          eol = endingOf(onDisk);
          baseline = normalize(onDisk);
          // An ordinary edit, isolated: the user just agreed to lose their version, and one
          // Ctrl+Z gives it back rather than landing somewhere in the middle of their typing
          // (A, finding 12).
          view.setText(baseline);
          markClean();
          return;
        }
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
    // A keystroke that landed during the write leaves the editor dirty (writeOut below). An
    // explicit save means "put what is here on disk", so it goes round once more rather than
    // leaving the user's last word in no file. Once, not a loop: if they are still typing, the
    // save after this one gets it, and `dirty` stays true until something does.
    if (outcome && dirty && o.explicit && !o.again) return save({ ...o, again: true });
    return outcome && !dirty;
  }

  async function writeOut(text) {
    await keepVersion(path, baseline, text);
    await bridge.writeText(path, onWire(text));
    baseline = text;
    // Not `markClean()` outright. There are two awaits above, and a keystroke that landed
    // during them is in the buffer and in no file: saying "clean" then left it there, because
    // `close()` only saves a dirty editor, so it went to the bin with the view (A, finding 2).
    // The editor stays dirty and the next save — `close()`'s included — writes what is there.
    if (getText() === text) markClean();
    if (typeof opts.onSave === 'function') { try { await opts.onSave(text); } catch (e) { console.error('[editor] onSave', e); } }
    emit('saved', { path, text });
  }

  return {
    get path() { return path; },
    get dirty() { return dirty; },
    get readOnly() { return readOnly; },
    get ready() { return ready; },
    getText,
    /**
     * A `setText` from outside is an edit: the caller means the buffer to hold this and, for a
     * path editor, the next `save()` to write it. It used to go in without marking the editor
     * dirty, so `save()` short-circuited on `if (!dirty)` and answered true having written
     * nothing — and the Informatique plugin seeds a student's empty answer file exactly this
     * way, then submits it to the judge.
     */
    setText(text) { if (view.setText(String(text ?? ''))) markDirty(); },
    setReadOnly(on) {
      readOnly = !!on;
      // While the file is still being read the view stays read-only whatever the caller says;
      // the load lifts it to whatever `readOnly` is by then (finding 5).
      if (!loading) view.setReadOnly(readOnly);
    },
    save: (o) => save(o),
    focus: () => view.focus(),
    /**
     * Close, and never lose text doing it.
     *
     * `close()` saves once, and when the save could not happen it asks before tearing the view
     * down, answering **false** when the user chose to keep editing — the editor is then still
     * mounted and still theirs. It used to throw `save()`'s answer away and destroy the view
     * regardless, so cancelling the changed-on-disk dialog and then closing lost the text
     * (A, finding 3).
     *
     * A conflict the user has already cancelled is not put back up here: they answered that
     * question, and asking it again for permission to close is a dialog for nothing
     * (A, finding 9). What is asked instead is the question closing actually raises.
     *
     * `{ force: true }` closes whatever the state, for a caller that is going away regardless.
     */
    async close(o = {}) {
      if (closed) return true;
      if (dirty && !o.force) {
        let ok = true;
        try { ok = hold ? false : await save({ explicit: true }); }
        catch (e) { console.error('[editor] close', e); ok = false; }
        if (!ok && dirty) {
          const choice = await choose({
            title: 'Not saved',
            body: `${path || 'This editor'} could not be written, so the changes are only here. `
              + 'Keep the editor open and deal with it, or close it and lose them?',
            // Cancel first and Esc resolving to it, like every other dialog in the app: the
            // safe answer is the one you reach without reading. This is a different question
            // from the changed-on-disk one and says so in its title — closing must not put
            // that question back up (A, finding 9).
            options: [
              { label: 'Cancel', value: 'keep' },
              { label: 'Close and lose the changes', value: 'discard', kind: 'danger' },
            ],
            cancel: 'keep',
          });
          if (choice !== 'discard') return false;
        }
      }
      closed = true;
      view.destroy();
      if (host.parentNode) host.remove();
      emit('closed', { path });
      return true;
    },
    on(event, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },
  };
}
