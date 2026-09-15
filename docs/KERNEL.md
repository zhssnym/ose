# The Ose kernel

Ose is a headless kernel and a folder of plain files. The kernel is the executable (`ose.exe`,
`Ose.app`): the Rust host plus the JavaScript that is logic rather than look, built into four
library bundles that the executable embeds and serves. It has no interface of its own. The
interface is the rice, `<vault>/.ose/app` (docs/RICE.md), and the workflows are modules inside
it (docs/MODULES.md). Everything the rice and the modules can do, they do through the hoses
below, and nothing else. This file is the contract; `ose.api` is its version.

## Origins

```
ose.localhost     the kernel's embedded assets: kernel.js, editor.js, ui.js, md.js, ui.css,
                  editor.css, the fallback page, the self-test page. Read-only, CORS open.
app.localhost     <vault>/.ose/app, served as files. index.html is rewritten on the way out:
                  the import map below is inserted at the top of <head>.
vault.localhost   the vault's files (images, PDFs), as before.
```

On macOS the schemes are `ose://localhost`, `app://localhost`, `vault://localhost`; the
import map the kernel injects carries whichever is right, so rice code never spells an origin.

```html
<script type="importmap">{"imports":{
  "ose:kernel": "<kernel origin>/kernel.js",
  "ose:editor": "<kernel origin>/editor.js",
  "ose:ui":     "<kernel origin>/ui.js",
  "ose:md":     "<kernel origin>/md.js"
}}</script>
```

Stylesheets: `<link rel="stylesheet" href="ose:ui.css">` is not a thing; the rice links
`<kernel origin>/ui.css` and `/editor.css` through the two `<link data-ose="ui">` and
`<link data-ose="editor">` elements the kernel also rewrites, so a rice file never spells an
origin either. `ose.assets.url(name)` answers the absolute URL of any kernel asset.

## `ose:kernel`

```js
import { ose } from 'ose:kernel'
```

One object, ready before the rice's first module runs (`ose.ready` resolves when the host has
answered `platform` and `rootInfo`). Every function that touches the host is async.

```
ose.api                      1
ose.version                  { kernel: '0.4.0', sha, short, date }   the build stamp
ose.platform                 'windows' | 'macos' | 'linux'
ose.ready                    Promise<void>

ose.vault                    { root, name }            null root while no vault is open
ose.vault.info()             -> { root, name, remembered, source }
ose.vault.pick()             -> { root, name } | null  native picker; reloads the rice
ose.vault.recent()           -> [{ path, name, exists, current }]
ose.vault.open(path)         -> { root, name }         adopt; reloads the rice
ose.vault.change()           the same, with the dialog the rice draws

ose.files.read(path)         -> string                 UTF-8, BOM kept, endings kept
ose.files.write(path, text)  -> null                   atomic; creates parents
ose.files.append(path, text) -> null
ose.files.readBinary(path)   -> Uint8Array
ose.files.writeBinary(path, bytes | base64) -> null
ose.files.list(path)         -> [{ name, path, kind, ext, mtime, size }]
ose.files.tree()             -> the whole visible tree
ose.files.stat(path)         -> { exists, kind, mtime, size }
ose.files.exists(path)       -> boolean
ose.files.mkdir(path)        -> null
ose.files.rename(from, to)   -> null                   case-only renames allowed
ose.files.trash(path)        -> null                   system bin or .trash per settings
ose.files.reveal(path)       -> null                   file manager
ose.files.open(path)         -> null                   default app; executables are revealed
ose.files.assetUrl(path)     -> string                 vault.localhost URL for an <img>
ose.files.versions.keep(path, text, force?) / list(path) / read(path, id) / restore(path, id)

ose.watch(fn)                -> unsubscribe            fn({ changes:[{kind, path, to?}], lost? })
ose.watch(folders, fn)       -> unsubscribe            only changes under those folders

ose.run(cmd, args, opts)     -> Promise<{ code, stdout, stderr, timedOut }>
    opts: { cwd, timeout (ms, default 60000), env, onLine(line, stream), input }
    cwd is vault-relative and must be inside the vault; env is merged over a UTF-8 environment
    (PYTHONUTF8=1, PYTHONIOENCODING=utf-8, LANG=C.UTF-8); the process is killed at the
    timeout and when the app exits. A module may only run the programs its manifest names;
    the rice may run anything the settings allow (settings.run, default: nothing).
ose.run.kill(id)             a running process, id from opts.onStart(id)

ose.route.current()          -> { type, path?, name?, line?, col?, heading? }
ose.route.navigate(route, { replace? })
ose.route.back() / forward() / canBack() / canForward()
ose.route.close()            the start surface (Ctrl+W); ose.route.reopenClosed()
ose.route.recent()           -> [paths]
ose.route.own(pattern, mount) -> unsubscribe
    pattern like 'nsi/*'. A route { type:'own', path:'nsi/chapitre-1/03-x' } is mounted by
    mount(el, route) -> { title?, unmount? }. History, the window title, quick open rows
    (through ose.route.index(pattern, () => [{ path, title }])) and back/forward work as for
    a page.
ose.route.index(pattern, fn) register what quick open lists for an owned pattern
ose.route.on(fn)             -> unsubscribe            fn(route) after every change

ose.commands.register({ id, title, group, shortcut?, when?, run })  -> unsubscribe
ose.commands.run(id, ...args) / get(id) / list()
ose.keys.bind(combo, commandId, { scope: 'window' | 'body' })  -> unsubscribe
    'mod+shift+j'; mod is Ctrl or Cmd. Shell chords win; a scope 'body' chord fires only with
    the caret in a page editor. The rice's keys.json is loaded through the same call.
ose.keys.shortcutFor(commandId) -> 'Ctrl+K' | null

ose.views.register(name, { title, icon?, mount(el) -> { unmount? }, order? })  -> unsubscribe
ose.views.list()
ose.tiles.register({ id, title, order?, render(el) -> { refresh?, unmount? } })  -> unsubscribe
    a card on whichever view asks for tiles (the stock Day view does); render is called once
    and refresh on `ose.tiles.refresh(id)` or any watch the tile subscribes to
ose.tiles.list()
ose.status.set(field, text | { text, kind, onClick }) / clear(field)
ose.settings.get() / set(partial) / on(fn)     the shared settings object (docs/RICE.md)
ose.settings.section({ id, title, render(el) })  -> unsubscribe   a section in the settings dialog
ose.state(key)               -> { get(), set(value) }   editor-only state in .ose/state.json,
                                one key per module or rice concern, written debounced

ose.bus.on(event, fn) / emit(event, payload)          rice-wide events; modules use it to talk
ose.store.get(key) / set(key, v) / watch(key, fn)     shared reactive values (theme, focus…)

ose.search(query, { limit, path })  -> { hits:[{ path, line, col, text }], files, total, capped }
ose.links.resolve(fromPath, href) -> { path, heading } | null
ose.links.href(fromPath, target)  -> string
ose.links.inbound(path)           -> [{ path, count }]
ose.links.rewriteMoved(pairs)     -> { files, links }

ose.sources.get(key) / set(key, path) / info(key) / keys()   timetable, plans, systems, todo,
                                                            journal, scratch (docs/CONTRACT.md)
ose.theme.get() / set('light' | 'dark' | 'system') / on(fn)
ose.window.title(text) / minimize() / maximize() / close() / quit() / isMaximized()
ose.update.check() / download() / apply() / on(fn)           the self-update (docs/TAURI.md)
ose.log(text)                                                 into the host log
ose.reload()                                                  reload the rice (Ctrl+R)
```

