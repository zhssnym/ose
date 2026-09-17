// Task lines: the Obsidian Tasks syntax Hassan's todo file is written in. Day reads it today;
// it sits here because the format belongs to nobody in particular and a second plugin that
// wants a checkbox should not write the regexes again.
//
// It used to live in `ose:md`. With 1.0.0 the kernel keeps only helpers that know nothing about
// any particular file. Pure text in, data out; `toggleTaskLine` rewrites one line and returns
// it, it never touches a file.

// Obsidian Tasks markers. Written as escapes so the file survives any encoding.
export const TASK_MARK = {
  due: '\u{1F4C5}',        // calendar
  scheduled: '\u{23F3}',   // hourglass
  start: '\u{1F6EB}',      // departure
  done: '\u{2705}',        // check
  created: '\u{2795}',     // plus
  recur: '\u{1F501}',      // repeat
};
const PRIORITY = {
  '\u{1F53A}': 'highest',
  '\u{23EB}': 'high',
  '\u{1F53C}': 'medium',
  '\u{1F53D}': 'low',
  '\u{23EC}': 'lowest',
};
export const PRIORITY_RANK = { highest: 0, high: 1, medium: 2, none: 3, low: 4, lowest: 5 };

const MARK_CHARS = [...Object.values(TASK_MARK), ...Object.keys(PRIORITY)].join('');
const RE_FIRST_MARK = new RegExp(`[${MARK_CHARS}]`, 'u');
const RE_SCAN = new RegExp(`([${MARK_CHARS}])\\uFE0F?\\s*([^${MARK_CHARS}]*)`, 'gu');
const RE_TASK = /^(\s*)[-*]\s\[([ xX])\]\s+(.*)$/;

/**
 * One markdown line -> a task, or null. `text` keeps the wording without any marker.
 */
export function parseTaskLine(raw) {
  const m = RE_TASK.exec(raw);
  if (!m) return null;
  const [, indent, box, body] = m;
  const t = {
    done: box.toLowerCase() === 'x',
    indent: indent.length,
    text: body.trim(),
    due: null, scheduled: null, start: null, doneDate: null, created: null,
    priority: 'none', recurrence: null,
  };
  const first = body.search(RE_FIRST_MARK);
  if (first >= 0) {
    t.text = body.slice(0, first).trim();
    for (const [, mark, payload] of body.slice(first).matchAll(RE_SCAN)) {
      const val = payload.trim();
      if (mark in PRIORITY) { t.priority = PRIORITY[mark]; if (val) t.text = (t.text + ' ' + val).trim(); continue; }
      switch (mark) {
        case TASK_MARK.due: t.due = val.slice(0, 10) || null; break;
        case TASK_MARK.scheduled: t.scheduled = val.slice(0, 10) || null; break;
        case TASK_MARK.start: t.start = val.slice(0, 10) || null; break;
        case TASK_MARK.done: t.doneDate = val.slice(0, 10) || null; break;
        case TASK_MARK.created: t.created = val.slice(0, 10) || null; break;
        case TASK_MARK.recur: t.recurrence = val || null; break;
      }
    }
  }
  if (!t.text) t.text = body.trim();
  return t;
}

/** Every task line in a file. `line` is the 0-based index and `raw` the exact source line. */
export function parseTasks(text, path = '') {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = parseTaskLine(lines[i]);
    if (t) out.push({ ...t, path, line: i, raw: lines[i], id: `${path}:${i}` });
  }
  return out;
}

/** Flip `[ ]` <-> `[x]` on the exact source line, keeping every other marker in place. */
export function toggleTaskLine(raw, done, today) {
  if (done) {
    let out = raw.replace(/\[ \]/, '[x]');
    if (!out.includes(TASK_MARK.done)) out = out.replace(/\s*$/, '') + ` ${TASK_MARK.done} ${today}`;
    return out;
  }
  let out = raw.replace(/\[[xX]\]/, '[ ]');
  out = out.replace(new RegExp(`\\s*${TASK_MARK.done}\\uFE0F?\\s*\\d{4}-\\d{2}-\\d{2}`, 'u'), '');
  out = out.replace(new RegExp(`\\s*${TASK_MARK.done}\\uFE0F?`, 'u'), '');
  return out.replace(/\s+$/, '');
}
