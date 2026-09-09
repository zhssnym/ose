// Vault path helpers. Vault paths are relative to the root, forward slashes, no leading slash.
// Everything here is pure; nothing touches the bridge.

export const dirname = (p) => {
  const i = String(p || '').lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

export const basename = (p) => {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
};

export const extname = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
};

export const stem = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? b : b.slice(0, i);
};

/** Normalise a path made of segments, resolving `.` and `..`. Returns '' for the root. */
export function normalize(p) {
  const out = [];
  for (const seg of String(p || '').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

/** Join a folder with a relative path. */
export const joinPath = (dir, rel) => normalize((dir ? dir + '/' : '') + String(rel || ''));

/** True for anything with a scheme (http:, mailto:, data:) or a protocol-relative URL. */
export const isExternal = (href) =>
  /^[a-z][a-z0-9+.-]*:/i.test(String(href || '')) || String(href || '').startsWith('//');

/**
 * Resolve a markdown href written inside `fromFile` to a vault path.
 * Returns null when the href is external, empty, or a bare fragment.
 * Percent-escapes are decoded, so `Documents/0.%20Index/README.md` comes back decoded.
 */
export function resolveHref(fromFile, href) {
  let h = String(href || '').trim();
  if (!h || h.startsWith('#')) return null;
  if (isExternal(h)) return null;
  h = h.split('#')[0].split('?')[0];
  if (!h) return null;
  let decoded = h;
  // decodeURIComponent, not decodeURI: relativeHref encodes with encodeURIComponent, and
  // decodeURI leaves %2C %3B %3A %40 %26 %3D %2B %24 in place, so a page named with a comma
  // or an ampersand never resolved (and lib/links.js could not confirm links into it).
  try { decoded = decodeURIComponent(h); } catch { /* leave as written */ }
  if (decoded.startsWith('/')) return normalize(decoded);
  return joinPath(dirname(fromFile), decoded);
}

/** Write a vault path back as an href relative to `fromFile`, with %20-style escaping. */
export function relativeHref(fromFile, target) {
  const from = dirname(fromFile).split('/').filter(Boolean);
  const to = normalize(target).split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => '..');
  const rest = to.slice(i);
  const segs = [...up, ...rest];
  if (!segs.length) return '';
  return segs.map((s) => (s === '..' ? s : encodeURIComponent(s).replace(/%2F/gi, '/'))).join('/');
}

/** ASCII slug for attachment file names: keeps words, collapses everything else to '-'. */
export function slugify(name, fallback = 'image') {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || fallback;
}

export const today = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const hhmm = (d = new Date()) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
