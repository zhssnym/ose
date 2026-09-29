// The pure rules of the host, ported from the desktop host (hide.rs, vault.rs, encoding.rs and
// files.rs, in git history at 6cee39d): the hash, the one hide rule, vault paths and
// names, the natural sort, text in the four encodings, the text sniff, and the HostError every
// web module throws. No handle, no IndexedDB, no DOM here: src/host/fs.js, watch.js, local.js
// and adapter.js all import it, and tests/host/rules.test.js holds it to the values files and
// agents already rely on.
//
// One addition to the rule, the browser's own temp file: Chrome writes a `createWritable` into
// `<name>.crswap` beside the target until `close()`, and a crash can leave one behind. It is a
// temp file like the atomic writer's, excluded everywhere (docs/HOST.md "The hide rule").

import { HostError } from '../core/bridge/errors.js';

export { HostError };

/** The prefix of a path outside the vault (docs/HOST.md "Files outside the vault"). */
export const ABS = 'abs:';

/** A refusal with its code, as every web command throws it. @param {string} code @param {string} message */
export const fail = (code, message) => new HostError(message, code);

// ---------------------------------------------------------------- the hash

const utf8Enc = new TextEncoder();

/**
 * FNV-1a, 64 bits, over the raw bytes, as 16 lowercase hex digits (docs/HOST.md "Commands"):
 * `""` -> `cbf29ce484222325`, `"a"` -> `af63dc4c8601ec8c`. A string is hashed as its UTF-8 bytes.
 * @param {Uint8Array | string} data
 */
export function hash(data) {
  const bytes = typeof data === 'string' ? utf8Enc.encode(data) : data;
  let lo = 0x84222325;
  let hi = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ /** @type {number} */ (bytes[i])) >>> 0;
    const a = lo * 0x1b3;
    const carry = Math.floor(a / 4294967296);
    hi = (Math.imul(hi, 0x1b3) + (lo << 8) + carry) >>> 0;
    lo = a >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** @param {Uint8Array} a @param {Uint8Array} b */
export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------- the one hide rule (hide.rs)

const EXCLUDED_ANYWHERE = new Set(['.ose', '.git']);
const EXCLUDED_AT_ROOT = new Set(['ose.exe', 'ose.pdb', 'ose.exe.new', 'ose.exe.old', 'ose.app', 'ose.app.old',
  'ose-update.zip', 'ose-update-tmp', 'webview2loader.dll', 'os.exe', 'os.pdb', 'os.exe.new', 'os.exe.old',
  'os.app', 'os.app.old', 'os-update.zip', 'os-update-tmp']);

/**
 * Somebody's temp file: the atomic writer's `.<name>.<pid>.<n>.tmp`, a case-only rename's
 * `.<name>.<pid>.case`, Chrome's `<name>.crswap`, an Office owner file `~$x`, a LibreOffice
 * lock `.~lock.x#`.
 * @param {string} name
 */
export function isTemp(name) {
  return /^\..+\.\d+\.\d+\.tmp$/.test(name) || /^\..+\.\d+\.case$/.test(name) || /.\.crswap$/.test(name)
    || name.startsWith('~$') || (name.startsWith('.~lock.') && name.endsWith('#'));
}

/** @param {string} rel */
export const segmentsOf = (rel) => String(rel ?? '').split(/[\\/]/).filter((s) => s && s !== '.');

/**
 * Never listed, walked, searched or reported: any segment `.ose` or `.git` (any case), a temp
 * file anywhere, the app's own files at the root, and the vault bin's sidecars `.trash/.info`.
 * @param {string} rel
 */
export function isExcluded(rel) {
  const segs = segmentsOf(rel);
  if (segs.length >= 2 && (segs[0] || '').toLowerCase() === '.trash' && (segs[1] || '').toLowerCase() === '.info') return true;
  return segs.some((seg, depth) => {
    const low = seg.toLowerCase();
    return EXCLUDED_ANYWHERE.has(low) || isTemp(seg) || (depth === 0 && EXCLUDED_AT_ROOT.has(low));
  });
}

