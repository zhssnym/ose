// Part of the markdown page (../page.ts). The page commands, and paper.

import { collectCommands, commands, defaultNewFolder, fileops, navigate } from '../host.ts';
import { toast } from '../deps.ts';
import { activeInstance } from '../instances.ts';
import { registerExtensionCommands } from '../extensions.ts';
import * as P from '../paths.ts';
import { activeApi, activeInst, errText } from './shared.ts';

// ---------------------------------------------------------------------------
// the commands
//
// Registered when the first page mounts and removed when the last one closes, plus one
// reference `holdPageCommands()` holds for the shell, so `page.new` is there with no page open.

let cmdRefs = 0;
let dropCommands: (() => void) | null = null;

const hasPage = () => !!(activeInstance() && activeInstance().api.hasPage());
const pageStatus = () => (activeInstance() ? activeInstance().api.status() : 'clean');

/**
 * What the extension modules (extensions.ts) get of the open page. Accessors, never the object
 * itself, because the page is replaced on every open and the *instance* is replaced when the
 * focus moves. They go through this and do not import page.ts, so the graph stays a tree.
 */
const editorApi: Record<string, any> = {};
for (const name of [
  'hasPage', 'getPage', 'getView', 'getCrepe', 'getPath', 'getDoc', 'focusTitle', 'focusBody',
  'markDirty', 'touch', 'saveNow', 'getSelection', 'updateMeta', 'reopenInPlace', 'attachFile',
  'openFind', 'isSource', 'isMarkdown', 'toggleSource', 'setMode', 'hasCrepe', 'isReadOnly', 'folder',
  'isLive', 'nextMode', 'mode', 'liveRun', 'isReading', 'toggleReading', 'isOutside', 'encoding',
  'saveUtf8', 'reopenEncoding', 'isReadOnlyFile',
  'copyMarkdown', 'link', 'outline', 'find', 'reveal', 'status', 'isDirty', 'hasRecovered',
  'recoveredApplied', 'saveAs', 'discardChanges', 'showProblem', 'recoveredCompare', 'recoveredRestore',
  'hasConflict', 'conflictIsText', 'conflictCanTake', 'hasMerge', 'canUndoMerge', 'mergeResolve', 'mergeKeepMine',
  'mergeTakeTheirs', 'mergeUndo', 'mergeShow',
]) {
  editorApi[name] = (...args) => {
    const a = activeApi();
    if (!a) {
      if (name === 'saveNow') return Promise.resolve(true);
      return ['hasPage', 'isSource', 'isMarkdown', 'hasCrepe', 'isDirty', 'hasRecovered', 'recoveredApplied',
        'hasConflict', 'conflictIsText', 'conflictCanTake', 'hasMerge', 'canUndoMerge', 'isLive', 'isReading', 'isOutside',
        'isReadOnlyFile', 'liveRun'].includes(name)
        ? false : undefined;
    }
    return a[name](...args);
  };
}

export function acquireCommands() {
  if (cmdRefs++ > 0) return releaseCommands;
  dropCommands = collectCommands(() => registerCommands());
  return releaseCommands;
}

export function releaseCommands() {
  if (cmdRefs === 0) return;
  if (--cmdRefs > 0) return;
  if (dropCommands) dropCommands();
  dropCommands = null;
}

