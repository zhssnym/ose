// Vault path helpers. Vault paths are relative to the root, forward slashes, no leading slash.
// Everything here is pure; nothing touches the bridge.
//
// The functions live in `src/kernel/href.js`, because the kernel's own link resolver needs
// four of them and the kernel may not import `ose:editor`. This file was a byte-for-byte copy
// of them; it is the same list of names now, from one place, so a fix to `resolveHref` or
// `linkTarget` cannot land in only half the app.
export * from '../kernel/href.js';

/**
 * The extensions that make a file markdown to the editor (wave 2, H17): these open in the rich
 * view with the Rich | Source switch; every other text file, extensionless ones included, opens
 * as plain source. Declared here, and so it shadows any `isMarkdown` href.js exports: the
 * kernel's own answer is only `.md`, which is what its link rewriter means by it.
 */
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd']);

/** True for a path the editor opens as markdown. */
export const isMarkdown = (p) => {
  const base = String(p ?? '').replace(/\\/g, '/').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && MARKDOWN_EXTS.has(base.slice(dot + 1).toLowerCase());
};