/** Inside the vault's own bin, `.trash` at the root: never searched. @param {string} rel */
export const isInBin = (rel) => (segmentsOf(rel)[0] || '').toLowerCase() === '.trash';

/** A dotfile or dotfolder: the browser sees no system hidden flag, so this is all of hidden. @param {string} name */
export const isHiddenName = (name) => String(name).startsWith('.');

/** Does any segment start with a dot? The watcher's `hidden` flag. @param {string} rel */
export const isPathHidden = (rel) => segmentsOf(rel).some(isHiddenName);

/** `'excluded' | 'hidden' | 'shown'`, by the entry's own name. @param {string} rel */
export function classify(rel) {
  if (isExcluded(rel)) return 'excluded';
  const segs = segmentsOf(rel);
  return isHiddenName(segs[segs.length - 1] || '') ? 'hidden' : 'shown';
}

// ---------------------------------------------------------------- sorting (vault.rs)

/** Runs of digits compare as numbers, the rest by lowercased code point. @param {string} a @param {string} b */
export function naturalCompare(a, b) {
  const A = [...String(a)];
  const B = [...String(b)];
  const digit = (/** @type {string} */ c) => c >= '0' && c <= '9';
  const lower = (/** @type {string} */ c) => [...c.toLowerCase()][0] || c;
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const ai = /** @type {string} */ (A[i]);
    const bj = /** @type {string} */ (B[j]);
    if (digit(ai) && digit(bj)) {
      const si = i;
      const sj = j;
      while (i < A.length && digit(/** @type {string} */ (A[i]))) i++;
      while (j < B.length && digit(/** @type {string} */ (B[j]))) j++;
      const na = A.slice(si, i).join('').replace(/^0+/, '');
      const nb = B.slice(sj, j).join('').replace(/^0+/, '');
      if (na.length !== nb.length) return na.length - nb.length;
      if (na !== nb) return na < nb ? -1 : 1;
    } else {
      const ca = /** @type {number} */ (lower(ai).codePointAt(0));
      const cb = /** @type {number} */ (lower(bj).codePointAt(0));
      if (ca !== cb) return ca - cb;
      i++;
      j++;
    }
  }
  return (A.length - i) - (B.length - j);
}

/** Folders first, then natural name order. @param {{ kind: string, name: string }} a @param {{ kind: string, name: string }} b */
export const byEntry = (a, b) => (a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === 'dir' ? -1 : 1);

// ---------------------------------------------------------------- paths and names

/** A vault path as the page writes it: forward slashes, no leading or trailing slash. @param {unknown} p */
export const clean = (p) => String(p ?? '').replace(/\\/g, '/').trim().replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * The segments of a vault path, taken literally (vault.rs `resolve`, M49): `abs:` and `..` are
 * `escapes_vault`, so is a NUL or a drive colon; on Windows (`win`) a segment the system would
 * read as another name (a trailing dot or space, a device name) is `bad_name`. `[]` is the root.
 * @param {unknown} p
 * @param {boolean} [win]
 * @returns {string[]}
 */
