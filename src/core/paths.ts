// Vault path helpers. Paths are relative to the root, forward slashes, no leading slash.
//
// One other form exists (X7): a file outside the vault is `abs:` and its absolute path with
// forward slashes, the drive letter upper case and no `\\?\` prefix, as `abs:D:/Notes/todo.md` or
// `abs:/Users/h/Notes/a.md`. `clean` keeps the prefix; `isOutside` tells the two apart.

/** The prefix of a path outside the vault. */
export const ABS = 'abs:';

export const clean = (p: unknown): string => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * `clean`, with `.` and `..` collapsed and every empty segment dropped: the form a path has to
 * be in before anyone may compare it with a folder.
 *
 * `clean` only straightens the separators, so `data/x/../../CLAUDE.md` still *starts with*
 * `data/x/` and walks straight through a `startsWith` guard, which is how the old app's data
 * sandbox was escaped (QA-K defect 1). Every comparison normalises first now.
 *
 * A `..` that would climb above the root is dropped rather than kept: the vault root is the top
 * of this world, `..` above it means nothing, and the host's own `vault::resolve` does the same.
 * `resolve('x/../../CLAUDE.md')` is therefore `CLAUDE.md`, which is what a caller comparing two
 * paths has to see.
 */
export const resolve = (p) => {
  const c = clean(p);
  // A file outside the vault (X7) keeps its prefix and its root: `..` never climbs past the
  // drive, the leading `/` or the `//server` of a share.
  if (c.startsWith(ABS)) {
    const rest = c.slice(ABS.length);
    const lead = rest.startsWith('//') ? '//' : rest.startsWith('/') ? '/' : '';
    const drive = /^[A-Za-z]:/.test(rest) ? rest.slice(0, 2) : '';
    const body = resolveRel(rest.slice(drive ? 2 : lead.length));
    return ABS + (drive ? `${drive}/${body}` : `${lead}${body}`);
  }
  return resolveRel(c);
};

/** `resolve` for a path with no prefix: `.` and `..` collapsed, empty segments dropped. */
function resolveRel(c) {
  const out: string[] = [];
  for (const seg of c.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

export const baseName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? c : c.slice(i + 1); };
export const dirName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? '' : c.slice(0, i); };
export const extOf = (p) => { const b = baseName(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase(); };
export const isMd = (p) => extOf(p) === 'md';
export const stripMd = (name) => String(name).replace(/\.md$/i, '');
export const titleOf = (p) => stripMd(baseName(p));
export const join = (...parts) => parts.map(clean).filter(Boolean).join('/');
export const segments = (p) => clean(p).split('/').filter(Boolean);

/**
 * The one list of what a file is by its extension (`ose.paths`). Markdown opens in the rich
 * editor and is what the link rewrite edits; text is every file that opens as text by its
 * name, markdown included, and is what backlinks read. The editor, the tree and the palette
 * take these, so the lists cannot drift apart. A file the list does not name
 * may still read as text (`stat {sniff}`); this is the answer by name only.
 */
export const MARKDOWN_EXTS = Object.freeze(['md', 'markdown', 'mdown', 'mkd']);
export const TEXT_EXTS = Object.freeze([...MARKDOWN_EXTS, 'txt', 'text', 'log', 'csv', 'tsv', 'rst', 'adoc', 'org', 'tex', 'bib']);
const MARKDOWN_SET = new Set(MARKDOWN_EXTS);
const TEXT_SET = new Set(TEXT_EXTS);
export const isMarkdownPath = (p: unknown): boolean => MARKDOWN_SET.has(extOf(p));
export const isTextPath = (p: unknown): boolean => TEXT_SET.has(extOf(p));

/** True for an `abs:` path: a file outside the vault (X7). */
export const isOutside = (p: unknown) => typeof p === 'string' && p.startsWith(ABS);

/**
 * The native absolute path of an `abs:` path: backslashes for a drive or a share, as Windows
 * spells it, forward slashes otherwise. A vault path comes back as it was.
 */
export const absOf = (p: string) => {
  if (!isOutside(p)) return p;
  const rest = p.slice(ABS.length);
  return /^[A-Za-z]:/.test(rest) || rest.startsWith('//') ? rest.replace(/\//g, '\\') : rest;
};

/** What the chrome shows for an `abs:` path: the absolute path, no prefix. */
export const outsideLabel = (p: string) => (isOutside(p) ? p.slice(ABS.length) : p);

/**
 * The path part of a `vault` origin URL: a vault path segment by segment, or, for a file outside
 * the vault (X7), `~abs/` and the whole absolute path as one percent-encoded segment, which the
 * host serves only under the folder of a file this window registered.
 */
export function assetPath(path: string) {
  if (isOutside(path)) return `~abs/${encodeURIComponent(outsideLabel(path))}`;
  return String(path ?? '').replace(/^\.?\//, '').split('/').map(encodeURIComponent).join('/');
}

