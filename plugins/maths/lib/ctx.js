/* The plugin's own small context: the `ose` `activate` was handed, the vault root, and the
   series folder once something has resolved it. Every other file reads it from here instead of
   taking `ose` as an argument everywhere.

   The folder is spelled nowhere (PLUGINS.md rule 2). It is what `ose.paths` answers for the key
   `series`, asked for when a view or a route mounts: `null` means the vault does not say where
   the series are, and the box that says so is drawn in the element the view hands over. It used
   to be a constant in this file, and before that a settings field whose own note admitted that
   typing anything but the manifest's value gave you a plugin that could read nothing (ADV-B). */

export const ctx = {
  ose: null,          // the ose from activate(ose)
  vaultRoot: '',      // absolute, from ose.vault.info()
  dataRoot: null,     // the series folder, vault-relative, or null while nothing has resolved it
}

/* The plugin's own dotfolder, inside the folder whose data it describes (PLUGINS.md rule 2).
   Everything the plugin writes lives in it: the log, the state, the bilan, the results. */
export const DOT = '.math'

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

/**
 * A path in the platform's own spelling: backslashes on Windows, forward slashes elsewhere.
 * One absolute path shown in two places in two spellings is a bug, so there is one function.
 */
export function native(path) {
  const text = String(path || '')
  return ctx.ose && ctx.ose.platform === 'windows'
    ? text.replace(/\//g, '\\')
    : text.replace(/\\/g, '/')
}

/** A path under the series folder, vault-relative, for ose.files. */
export function vaultPath(relative) {
  const root = ctx.dataRoot
  if (!root) throw new Error('the series folder has not been resolved')
  const tail = String(relative || '').replace(/^\/+/, '')
  return tail ? root + '/' + tail : root
}

/** The same path, absolute and native, for the quiet line at the foot of a page. */
export function absPath(relative) {
  const root = (ctx.vaultRoot || '').replace(/[\\/]+$/, '')
  return native(root + '/' + vaultPath(relative))
}

/* One series is one file, and what the plugin writes about it goes in the dotfolder beside it.
   The names are here, once; the folder under them is the only thing that moves. */
export const serieFile = (id) => `${id}.md`
export const resultatFile = (id) => `${DOT}/${id}-resultat.md`
export const seriePath = (id) => vaultPath(serieFile(id))
export const resultatPath = (id) => vaultPath(resultatFile(id))