export function vaultSegments(p, win = false) {
  const raw = String(p ?? '');
  if (raw.startsWith(ABS)) throw fail('escapes_vault', `a file outside the vault is not allowed here: ${raw}`);
  const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const segs = rel.split('/').filter((s) => s && s !== '.');
  for (const s of segs) {
    if (s === '..') throw fail('escapes_vault', `path escapes the vault: ${raw}`);
    if (s.includes('\0') || (win && s.includes(':'))) throw fail('escapes_vault', `path must be vault-relative: ${raw}`);
    if (win && (/[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test((s.split('.')[0] || '').trimEnd()))) {
      throw fail('bad_name', `Windows would read another name for: ${raw}`);
    }
  }
  return segs;
}

/** A name a create may make (files.rs `check_name`), or `bad_name`. @param {unknown} rel */
export function checkName(rel) {
  const c = clean(rel);
  const name = c.split('/').pop();
  if (!name || name === '.' || name === '..' || /[. ]$/.test(name) || /[\u0000-\u001f<>"|?*]/.test(c)) {
    throw fail('bad_name', `not a file name: ${String(rel)}`);
  }
}

/** The extension of a name, lowercased, without the dot; none for `.env`. @param {string} name */
export const extOf = (name) => {
  const n = String(name).split(/[\\/]/).pop() || '';
  const i = n.lastIndexOf('.');
  return i > 0 && i + 1 < n.length ? n.slice(i + 1).toLowerCase() : '';
};

// ---------------------------------------------------------------- text (encoding.rs)

const CP1252 = [0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178];
const CP1252_BACK = new Map(CP1252.map((cp, i) => [cp, 0x80 + i]));

/** Labels to the four encodings Ose Web reads and writes, as the Encoding Standard names them. */
const LABELS = new Map([
  ...['utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8'].map((l) => /** @type {[string, string]} */ ([l, 'UTF-8'])),
  ...['utf-16le', 'utf-16', 'ucs-2', 'unicode', 'csunicode', 'iso-10646-ucs-2', 'unicodefeff'].map((l) => /** @type {[string, string]} */ ([l, 'UTF-16LE'])),
  ...['utf-16be', 'unicodefffe'].map((l) => /** @type {[string, string]} */ ([l, 'UTF-16BE'])),
  ...['windows-1252', 'cp1252', 'x-cp1252', 'latin1', 'l1', 'iso-8859-1', 'iso8859-1', 'iso_8859-1', 'iso88591', 'iso_8859-1:1987',
    'iso-ir-100', 'ibm819', 'cp819', 'csisolatin1', 'ascii', 'us-ascii', 'ansi_x3.4-1968'].map((l) => /** @type {[string, string]} */ ([l, 'windows-1252'])),
]);

/** The encoding a label names (`UTF-8`, `UTF-16LE`, `UTF-16BE`, `windows-1252`), or `unsupported`. @param {unknown} label */
export function encodingOf(label) {
  const name = LABELS.get(String(label ?? '').trim().toLowerCase());
  if (!name) throw fail('unsupported', `Ose Web reads and writes UTF-8, UTF-16LE, UTF-16BE and windows-1252, not ${String(label)}`);
  return name;
}

/** @param {Uint8Array} bytes */
function utf16leBytes(bytes, bigEndian = false) {
  const n = bytes.length - (bytes.length % 2);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 2) {
    out[i] = /** @type {number} */ (bytes[bigEndian ? i + 1 : i]);
    out[i + 1] = /** @type {number} */ (bytes[bigEndian ? i : i + 1]);
  }
  return out;
}

/**
 * `text` in the encoding `name` (a name `encodingOf` answered). A character windows-1252 cannot
 * hold is `unencodable`; a U+FEFF in the text is kept, so a BOM goes back where it was.
 * @param {string} text
 * @param {string} name
 * @returns {Uint8Array}
 */
export function encodeText(text, name) {
  if (name === 'UTF-8') return utf8Enc.encode(text);
  if (name === 'UTF-16LE' || name === 'UTF-16BE') {
    const out = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const [a, b] = name === 'UTF-16LE' ? [c & 0xff, c >> 8] : [c >> 8, c & 0xff];
      out[2 * i] = a;
      out[2 * i + 1] = b;
    }
    return out;
  }
  const out = new Uint8Array(text.length);
  let n = 0;
  for (const ch of text) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    const b = cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : CP1252_BACK.get(cp);
    if (b === undefined) throw fail('unencodable', `${JSON.stringify(ch)} (U+${cp.toString(16).toUpperCase().padStart(4, '0')}) cannot be written in windows-1252`);
    out[n++] = b;
  }
  return out.subarray(0, n);
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** The bytes as UTF-8, or null. A BOM stays in the text as U+FEFF. @param {Uint8Array} bytes */
export const utf8OrNull = (bytes) => { try { return utf8Strict.decode(bytes); } catch { return null; } };

