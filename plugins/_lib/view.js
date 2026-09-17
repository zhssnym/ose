// Small pieces every stock view repeats. DOM only; nothing here reads or writes the vault.

/**
 * `ose.paths.get(key, { el })`, with the part that needed the path left holding the kernel's
 * box and nothing else.
 *
 * The kernel appends its box to `el` rather than replacing what is in it, which is right: the
 * view owns its own content and knows what a stale render is. So a path that cannot be resolved
 * clears everything the part drew last time and keeps only the box, and a part whose path came
 * back is redrawn by the view as usual.
 *
 * -> the vault-relative path, or '' with the box drawn. Never null, so a caller can test it and
 * pass it straight into a template.
 */
export async function pathInto(ose, key, el) {
  const found = await ose.paths.get(key, el ? { el } : undefined);
  if (found) return found;
  if (el) {
    el.classList.remove('is-loading');
    for (const node of [...el.childNodes]) {
      const isBox = node.nodeType === 1 && node.classList.contains('path-box');
      if (!isBox) node.remove();
    }
  }
  return '';
}
