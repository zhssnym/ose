// The Day view's task index over every todo file (M34). Read on demand and again when one of
// its files changes; no vault walk and no cache beyond the last read. The writes are one line
// each and never the whole file:
//   - a toggle is `ose.files.replaceLine(path, index, expected, next)`: the line is replaced
//     only if it still reads what was shown, and a conflict re-reads instead of writing (M31);
//   - a new task is `ose.files.appendLine(path, '- [ ] …')`: the host adds the line break the
//     file needs and touches nothing above it.

import { newTaskLine, parseTasks, toggleTaskLine } from './tasks.js';
import { ymd } from './dates.js';

/**
 * @param {object} ose
 * @returns {object} the index
 */
export function createTodoIndex(ose) {
  let paths = [];
  let files = [];            // [{ path, tasks, missing, error }]
  let stale = true;
  let reading = null;

  async function readOne(path) {
    try {
      const st = await ose.files.stat(path);
      if (!st || !st.exists) return { path, tasks: [], missing: true };
      const r = await ose.files.readFile(path);
      return { path, tasks: parseTasks(r.text, path), missing: false };
    } catch (e) {
      console.warn('[planner] todo read', path, e);
      return { path, tasks: [], missing: false, error: String((e && e.message) || e) };
    }
  }

  async function build() {
    const want = paths.slice();
    const next = await Promise.all(want.map(readOne));
    if (want.join('\n') === paths.join('\n')) { files = next; stale = false; }
    return files;
  }

  return {
    /** The files to read; a different list drops what was read. */
    setPaths(list) {
      const next = (list || []).slice();
      if (next.join('\n') === paths.join('\n')) return;
      paths = next;
      files = [];
      stale = true;
    },
    paths: () => paths,
    /** A change on disk under one of `paths`. */
    touches: (p) => !!p && paths.includes(p),
    markStale() { stale = true; },
    /** -> the files, read when stale; concurrent calls share one read. */
    load({ force = false } = {}) {
      if (reading) return reading;
      if (!stale && !force) return Promise.resolve(files);
      reading = build().finally(() => { reading = null; });
      return reading;
    },
    files: () => files,
    byId: (id) => files.flatMap((f) => f.tasks).find((t) => t.id === id) || null,

    /**
     * Flip a task, as it was drawn (`t.raw` is what the row showed, `t.line` where). -> 'ok', or
     * 'changed' when the line no longer read what was shown: nothing was written and the index
     * was re-read.
     */
    async toggle(t) {
      if (!t) { stale = true; await this.load({ force: true }); return 'changed'; }
      const next = toggleTaskLine(t.raw, !t.done, ymd(new Date()));
      // Line 0 of a file with a byte-order mark: the host compares it without the mark and
      // keeps the mark, as the task parser reads it (wave 3), so `t.raw` is the line as it is.
      const r = await ose.files.replaceLine(t.path, t.line, t.raw, next);
      stale = true;
      await this.load({ force: true });
      return r && r.status === 'replaced' ? 'ok' : 'changed';
    },

    /** One new task at the end of `path`. -> 'ok', or 'missing' when the file is not there. */
    async add(path, text) {
      const line = newTaskLine(text);
      if (!path || !line) return 'missing';
      const st = await ose.files.stat(path);
      if (!st || !st.exists) return 'missing';
      await ose.files.appendLine(path, line);
      stale = true;
      await this.load({ force: true });
      return 'ok';
    },
  };
}
