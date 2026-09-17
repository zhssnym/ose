/* The plugin's own small context: the `ose` activate was handed, the vault root, the drills
   folder and the folder this plugin is served from. Every other file reads it from here
   instead of taking `ose` as an argument everywhere.

   There are no settings. The drills folder is `ose.paths`' answer, asked for when a view or a
   route mounts, so a text field offering to change it would be a second door onto a thing the
   kernel already owns (ADV-B). Python is resolved once per session by asking it. */

export const ctx = {
  ose: null,          // the `ose` from activate(ose)
  vaultRoot: '',      // absolute, from ose.vault.info()
  pluginDir: '',      // vault-relative folder of this plugin, the judge's cwd
  dataRoot: '',       // vault-relative drills folder, from ose.paths
}

/** Where `state.json`, `log.jsonl` and the plugin's `clocks.json` live. */
export const DATA_DIRNAME = '.nsi'

/** Fill the context from `ose`. Called once, from `activate`. */
export async function open(ose) {
  ctx.ose = ose
  // The plugin's own folder, as a vault path: `.ose/plugins/nsi`, a legal cwd for `ose.run`
  // and where the judge lives, so nothing here has to guess at a path out of
  // `import.meta.url` (it used to).
  ctx.pluginDir = (ose.plugin && ose.plugin.folder) || ''
  const info = await ose.vault.info()
  ctx.vaultRoot = (info && info.root) || ''
}

export function close() {
  ctx.ose = null
  ctx.dataRoot = ''
  listener = null
  pythonName = null
  asking = null
}

/* ----------------------------------------------------------------------- the drills */

let listener = null

/** Told the drills folder whenever it resolves to a different one. One subscriber, `activate`'s. */
export function onDataRoot(fn) {
  listener = fn
}

/**
 * The drills folder, asked of `ose.paths` when a view or a route mounts. Answers the
 * vault-relative path, or null — and a null with an `el` has drawn the kernel's own box into
 * it: what is missing, the hint, and Choose. Nothing else in this plugin spells a vault path.
 *
 * Asked twice on the way to a null, because the kernel appends its box to whatever `el` holds:
 * the first call is quiet, and only when it comes back empty is the page cleared and the box
 * asked for. The tree the kernel resolves against is cached, so the second call costs nothing.
 */
export async function dataRoot(el) {
  let path = await ctx.ose.paths.get('drills')
  if (!path && el) {
    while (el.firstChild) el.removeChild(el.firstChild)
    path = await ctx.ose.paths.get('drills', { el })
  }
  const next = String(path || '').replace(/^\/+|\/+$/g, '')
  // A folder that has gone missing leaves the last one standing: a path is still wanted for
  // the error the judge is about to answer with, and `<vault>/` is not one.
  if (next && next !== ctx.dataRoot) {
    ctx.dataRoot = next
    if (listener) listener(next)
  }
  return next || null
}

/* --------------------------------------------------------------------------- python */

let pythonName = null
let asking = null

/**
 * The Python this machine answers to: `python`, then `python3`, the first that answers
 * `--version`. Asked once and remembered for the session — it is a fact about the machine, not
 * a preference, and the settings field that used to hold it had two legal values (ADV-B).
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
        cwd: ctx.pluginDir, timeout: 5000,
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

/** Absolute path of the drills folder: the `--root` the judge takes. */
export function absDataRoot() {
  return native(joinAbs(ctx.dataRoot))
}

/** A vault-relative path under the drills folder, for `ose.files`. */
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
