// `codeEditor(el, opts)` (docs/KERNEL.md `ose:editor`): CodeMirror as a component.
//
// The same editor source mode mounts, with two things added: a language from the CodeMirror
// language pack (the one the code-block feature uses, so a `python` block and a `.py` file are
// highlighted by the same rules), and, when it is given a `path`, the page editor's save: one
// host call that compares and writes against the hash of the text this editor was opened from
// (`saveFile`), so a file that moved under it is never written over without the user deciding.
// With `text` instead of `path` nothing is read and nothing is written; `onSave` is handed the
// text and does what it likes.
//
// A path editor keeps the page's promises about text that is not on disk (wave 2): a draft of
// the buffer goes to this machine's app-data folder while it is dirty (C4, `ose.files.drafts`),
// the next open of the file offers it back, and the window's leave gate (`ose.window.onLeave`,
// C5) waits for the save or refuses to let the window go. The host keeps the replaced bytes as
// a version on every save, so this file keeps none of its own any more.
//
// Source mode inside a page stays where it is, in page.js, because it shares the page's title
// strip, baseline and merge. Both ask `createSourceView` for `code: true` and get exactly the
// same editor, so a `.py` file looks and behaves the same in either.
//
// `grow` makes the editor as tall as its text, so the column scrolls; it is described where
// it is built, below.

import { Prec, StateEffect } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { log, onWindowLeave, pageFiles } from './host.js';
import { choose, toast } from './deps.js';
import { describe, indentFor, loadLanguage } from './highlight.js';
import { createSourceView } from './source.js';
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

/** A draft follows an edit this long after it (C4). */
const DRAFT_DELAY = 1000;

/**
 * The edit counter of every code editor, one clock started when the bundle loaded, so a later
 * edit always has a higher number than a draft an earlier session left: `drafts.drop(path,
 * {ifRev})` then never keeps a stale one (the page editor keeps its own, in page.js).
 */
let revClock = Date.now();

/**
 * The next edit's revision: after every one before it, and never behind the wall clock, so a
 * draft's `ifRev` compares across windows too (the draft of a file outside the vault is shared
 * by every window that has it open).
 */
const nextRev = () => { revClock = Math.max(revClock + 1, Date.now()); return revClock; };

const errText = (e) => String((e && e.message) || e || 'unknown error').split('\n')[0];
const errCode = (e) => (e && e.code) || 'io';