A module receives a **facade** of this object from `activate(ose)`: the same shape, with
`files`, `watch`, `run` and `state` scoped by its manifest (`data`, `run`, `id`). A call
outside the scope rejects with `not allowed by module.json: <what>`. The rice receives the
unscoped object.

## `ose:editor`

```js
import { markdownPage, codeEditor, render } from 'ose:editor'

markdownPage(el, path, opts)  -> { close(), save(), path, dirty, focus(), find(query), on(event, fn) }
    the block editor as it exists: title strip, properties, autosave, changed-on-disk dialog,
    versions, source mode (Ctrl+E), find and replace, drop, links, backlinks, every command.
    opts: { line, col, heading, selection, readOnly }
    Registers its commands on mount and removes them on close; the rice's page route mounts it.
codeEditor(el, { path | text, language, readOnly, onChange, onSave })  -> { getText(), setText(), save(), focus(), close() }
    CodeMirror with highlighting from the language pack, the same atomic save and conflict
    handling when `path` is given; plain in-memory when `text` is given.
render(markdown, { basePath })  -> HTMLElement   read-only, links resolved, images through vault.localhost
```

The stylesheet is `editor.css` on the kernel origin. Tokens come from `ui.css`.

## `ose:ui`

```js
import { openOverlay, prompt, confirm, choose, pickPage, pickFolder, pickFile, contextMenu,
         toast, dismissToast, copyText, icon, esc } from 'ose:ui'
```

The dialogs, the overlay stack (Esc closes the newest; focus returns where it was), the
context menu, toasts, the fuzzy picker, the icon set, and `esc` for HTML. `ui.css` carries
`tokens.css` and `base.css`: every colour, font, size and the spacing scale; a rice or a
module overrides tokens in its own stylesheet and never writes a hex value.

## `ose:md`

```js
import { parseTimetable, parseMonthlyPlan, parseSystems, parseTasks, readJsonl,
         parseFrontmatter, splitDoc, ymd, parseDate, addDays } from 'ose:md'
```

The parsers the stock views use, so a module reading the same files reads them the same way.

## The host underneath

The Rust side is unchanged in shape (docs/TAURI.md): one `rpc` command, the vault protocol,
the watcher, single instance, the update loop, headless `--update` and `--selftest`. It gains
`run` (spawn with streamed lines, allow-list, UTF-8), the `ose` and `app` protocols, the
import-map rewrite, `--rice <dir>`, `--no-rice`, Shift at launch, and the fallback page. The
executable is `ose.exe` / `Ose.app`; it accepts running under its old name `os.exe` and the
update layout handles either.

## Rules

- A hose is added, never changed in meaning. A breaking change is `ose.api = 2` and a kernel
  that refuses a rice or a module requiring 1 with one sentence.
- The kernel never draws. Its two pages (fallback, self-test) are the only HTML it ships.
- Nothing in the kernel knows a view, a module or a file name of the rice. It serves and it
  answers.
