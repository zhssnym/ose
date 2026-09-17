/* The plugin's own small context: the `ose` `activate` was handed, and the series folder once
   something has resolved it. Every other file reads it from here instead of taking `ose` as an
   argument everywhere.

   The folder is spelled nowhere (PLUGINS.md rule 2). It is what `ose.paths` answers for the key
   `series`, asked for when a view or a route mounts: `null` means the vault does not say where
   the series are, and the box that says so is drawn in the element the view hands over. */

export const ctx = {
  ose: null,          // the ose from activate(ose)
  dataRoot: null,     // the series folder, vault-relative, or null while nothing has resolved it
}

/* The plugin's own dotfolder, inside the folder whose data it describes (PLUGINS.md rule 2).
   One file lives in it, and it is the only thing this plugin ever writes. */
export const DOT = '.math'
export const LOG = `${DOT}/log.jsonl`

/**
 * The series folder, asked of `ose.paths` rather than remembered, because the owner can point
 * the plugin at another one at any moment. With `el`, a `null` also draws the standard box into
 * it: what is missing, the hint, and Choose. Hand it an element with nothing in it.
 */
export async function requireRoot(el) {
  const found = el
    ? await ctx.ose.paths.get('series', { el })
    : await ctx.ose.paths.get('series')
  ctx.dataRoot = found || null
  return ctx.dataRoot
}

/** A path under the series folder, vault-relative, for ose.files. */
export function vaultPath(relative) {
  const root = ctx.dataRoot
  if (!root) throw new Error('the series folder has not been resolved')
  const tail = String(relative || '').replace(/^\/+/, '')
  return tail ? root + '/' + tail : root
}

/* One series is one file, and its name is its id. */
export const serieFile = (id) => `${id}.md`
export const seriePath = (id) => vaultPath(serieFile(id))