function registerCommands() {
  registerExtensionCommands(editorApi);
  commands.register({
    id: 'page.new', title: 'New page', group: 'page', shortcut: 'Ctrl+N',
    run: () => newPage(),
  });
  // C5: the promise is the answer. Ctrl+S, the banner's Try again and the leave gate all wait
  // on it, and it is true only when the disk holds the page.
  commands.register({
    id: 'page.save', title: 'Save page', group: 'page', shortcut: 'Ctrl+S',
    when: hasPage, run: () => editorApi.saveNow({ explicit: true }),
  });
  commands.register({
    id: 'page.save-as', title: 'Save as…', group: 'page',
    when: hasPage, run: () => editorApi.saveAs(),
  });
  commands.register({
    id: 'page.discard-changes', title: 'Discard unsaved changes', group: 'page',
    when: () => hasPage() && (editorApi.isDirty() || editorApi.hasRecovered()),
    run: () => editorApi.discardChanges(),
  });
  commands.register({
    id: 'page.show-problem', title: 'Show why the page is not saved', group: 'page',
    when: () => hasPage() && ['not-saved', 'conflict', 'deleted'].includes(pageStatus()),
    run: () => editorApi.showProblem(),
  });
  commands.register({
    id: 'page.recovered-compare', title: 'Compare recovered changes', group: 'page',
    when: () => hasPage() && editorApi.hasRecovered(),
    run: () => editorApi.recoveredCompare(),
  });
  commands.register({
    id: 'page.recovered-restore', title: 'Restore recovered changes', group: 'page',
    when: () => hasPage() && editorApi.hasRecovered() && !editorApi.recoveredApplied(),
    run: () => editorApi.recoveredRestore(),
  });
  // H7: a change made on disk. The banner's buttons run these, and so does the palette.
  commands.register({
    id: 'page.merge-resolve', title: 'Resolve changes made on disk', group: 'page',
    when: () => hasPage() && editorApi.hasConflict() && editorApi.conflictIsText(),
    run: () => editorApi.mergeResolve(),
  });
  commands.register({
    id: 'page.merge-keep-mine', title: 'Keep my version (overwrite the file on disk)', group: 'page',
    when: () => hasPage() && editorApi.hasConflict(),
    run: () => editorApi.mergeKeepMine(),
  });
  commands.register({
    id: 'page.merge-take-theirs', title: 'Take the version on disk', group: 'page',
    when: () => hasPage() && editorApi.hasConflict() && editorApi.conflictCanTake(),
    run: () => editorApi.mergeTakeTheirs(),
  });
  commands.register({
    id: 'page.merge-undo', title: 'Undo merge', group: 'page',
    when: () => hasPage() && editorApi.canUndoMerge(),
    run: () => editorApi.mergeUndo(),
  });
  commands.register({
    id: 'page.merge-show', title: 'Show changes merged from disk', group: 'page',
    when: () => hasPage() && editorApi.hasMerge(),
    run: () => editorApi.mergeShow(),
  });
  // X1, §4.5: the three modes, one command each, and the status field's click. No chords:
  // Ctrl+E (source.ts) is the one the editor has, Source and back.
  const markdownPage = () => hasPage() && editorApi.isMarkdown();
  for (const [mode, title] of [['rich', 'Edit as rich text'], ['live', 'Edit in Live preview'], ['source', 'Edit as source']]) {
    commands.register({
      id: `page.mode-${mode}`, title, group: 'page',
      when: () => markdownPage() && editorApi.mode() !== mode,
      run: () => editorApi.setMode(mode),
    });
  }
  commands.register({
    id: 'page.mode-next', title: 'Next editing mode', group: 'page',
    when: markdownPage, run: () => editorApi.nextMode(),
  });
  // X3: the buffer rendered, read-only; the same command comes back.
  commands.register({
    id: 'page.reading-toggle', title: 'Reading view', group: 'page',
    when: markdownPage, run: () => editorApi.toggleReading(),
  });
  // X10: a file that is not UTF-8.
  commands.register({
    id: 'page.save-utf8', title: 'Save as UTF-8', group: 'page',
    when: () => hasPage() && !!editorApi.encoding() && !/^utf-?8$/i.test(String(editorApi.encoding())),
    run: () => editorApi.saveUtf8(),
  });
  commands.register({
    id: 'page.reopen-encoding', title: 'Reopen with encoding…', group: 'page',
    when: hasPage, run: () => editorApi.reopenEncoding(),
  });
  commands.register({
    id: 'page.reveal', title: 'Reveal in Explorer', group: 'page',
    when: hasPage, run: () => editorApi.reveal(),
  });
  commands.register({
    id: 'page.link', title: 'Link a page', group: 'page',
    when: hasPage, run: () => void editorApi.link(),
  });
  commands.register({
    id: 'page.copy-markdown', title: 'Copy as markdown', group: 'page',
    when: hasPage, run: () => editorApi.copyMarkdown(),
  });
  commands.register({
    id: 'page.export-pdf', title: 'Export to PDF', group: 'page',
    when: hasPage, run: () => void exportPdf(),
  });
  commands.register({
    id: 'page.print', title: 'Print', group: 'page',
    when: hasPage, run: () => void printPage(),
  });
  // The chords are the core's (keys.js): Ctrl+F for find, the outline's is its choice.
  commands.register({
    id: 'page.find', title: 'Find in page', group: 'page',
    when: hasPage, run: () => editorApi.find(),
  });
  // The heading picker reads the ProseMirror document, so it is the block editor's alone.
  commands.register({
    id: 'page.outline', title: 'Go to heading', group: 'page',
    when: () => !!(activeInstance() && activeInstance().api.hasCrepe()), run: () => void editorApi.outline(),
  });
}

