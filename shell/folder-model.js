// The folder view's model (docs/SHELL.md "The folder view", H15, M22). Pure: no DOM and no
// `ose:*`, so the tests import it as it is and the tree (shell/sidebar.js) sorts with the same
// rules the folder view does. One folder is sorted one way wherever it is drawn.
//
// An entry is the host's `Entry` (docs/HOST.md `list`): `{ name, path, kind, ext, mtime, size,
// hidden, link?, readable? }`. `ext` is lower case without the dot, `mtime` is milliseconds.
//
// The per-folder sort lives in `ose.local('folders')` as `{ [path]: { key, dir } }`, one entry
// per folder that is not sorted the default way; `sortSpecFor` reads it and `withSortSpec`
// answers the next object to store. The vault root is the key `''`.

/** The columns a folder can be sorted by. */
export const SORT_KEYS = ['name', 'modified', 'size', 'type'];

/** What a folder nobody has sorted is sorted by. */
export const DEFAULT_SORT = Object.freeze({ key: 'name', dir: 'asc' });

/**
 * Names the way a person reads them: `2 notes` before `10 notes`, `é` beside `e`, case not a
 * sort key. One instance, shared by every comparison in the shell.
 */
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'tif', 'tiff', 'heic']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
const pad = (n) => String(n).padStart(2, '0');
const isDir = (e) => !!e && e.kind === 'dir';

/** An entry's extension: the host's field, else the name's (a dotfile has none). */
function extOf(entry) {
  if (!entry) return '';
  if (typeof entry.ext === 'string' && entry.ext) return entry.ext.toLowerCase();
  const name = String(entry.name || '');
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** A file's name as two keys, stem then extension, so `notes.md` comes before `notes 2.md`. */
function nameKeys(e) {
  const name = String(e.name || '');
  const i = isDir(e) ? -1 : name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [name, ''];
}

const byName = (a, b) => {
  const [sa, xa] = nameKeys(a);
  const [sb, xb] = nameKeys(b);
  const c = collator.compare(sa, sb) || collator.compare(xa, xb);
  if (c) return c;
  // `Notes.md` and `notes.md` are one name to the collator; the code points decide, so the
  // order is the same on every draw.
  const x = String(a.name || ''), y = String(b.name || '');
  return x < y ? -1 : x > y ? 1 : 0;
};

/** A spec the model can use: a known key and a known direction, else the default. */
function normSpec(spec) {
  const key = spec && SORT_KEYS.includes(spec.key) ? spec.key : DEFAULT_SORT.key;
  const dir = spec && (spec.dir === 'asc' || spec.dir === 'desc') ? spec.dir : DEFAULT_SORT.dir;
  return { key, dir };
}

/**
 * Two entries in a folder's order. Folders always come before files, whatever the key and the
 * direction; within each group the key decides and the direction flips it; a tie on the key is
 * broken by the name, ascending, so equal dates or sizes never shuffle between draws.
 * @param {object} a
 * @param {object} b
 * @param {{key: string, dir: 'asc'|'desc'}} [spec]
 * @returns {number}
 */
export function compareEntries(a, b, spec = DEFAULT_SORT) {
  const da = isDir(a), db = isDir(b);
  if (da !== db) return da ? -1 : 1;
  const { key, dir } = normSpec(spec);
  const sign = dir === 'desc' ? -1 : 1;
  let c = 0;
  if (key === 'name') return sign * byName(a, b);
  if (key === 'modified') c = (+a.mtime || 0) - (+b.mtime || 0);
  else if (key === 'size') c = (+a.size || 0) - (+b.size || 0);
  else if (key === 'type') c = collator.compare(typeLabel(a), typeLabel(b));
  if (c) return sign * (c < 0 ? -1 : 1);
  return byName(a, b);
}

/**
 * A folder's entries in order, as a new array; the input is left as it was.
 * @param {object[]} entries
 * @param {{key: string, dir: 'asc'|'desc'}} [spec]
 * @returns {object[]}
 */
export function sortEntries(entries, spec = DEFAULT_SORT) {
  const s = normSpec(spec);
  return (Array.isArray(entries) ? entries.slice() : []).sort((a, b) => compareEntries(a, b, s));
}

/**
 * What is drawn: every entry, less the hidden ones unless Show hidden items is on (H16). The
 * host has already left out what is never shown (`.ose`, `.git`, the exe); `hidden` is only a
 * dotfile or the OS's hidden attribute.
 * @param {object[]} entries
 * @param {{showHidden?: boolean}} [opts]
 * @returns {object[]}
 */
export function visibleEntries(entries, { showHidden = false } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  return showHidden ? list.slice() : list.filter((e) => e && !e.hidden);
}

/**
 * The Type column, in Explorer's words: `Folder`, `MD file`, `PNG image`, `File` for a name
 * with no extension, `Link to folder` for a folder link.
 * @param {object} entry
 * @returns {string}
 */
export function typeLabel(entry) {
  if (!entry) return '';
  if (entry.link === 'broken') return 'Broken link';
  if (entry.link === 'loop') return 'Link to itself';
  if (entry.link === 'outside') return 'Link outside the vault';
  if (isDir(entry)) return entry.link ? 'Link to folder' : 'Folder';
  const ext = extOf(entry);
  let label = 'File';
  if (ext) label = `${ext.toUpperCase()} ${IMAGE_EXTS.has(ext) ? 'image' : 'file'}`;
  return entry.link ? `Link to ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

/**
 * The Size column: nothing for a folder, bytes under a kilobyte, then KB, MB and GB in steps of
 * 1024 with one decimal under ten (`1.2 KB`, `34 KB`, `3.4 MB`).
 * @param {number} bytes
 * @param {'dir'|'file'} [kind]
 * @returns {string}
 */
export function sizeLabel(bytes, kind) {
  if (kind === 'dir') return '';
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const text = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
  return `${text} ${units[u]}`;
}

/**
 * The Modified column: `Today 14:02`, `Yesterday 09:10`, else `12 Sept 2026`. Local time.
 * @param {number} ms
 * @param {number} [now]
 * @returns {string}
 */
export function dateLabel(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const n = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / DAY_MS);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return `Today ${hm}`;
  if (diff === 1) return `Yesterday ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * The sort a folder is drawn with.
 * @param {object|null|undefined} folders  `ose.local('folders').get()`
 * @param {string} path  the folder, `''` for the vault root
 * @returns {{key: string, dir: 'asc'|'desc'}}
 */
export function sortSpecFor(folders, path) {
  const spec = folders && typeof folders === 'object' ? folders[clean(path)] : null;
  return normSpec(spec);
}

/**
 * The object to store once a folder is sorted `spec`: a new object, with the folder's key
 * removed when `spec` is the default, so the store holds only what someone chose.
 * @param {object|null|undefined} folders
 * @param {string} path
 * @param {{key: string, dir: 'asc'|'desc'}} spec
 * @returns {object}
 */
export function withSortSpec(folders, path, spec) {
  const next = { ...(folders && typeof folders === 'object' ? folders : {}) };
  const key = clean(path);
  const s = normSpec(spec);
  if (s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir) delete next[key];
  else next[key] = s;
  return next;
}

/**
 * What a click on a column header asks for: the same column flips direction, another column
 * starts ascending for words (name, type) and descending for numbers (newest, largest first),
 * the way Explorer does.
 * @param {{key: string, dir: 'asc'|'desc'}} spec
 * @param {string} key
 * @returns {{key: string, dir: 'asc'|'desc'}}
 */
export function nextSortSpec(spec, key) {
  const s = normSpec(spec);
  if (!SORT_KEYS.includes(key)) return s;
  if (s.key === key) return { key, dir: s.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'modified' || key === 'size' ? 'desc' : 'asc' };
}

const TEXT_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'txt', 'text', 'log', 'csv', 'tsv', 'rst', 'adoc', 'org', 'tex', 'bib']);
const CODE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonl', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'cc',
  'cs', 'java', 'kt', 'swift', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'toml', 'yaml',
  'yml', 'xml', 'html', 'htm', 'css', 'scss', 'sql', 'lua', 'r', 'ini', 'cfg', 'conf', 'svelte', 'vue',
]);

