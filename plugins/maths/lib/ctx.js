/* The module's own small context: the facade `activate` was handed, the vault root, and the
   folder this module is served from. Every other file reads it from here instead of taking
   `ose` as an argument everywhere.

   The data root is `module.json`'s and nothing else. It used to be a settings field whose own
   note admitted that typing anything but the manifest's value gave you a module that could
   read nothing (ADV-B); the field, the section and the override are gone. */

export const ctx = {
  ose: null,          // the facade from activate(ose), scoped by module.json
  vaultRoot: '',      // absolute, from ose.vault.info()
  moduleDir: '',      // vault-relative folder of this module
}

/* `module.json`'s `data[0]`. The manifest is the permission, so it is also the path. */
export const DATA_ROOT = '2-learning/1-school/1-math/1-drills'
export const DEFAULT_MODULE_DIR = '.ose/app/modules/maths'

/* The module's own dotfolder, beside the data it describes (MODULES.md rule 2). */
export const DOT = '.drills'

/** What the module reads and writes. One field, from the manifest. */
export function conf() {
  return { dataRoot: DATA_ROOT }
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

/** A path under the data root, vault-relative, for ose.files. */
export function vaultPath(relative) {
  const tail = String(relative || '').replace(/^\/+/, '')
  return tail ? DATA_ROOT + '/' + tail : DATA_ROOT
}

/** The same path, absolute and native, for the quiet line at the foot of a page. */
export function absPath(relative) {
  const root = (ctx.vaultRoot || '').replace(/[\\/]+$/, '')
  return native(root + '/' + vaultPath(relative))
}

/* The paths the module navigates to, as vault paths. */
export const seriePath = (serie) => vaultPath(`${serie}/serie.md`)
export const resultatPath = (serie) => vaultPath(`${serie}/resultat.md`)