/**
 * The bytes as text (encoding.rs `decode`): `{ text, encoding, bom, lossy }`. A UTF-16 BOM
 * first, then UTF-8, then windows-1252; `forced` names the encoding instead, and a forced
 * UTF-8 that is not UTF-8 is `not_utf8`. `lossy`: the text does not encode back to the bytes.
 * @param {Uint8Array} buf
 * @param {string | null} [forced]
 */
export function decodeText(buf, forced = null) {
  let name = forced ? encodingOf(forced) : null;
  if (!name) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) name = 'UTF-16LE';
    else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) name = 'UTF-16BE';
    else name = utf8OrNull(buf) !== null ? 'UTF-8' : 'windows-1252';
  }
  let text;
  if (name === 'UTF-8') {
    text = utf8OrNull(buf);
    if (text === null) throw fail('not_utf8', 'not valid UTF-8');
  } else if (name === 'windows-1252') {
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      const b = /** @type {number} */ (buf[i]);
      out += String.fromCharCode(b >= 0x80 && b < 0xa0 ? /** @type {number} */ (CP1252[b - 0x80]) : b);
    }
    text = out;
  } else {
    text = new TextDecoder('utf-16le', { ignoreBOM: true }).decode(utf16leBytes(buf, name === 'UTF-16BE'));
  }
  const bom = name === 'UTF-8' ? buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    : name === 'windows-1252' ? false : text.charCodeAt(0) === 0xfeff;
  let lossy = false;
  try { lossy = !sameBytes(encodeText(text, name), buf); } catch { lossy = true; }
  return { text, encoding: name, bom, lossy };
}

/** How much of a file the sniff reads. */
export const SNIFF_BYTES = 8192;

/**
 * Text, by content: no NUL in the first 8 KB and valid UTF-8 there; a character cut by the 8 KB
 * edge does not count against the file (vault.rs `sniff_text`).
 * @param {Uint8Array} head
 * @param {boolean} [full] the head is a full 8 KB (the file goes on)
 */
export function sniffText(head, full = head.length >= SNIFF_BYTES) {
  if (head.includes(0)) return false;
  if (utf8OrNull(head) !== null) return true;
  if (!full) return false;
  for (let cut = 1; cut <= 3 && cut < head.length; cut++) {
    const lead = /** @type {number} */ (head[head.length - cut]);
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 0;
    if (!need) continue;
    const tail = head.subarray(head.length - cut + 1);
    if (need <= cut || tail.some((b) => (b & 0xc0) !== 0x80)) return false;
    return utf8OrNull(head.subarray(0, head.length - cut)) !== null;
  }
  return false;
}

/**
 * The encoding of a file that is not UTF-8 (encoding.rs `sniff`): a UTF-16 BOM, or windows-1252
 * when the head has no NUL and no control character but tab, line breaks and form feed.
 * @param {Uint8Array} head
 * @returns {string | null}
 */
export function sniffEncoding(head) {
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return head[0] === 0xff ? 'UTF-16LE' : 'UTF-16BE';
  if (!head.length) return null;
  for (const b of head) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) return null;
  return 'windows-1252';
}

// ---------------------------------------------------------------- errors from the browser

/**
 * What the browser threw, as the HostError the host would have answered (docs/HOST.md "Errors").
 * A HostError passes through. `where` names the path for the message.
 * @param {unknown} e
 * @param {string} [where]
 * @returns {HostError}
 */
export function fromDom(e, where = '') {
  if (e instanceof HostError) return e;
  const name = e && typeof e === 'object' && 'name' in e ? String(e.name) : '';
  const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
  const text = where ? `${where}: ${msg}` : msg;
  switch (name) {
    case 'NotFoundError': return fail('not_found', text);
    case 'TypeMismatchError': return fail('not_found', text);
    case 'InvalidModificationError': return fail('exists', text);
    case 'NoModificationAllowedError': return fail('write_failed', text);
    case 'QuotaExceededError': return fail('write_failed', text);
    case 'NotAllowedError':
    case 'SecurityError': return fail('no_vault', `permission to the folder was withdrawn: ${text}`);
    case 'NotSupportedError': return fail('unsupported', text);
    case 'TypeError': return fail('bad_name', text);
    default: return fail('io', text);
  }
}
