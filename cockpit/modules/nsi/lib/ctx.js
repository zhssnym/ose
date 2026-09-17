/* The module's own small context: the facade `activate` was handed, the vault root, the data
   root and the folder this module is served from. Every other file reads it from here instead
   of taking `ose` as an argument everywhere.

   There are no settings. The data root is `module.json`'s — the manifest is the only thing
   allowed to name it, so a text field offering to change it was offering a module that could
   read nothing (ADV-B). Python is resolved once per session by asking it. */

export const ctx = {
  ose: null,          // the facade from activate(ose), scoped by module.json
  vaultRoot: '',      // absolute, from ose.vault.info()
  moduleDir: '',      // vault-relative folder of this module, for ose.run's cwd
  dataRoot: '',       // vault-relative, from module.json's `data`
}

/** Where `state.json`, `log.jsonl` and the module's `clocks.json` live. */
export const DATA_DIRNAME = '.nsi'

/** Fill the context from the facade. Called once, from `activate`. */
export async function open(ose) {
  ctx.ose = ose
  // The facade hands the module its own manifest and its own folder, so nothing here has to
  // guess at a path out of `import.meta.url` (it used to) or take one from settings.
  const manifest = (ose.module && ose.module.manifest) || {}
  ctx.moduleDir = (ose.module && ose.module.folder) || ''
  ctx.dataRoot = String((manifest.data || [])[0] || '').replace(/^\/+|\/+$/g, '')
  const info = await ose.vault.info()
  ctx.vaultRoot = (info && info.root) || ''
}

export function close() {
  ctx.ose = null
  pythonName = null
  asking = null
}

/* --------------------------------------------------------------------------- python */

let pythonName = null
let asking = null

/**
 * The Python this machine answers to: `python`, then `python3`, the first that answers
 * `--version`. Asked once and remembered for the session — it is a fact about the machine, not
 * a preference, and the settings field that used to hold it had two legal values (ADV-B).
 * `module.json` allows exactly these two names, so nothing else can be tried.
 */
export function python() {
  if (pythonName) return Promise.resolve(pythonName)
  if (!asking) asking = ask().then(name => { pythonName = name; asking = null; return name })
  return asking
}

async function ask() {
  for (const name of ['python', 'python3']) {
    try {
      const result = await ctx.ose.run(name, ['--version'], {
        cwd: ctx.dataRoot, timeout: 5000,
      })
      if (result && result.code === 0) return name
    } catch { /* not this one */ }
  }
  // Neither answered. Hand back the likelier of the two so the judge call that follows fails
  // with the judge's own error panel rather than with nothing at all.
  return ctx.ose && ctx.ose.platform === 'windows' ? 'python' : 'python3'
}

/* ---------------------------------------------------------------------------- paths */

/**
 * A path in the platform's own spelling: backslashes on Windows, forward slashes elsewhere.
 * A path copied out of Ose is pasted into a terminal or a file dialog.
 */
export function native(path) {
  const text = String(path || '')
  return ctx.ose && ctx.ose.platform === 'windows'
    ? text.replace(/\//g, '\\')
    : text.replace(/\\/g, '/')
}

/** Absolute path of the data root: the `--root` the judge takes. */
export function absDataRoot() {
  return native(joinAbs(ctx.dataRoot))
}

/** A vault-relative path under the data root, for `ose.files`. */
export function vaultPath(relative) {
  return ctx.dataRoot + '/' + String(relative || '').replace(/^\/+/, '')
}

/** The absolute spelling of a vault path, for the one line at the foot of a page. */
export function absolute(path) {
  return native(joinAbs(path))
}

function joinAbs(path) {
  const root = String(ctx.vaultRoot || '').replace(/[\\/]+$/, '')
  return (root ? root + '/' : '') + String(path || '')
}