/**
 * `page.new` (Ctrl+N, M28): `Untitled.md` in the folder the user is in
 * (`ose.focus.defaultNewFolder()`: the focused folder, else the folder on screen or the open
 * page's, else the vault root), created through the one create there is (`ose.fileops`, never
 * an overwrite). The title is selected. With `titleSync` on, the name typed there becomes the
 * file's name when the title is left (C12, M13); otherwise the file keeps its name.
 */
async function newPage() {
  const ops = fileops();
  if (!ops || typeof ops.create !== 'function') { toast('could not create the page: this core has no file operations', 'err'); return false; }
  let folder = '';
  try { folder = defaultNewFolder() || ''; } catch { folder = ''; }
  let path;
  try {
    ({ path } = await ops.create(folder, 'Untitled.md', { text: '# Untitled\n', unique: true }));
  } catch (e) {
    toast('could not create the page: ' + errText(e), 'err');
    return false;
  }
  const went = await navigate({ type: 'page', path });
  if (went === false) return false;
  // The router mounts asynchronously; select the title once it is there. L21: not forever —
  // a page that never mounts (refused, failed) stops the search after two seconds.
  let tries = 0;
  const selectNewTitle = () => {
    const inst = activeInst();
    const titleEl = inst && inst.path() === path ? inst.titleEl() : null;
    if (!titleEl) { if (++tries < 50) setTimeout(selectNewTitle, 40); return; }
    titleEl.focus();
    const r = document.createRange();
    r.selectNodeContents(titleEl);
    const sel = getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(r); }
  };
  setTimeout(selectNewTitle, 40);
  return true;
}

// ---------------------------------------------------------------------------
// paper
//
// Two commands, and both are Chrome's print dialog: `Print`, and `Export to PDF` (Ctrl+Shift+P),
// which is the same dialog with the page's own title as the document's, so the file Chrome's
// Save as PDF suggests is named after the page, never after the window ("Family · lifeos": the
// vault's name is nobody's business but his).
//
// Neither touches the theme. The sheet is black on white from either theme because print.css
// says so under `@media print`. `window.print()` returns when the dialog closes.

/** `Export to PDF`: the print dialog, titled after the page, for Save as PDF. */
function exportPdf() {
  if (!hasPage()) return;
  const path = editorApi.getPath();
  const inst = activeInst();
  const titled = inst && inst.titleEl() ? inst.titleEl().textContent.trim() : '';
  const name = titled || P.stem(path || '') || 'page';
  const windowTitle = document.title;
  document.title = name;
  try {
    window.print();
  } catch (e) {
    toast('could not export: ' + ((e && typeof e === 'object' && 'message' in e && e.message) || e), 'err');
  } finally {
    document.title = windowTitle;
  }
}

/** `Print`: the print dialog. */
function printPage() {
  if (!hasPage()) return;
  try { window.print(); } catch (e) { toast('could not print: ' + ((e && typeof e === 'object' && 'message' in e && e.message) || e), 'err'); }
}

/** The page the commands act on, for whoever needs to ask (the compatibility layer). */
export function activePage() { return activeInstance() ? activeInstance().handle : null; }