/**
 * The icon a row wears, by name from the kernel's set: `folder`, `fileImage`, `fileText`,
 * `fileCode`, else `file`. The tree and the folder view draw the same file the same way.
 * @param {object} entry
 * @returns {string}
 */
export function iconName(entry) {
  if (!entry) return 'file';
  if (isDir(entry)) return 'folder';
  const ext = extOf(entry);
  if (IMAGE_EXTS.has(ext)) return 'fileImage';
  if (TEXT_EXTS.has(ext)) return 'fileText';
  if (CODE_EXTS.has(ext)) return 'fileCode';
  return 'file';
}

/**
 * The file drawn under a folder's list: the first of `README.md`, `readme.md`, `index.md`, in
 * that order of preference and whatever their case.
 * @param {object[]} entries
 * @returns {object|null}
 */
export function readmeOf(entries) {
  const files = (Array.isArray(entries) ? entries : []).filter((e) => e && e.kind === 'file' && !e.link);
  for (const want of ['readme.md', 'index.md']) {
    const hits = files.filter((e) => String(e.name || '').toLowerCase() === want);
    if (!hits.length) continue;
    // `README.md` before `readme.md` when a case-sensitive volume holds both.
    return hits.find((e) => e.name === want.toUpperCase().replace('.MD', '.md')) || hits[0];
  }
  return null;
}

/**
 * The folder above `path`: `''` for a top-level entry, null at the vault root.
 * @param {string} path
 * @returns {string|null}
 */
export function parentOf(path) {
  const p = clean(path);
  if (!p) return null;
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