/** `14:02` today, `9 Sep 14:02` another day: when a draft was written. */
function whenLabel(at) {
  const d = new Date(Number(at) || Date.now());
  const time = P.hhmm(d);
  const same = new Date().toDateString() === d.toDateString();
  return same ? time : `${d.toLocaleDateString('en', { day: 'numeric', month: 'short' })} ${time}`;
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
  // The host's hash of the bytes the baseline came from (wave 1, M2): every save is one
  // `saveFile` call that compares and writes under the host's lock against it.
  let diskHash = null;
  // The encoding the file was read in (X10): every save writes back in it, so a file that is
  // not UTF-8 is never rewritten as UTF-8 behind the user's back. A lossy read opens read-only.
  let encoding = 'UTF-8';
  let lossy = false;
  // Drafts (C4). rev: the edit clock at the last edit; hasDraft: one may be stored for this
  // path; draftChain: the writes and drops one after the other, so a drop issued after a write
  // never reaches the host first.
  let rev = 0;
  let hasDraft = false;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let draftTimer = 0;
  let draftChain = Promise.resolve();
  const onWire = (t) => (eol === '\n' ? t : t.replace(/\n/g, eol));

  const emit = (event, payload) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[editor:${event}]`, e); }
    }
  };

  const markDirty = () => {
    rev = nextRev();
    scheduleDraft();
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
   * the only way out of an embedded code editor was a command — a keyboard trap in an app whose
   * rule is that nothing needs the mouse. The nearest page container takes the focus so the
   * next Tab starts from the page, not from the top of the window; Escape with the search
   * panel open still closes the panel first (`source.js`).
   */
  function leaveEditor() {
    try { view.view.contentDOM.blur(); } catch { /* already gone */ }
    /** @type {HTMLElement|null} */
    const home = host.closest('.page-col') || host.closest('.view-root') || host.closest('.page-host');
    if (!home) return;
    if (!home.hasAttribute('tabindex')) home.tabIndex = -1;
    home.focus({ preventScroll: true });
  }

  // `.md` is the one language the pack does not have to load: source mode's own markdown mode
  // is already in the bundle, and `createSourceView` installs it.
  const isMarkdown = !!path && P.isMarkdown(path) && !opts.language;
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
  // Ctrl+S here as well as in the shell: a code editor inside a dialog or a panel is not always
  // under a chord the shell bound (docs/KERNEL.md, keyboard reachable every time). `keys.js`
  // binds `mod+s` on `window` in the capture phase, so the shell's `page.save` would otherwise
  // take it first and nothing inside CodeMirror could outrank a listener that runs before the
  // event ever descends. The exemption belongs in the key engine rather than here, and that is
  // where it is: `OWN_EDITOR_KEYS` stands down for `mod+s` and `mod+f` inside `.ed-code`.
  // `Prec.high` because `appendConfig` puts this *after* the view's own keymap.
  view.view.dispatch({
    effects: StateEffect.appendConfig.of(Prec.high(keymap.of([
      { key: 'Mod-s', run: () => { void save({ explicit: true }); return true; }, preventDefault: true },
    ]))),
  });

  const getText = () => view.getText();

  // -------------------------------------------------------------------------
  // drafts (C4)

  /** One draft write or drop after the other; `fn` runs whether the one before it failed or not. */
  function draftOp(fn) {
    const next = draftChain.then(fn, fn);
    draftChain = next.catch(() => {});
    return next;
  }

  function scheduleDraft() {
    // At most one draft a second while typing: a pending one takes the newer text with it.
    if (!path || loading || draftTimer) return;
    draftTimer = setTimeout(() => { draftTimer = 0; void writeDraft(); }, DRAFT_DELAY);
  }

  /**
   * The buffer, as the file would hold it, into this machine's draft store. Only for a path
   * editor whose file loaded, and only while there is something the disk does not hold.
   * Never throws.
   */
  function writeDraft() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    if (!path || !dirty || loading || closed || baseline === null) return Promise.resolve();
    /** @type {import('./host.js').Draft} */
    const draft = { path, text: onWire(getText()), baselineHash: diskHash, mode: 'source', exact: true, rev };
    hasDraft = true;
    return draftOp(async () => {
      try {
        await pageFiles.drafts.write(path, draft);
      } catch (e) {
        log(`draft failed ${path}: ${errCode(e)} ${errText(e)}`, 'warn');
      }
    });
  }

  /** Drop the draft after a save that left the editor clean (`ifRev`: a newer draft stays). */
  function dropDraft(ifRev) {
    clearTimeout(draftTimer);
    draftTimer = 0;
    if (!path) return Promise.resolve();
    return draftOp(async () => {
      if (!hasDraft) return;
      try {
        const r = await pageFiles.drafts.drop(path, ifRev === undefined ? undefined : { ifRev });
        if (r && r.dropped === false && ifRev !== undefined) return;
        hasDraft = false;
      } catch (e) {
        log(`draft not dropped ${path}: ${errCode(e)} ${errText(e)}`, 'warn');
      }
    });
  }

  /**
   * At open: a draft this machine kept of the file. Applied when it was written over the text
   * on disk now (the buffer is then dirty, and the user saves it); when the file changed since,
   * it is kept as a version instead and the user is told where. Never throws.
   */
  async function recoverDraft(raw) {
    if (!path) return false;
    let d = null;
    try { d = await pageFiles.drafts.read(path); } catch (e) {
      log(`draft read failed ${path}: ${errCode(e)} ${errText(e)}`, 'warn');
      return false;
    }
    if (!d || typeof d.text !== 'string' || closed) return false;
    hasDraft = true;
    if (d.text === raw) { void dropDraft(); return false; }
    if (Number(d.rev) > revClock) revClock = Number(d.rev);
    const at = Number(d.at) || Date.now();
    if ((d.baselineHash ?? null) === diskHash) {
      view.setText(normalize(d.text));
      markDirty();
      log(`draft found ${path}: applied`, 'warn');
      emit('recovered', { path, at, applied: true });
      toast(`Unsaved changes to ${P.basename(path)} from ${whenLabel(at)} were recovered. Save to keep them.`, 'warn', 9000);
      return true;
    }
    // Typed over a text the disk no longer holds: not put in, but not lost either.
    let kept = false;
    try {
      await pageFiles.keepVersion(path, d.text, { force: true, reason: 'conflict' });
      kept = true;
    } catch (e) {
      log(`recovered draft not kept ${path}: ${errCode(e)} ${errText(e)}`, 'warn');
    }
    if (kept) void dropDraft();
    log(`draft found ${path}: offered, the file changed since`, 'warn');
    emit('recovered', { path, at, applied: false });
    toast(kept
      ? `Unsaved changes to ${P.basename(path)} from ${whenLabel(at)} could not be applied: the file changed since. They are kept in Versions.`
      : `Unsaved changes to ${P.basename(path)} from ${whenLabel(at)} could not be applied: the file changed since.`, 'warn', 0);
    return false;
  }

  /** The grammar, fetched once, after the editor is already on screen. */
  const loaded = loadLanguage(named).then((support) => {
    if (support && !closed) view.setLanguage(support);
  });

  const ready = (async () => {
    if (!path) { await loaded; return; }
    let raw = '';
    try {
      const r = await pageFiles.readFile(path);
      raw = r.text;
      diskHash = r.hash ?? null;
      encoding = typeof r.encoding === 'string' && r.encoding ? r.encoding : 'UTF-8';
      // A text that does not encode back to the same bytes is shown, never saved.
      lossy = r.lossy === true;
      if (lossy) readOnly = true;
    } catch (e) {
      toast(`cannot open ${path}: ${errText(e)}`, 'err');
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
    if (!dirty) await recoverDraft(raw);
    view.setReadOnly(readOnly);
    await loaded;
  })();

  /**
   * Write, with the page editor's guards (B1, C18): never a file the user has not changed,
   * never over a file that moved under us without asking, and never a file that is no longer
   * there without asking.
   *
   * **Resolves true when there is nothing left unwritten**, and false whenever text the user
   * typed is still only in this editor (and then in its draft). A caller that closes its panel
   * when `save()` resolves truthy — the obvious reading — must never throw text away
   * (A, findings 2, 8). `o.closing`: the window is going, so no question can be awaited; a
   * conflict answers false and the draft keeps the text.
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
    // it.
    if (readOnly || baseline === null) return false;
    if (saving) { await saving; return !dirty; }
    if (hold && !o.explicit) return false;
    if (hold && o.closing) return false;
    hold = false;

    const text = getText();
    if (text === baseline) { markClean(); void dropDraft(rev); return true; }

    let outcome = true;
    const at = rev;
    saving = compareAndWrite(text, o).then((ok) => { if (!ok) outcome = false; });
    try {
      await saving;
    } catch (e) {
      outcome = false;
      log(`save failed ${path}: ${errCode(e)} ${errText(e)}`, 'error');
      toast(`save failed for ${path}: ${errText(e)}`, 'err');
    } finally { saving = null; }
    if (!outcome || dirty) void writeDraft();
    else void dropDraft(at);
    // A keystroke that landed during the write leaves the editor dirty. An explicit save means
    // "put what is here on disk", so it goes round once more rather than leaving the user's
    // last word in no file. Once, not a loop: if they are still typing, the save after this
    // one gets it, and `dirty` stays true until something does.
    if (outcome && dirty && o.explicit && !o.again) return save({ ...o, again: true });
    return outcome && !dirty;
  }

  /**
   * The save itself (M2): one `saveFile` against the hash the baseline came from. A conflict
   * asks, and the answer is written against the hash of what the conflict showed, so an
   * outside write that lands while the dialog is up is a second conflict and never lost. True
   * when it wrote or the user took the disk text; false when the text is still only here.
   */
  async function compareAndWrite(text, o = {}) {
    if (!path) return false;
    let expectedHash = diskHash;
    /** @type {'save' | 'conflict' | 'none'} */
    let version = 'save';
    for (let round = 0; round < 3; round++) {
      const r = await pageFiles.save(path, onWire(text), { expectedHash, version, ...(/^utf-?8$/i.test(encoding) ? {} : { encoding }) });
      if (r && r.status === 'saved') {
        diskHash = r.hash ?? null;
        baseline = text;
        // A keystroke that landed during the await leaves the editor dirty.
        if (getText() === text) markClean();
        log(`save ok ${path}${r.unchanged ? ' (unchanged)' : ''}`, 'info');
        if (typeof opts.onSave === 'function') { try { await opts.onSave(text); } catch (e) { console.error('[editor] onSave', e); } }
        emit('saved', { path, text });
        return true;
      }
      if (!r || r.status !== 'conflict') throw Object.assign(new Error('the host gave no answer to the save'), { code: 'unknown_command' });
      log(`save conflict ${path}`, 'warn');
      // The window is going: a question cannot be awaited into it. The draft keeps the text.
      if (o.closing) { hold = true; return false; }
      const disk = r.disk || { exists: false, text: null, hash: null };
      if (!disk.exists) {
        const choice = await choose({
          title: 'No longer there',
          body: `${path} has been deleted or moved since it was opened here. `
            + 'Write it again with what is in the editor, or keep the text here and decide later?',
          options: [
            { label: 'Cancel', value: 'hold' },
            { label: 'Write it again', value: 'write', kind: 'primary' },
          ],
          cancel: 'hold',
        });
        if (choice !== 'write') {
          hold = true;
          toast(`${path} is not on disk; nothing was written and your text is still here`, 'warn', 9000);
          return false;
        }
        expectedHash = null;
        version = 'none';
        continue;
      }
      const canReload = typeof disk.text === 'string';
      const choice = await choose({
        title: 'Changed on disk',
        body: `${path} was modified by something else since it was opened here. `
          + (canReload
            ? 'Keep your version and overwrite the file, or reload the file and lose your edits? Whichever text loses is kept in Versions.'
            : 'Keep your version and overwrite the file? What is on disk is not text this editor can show.'),
        options: [
          { label: 'Cancel', value: 'cancel' },
          ...(canReload ? [{ label: 'Reload from disk', value: 'reload' }] : []),
          { label: 'Keep mine', value: 'keep', kind: 'primary' },
        ],
        cancel: 'cancel',
      });
      emit('conflict', { path, choice: choice || 'cancel' });
      if (choice === 'reload' && canReload) {
        // The buffer is kept as a version before it is let go.
        try { await pageFiles.keepVersion(path, onWire(text), { force: true, reason: 'reload' }); } catch (e) {
          log(`version not kept ${path}: ${errCode(e)} ${errText(e)}`, 'warn');
        }
        eol = endingOf(disk.text);
        baseline = normalize(disk.text);
        diskHash = disk.hash ?? null;
        // One undoable edit (A, finding 12).
        view.setText(baseline);
        markClean();
        void dropDraft();
        return true;
      }
      if (choice !== 'keep') { hold = true; return false; }
      // The host keeps the bytes being replaced as a `conflict` version.
      expectedHash = disk.hash;
      version = 'conflict';
    }
    hold = true;
    toast(`${path} keeps changing on disk; nothing was written and your text is still here`, 'warn', 9000);
    return false;
  }

  // -------------------------------------------------------------------------
  // the window (C5)

  // The leave gate: closing the window, reloading it and switching vaults wait for this
  // editor's save, and a save that does not land keeps the window, with the text in a draft.
  const offLeave = path ? onWindowLeave(async () => {
    if (closed || !dirty) return true;
    let ok = false;
    try { ok = await save({ explicit: true, closing: true }); } catch { ok = false; }
    if (!ok && dirty) await writeDraft();
    return ok || !dirty;
  }) : null;
  // A window that is hidden may be the last thing that happens to it (logout, a killed process).
  const onHidden = () => { if (document.visibilityState === 'hidden' && dirty) void writeDraft(); };
  const onUnload = () => { if (dirty) void writeDraft(); };
  if (path) {
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('beforeunload', onUnload);
  }
  const unwire = () => {
    try { if (typeof offLeave === 'function') offLeave(); } catch { /* already off */ }
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('beforeunload', onUnload);
    clearTimeout(draftTimer);
  };

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
     * nothing.
     */
    setText(text) { if (view.setText(String(text ?? ''))) markDirty(); },
    setReadOnly(on) {
      // A lossy read stays read-only, whatever the caller says.
      readOnly = !!on || lossy;
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
     * mounted and still theirs. Choosing to lose the changes drops the draft as well.
     *
     * A conflict the user has already cancelled is not put back up here: they answered that
     * question, and asking it again for permission to close is a dialog for nothing
     * (A, finding 9). What is asked instead is the question closing actually raises.
     *
     * `{ force: true }` closes whatever the state, for a caller that is going away regardless;
     * the draft of a dirty buffer stays on this machine and the next open offers it back.
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
          await dropDraft();
        }
      } else if (dirty && o.force) {
        await writeDraft();
      }
      closed = true;
      unwire();
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
