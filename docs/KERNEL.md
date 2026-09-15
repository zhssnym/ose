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

ose.vault.root / .name       the open vault, filled by `ose.ready`; null while none is open
ose.vault.info()             -> { root, name, remembered, source, exeDir }   exeDir: the chooser's suggestion
ose.vault.onChange(fn)       -> unsubscribe  a second launch named another folder and the host adopted it
ose.host                     'tauri' | 'webview' | 'browser'   whether window buttons, quit and drag are live
ose.vault.pick()             -> { root, name } | null  native picker; reloads the rice
ose.vault.recent()           -> [{ path, name, exists, current }]
ose.vault.open(path)         -> { root, name }         adopt; reloads the rice
ose.vault.forget(path)       drop one remembered vault; no path means stop remembering at all
    There is no `ose.vault.change()`. Changing vault is a dialog, and a dialog is rice: the
    rice draws `recent()`, calls `open()` on a row and `pick()` on the button.

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
    opts: { cwd, timeout (ms, default 60000), env, onLine(line, stream), input,
            onStart(id), id }
    cwd is vault-relative and must be inside the vault; env is merged over a UTF-8 environment
    (PYTHONUTF8=1, PYTHONIOENCODING=utf-8, LANG=C.UTF-8, LC_ALL=C.UTF-8); the process is killed
    at the timeout and when the app exits. A module may only run the programs its manifest
    names; the rice may run anything the settings allow (settings.run, default: nothing).
    A program is matched by its **stem**, case-insensitively on Windows, on both sides: `python`
    allows `python`, `tools/python.exe` and `C:\Python313\python.exe`, and does not allow
    `python3`.
    Underneath, the host answers `{ id, pid }` the moment the process starts and streams
    everything else as `run` events, ending with `{ id, done, code, timedOut }`; it buffers
    nothing. The kernel is what turns that into the one promise above, joining the lines it
    saw. `code` is null when the process was killed, and `timedOut` is true only for the
    timeout, never for a `kill`.
ose.run.kill(id)             a running process, id from opts.onStart(id, pid)

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
    A pattern is a plain glob with two rules. A **trailing `/*` is greedy**: `nsi/*` owns
    everything under `nsi/`, at any depth, so the route above is its page — an id with a slash
    in it is a format a module picks, and `routes: ["nsi/*"]` means the section, not one level
    of it. A `*` **anywhere else is one segment**: `nsi/*` + `/notes` matches
    `nsi/chapitre-1/notes` and not `nsi/chapitre-1/03-x/notes`. `**` is greedy wherever it
    stands, for the rare pattern that needs depth in the middle. Everything else is literal,
    and the first registration wins a collision.
ose.route.index(pattern, fn) register what quick open lists for an owned pattern
ose.route.on(fn)             -> unsubscribe            fn(route) after every change
ose.route.init(el)           the rice mounts the router into its page column, once

ose.commands.register({ id, title, group, shortcut?, when?, run })  -> unsubscribe
    `shortcut` is a binding, not a printed hint: registering the command arms the chord with
    scope 'window', `ose.keys.shortcutFor(id)` answers it, and the unsubscribe takes it back
    with the command. It is written like a `keys.bind` combo ('Mod+Shift+J', 'mod+shift+j' and
    'MOD+SHIFT+J' are one chord). An explicit `ose.keys.bind` wins over a `shortcut`, and both
    win over a shell default.
ose.commands.run(id, ...args) / get(id) / list()
ose.keys.bind(combo, commandId, { scope: 'window' | 'body' })  -> unsubscribe
    'mod+shift+j'; mod is Ctrl or Cmd. Shell chords are bound on the window in the capture
    phase, so nothing on the page can shadow one; a binding here replaces the default on that
    chord, and dropping the binding gives the default back. A scope 'body' chord fires only
    with the caret in a page editor. The rice's keys.json is loaded through the same call.
ose.keys.shortcutFor(commandId) -> 'Ctrl+K' | null
ose.keys.defaults()          -> the shell keymap, for a rice that wants to show it
ose.keys.label(combo)        -> 'mod+shift+j' as 'Ctrl+Shift+J' ('Cmd+Shift+J' on a Mac)

ose.views.register(name, { title, icon?, mount(el) -> { unmount? }, order? })  -> unsubscribe
ose.views.list()
ose.tiles.register({ id, title, order?, render(el) -> { refresh?, unmount? } })  -> unsubscribe
    a card on whichever view asks for tiles (the stock Day view does); render is called once
    and refresh on `ose.tiles.refresh(id)` or any watch the tile subscribes to
ose.tiles.list() / get(id) / refresh(id?) / mounted(id, handle) / forget(id)
    `mounted` is how the view that draws a tile hands the handle back, so a later `refresh`
    reaches it; `refresh()` with no id refreshes every tile currently on screen.
ose.status.set(field, text | { text, kind, onClick }) / clear(field)
ose.status.all()             -> [{ key, text, kind, onClick }]
    The bar's own five first (mode, path, doc, save, watch), then every other field in the
    order it was first set, so a module's `set('nsi', …)` is a field the bar draws.
ose.settings.get() / set(partial) / on(fn)     the shared settings object (docs/RICE.md)
ose.settings.section({ id, title, render(el) })  -> unsubscribe   a section in the settings dialog
ose.settings.sections()      -> the registered sections, in order, for the dialog to draw
ose.settings.apply()         put fontSize, lineHeight, zoom and readable width on the document
ose.settings.zoom() / setZoom(pct)                          one of 90, 100, 110, 125, 150
ose.settings.onRepaint(fn)   -> unsubscribe
    A settings dialog that is open while a chord changes a value redraws itself through this.
    The kernel does not know that dialog and never reaches into it.
ose.state(key)               -> { get(), set(value), flush() }   editor-only state in
                                .ose/state.json, one key per module or rice concern, written
                                debounced; a dotted key is a path into the object
ose.schedule(id, spec, fn)   -> unsubscribe
    spec: { every: 'day' | 'hour' | 'week', at: '07:00', weekday? } or { everyMs }. Runs while
    the app is open and catches up once at boot when a run was missed; the last run of each id
    is kept in state. Nothing runs when Ose is closed (docs/MODULES.md).

ose.bus.on(event, fn) / emit(event, payload)          rice-wide events; modules use it to talk
ose.store.get(key) / set(key, v) / watch(key, fn)     shared reactive values (theme, focus…)

ose.search(query, { limit, path })  -> { hits:[{ path, line, col, text }], files, total, capped }
ose.links.resolve(fromPath, href) -> { path, heading } | null
ose.links.href(fromPath, target)  -> string
ose.links.inbound(path)           -> [{ path, count }]
ose.links.rewriteMoved(pairs)     -> { files, links }

ose.sources.get(key) / set(key, path) / info(key) / keys() / all()
    timetable, plans, systems, todo, journal, scratch (docs/CONTRACT.md)
ose.theme.get() / set('light' | 'dark' | 'system') / on(fn) / resolved()
ose.window.title(text) / minimize() / maximize() / close() / quit() / isMaximized()
ose.window.drag() / resize(edge) / onMaximize(fn)   the frameless title bar's move, the eight resize
                             edges (top right bottom left topleft topright bottomleft bottomright),
                             and the maximised state as it changes; onClose(fn) is the closing half
ose.window.onClose(fn)       -> unsubscribe
    The window is closing. `fn()` may return a promise and the host **awaits it** before the
    window is destroyed, so the open page's last save finishes; resolving `false` keeps the
    window open, which is what the editor does when the save needs an answer from the user.
    A handler that throws is logged and counts as done: the close must never hang on a bug.
ose.update.check() / download() / apply() / on(fn)           the self-update (docs/TAURI.md)
ose.openExternal(url)        an http, https or mailto link in a note. Every other scheme is
                             refused by the host; a vault file is `ose.files.open(path)`.
ose.pages()                  -> Promise<[paths]>            every markdown page the rice offers
    Quick open, the page picker and the editor's `[[` menu all ask here, so all three offer
    the same rows. The rice registers the list through `ose.setPageList`; with none registered
    the vault is walked instead.
ose.focus.get() / set(path) / exit() / name() / isUnder(path) / defaultNewFolder() / on(fn)
    The focused folder (docs/CONTRACT.md batch 4): what narrows the tree and the page list,
    and where a new page is created. The sidebar UI that sets it is rice; the value is not,
    because `ose.pages()` and `page.new` both need it.
ose.assets.url(name)         -> the absolute URL of a kernel asset
ose.assets.origins()         -> { kernel, app, vault }      the three, as the host named them
ose.modules.load(ids?)       -> Promise<[{ id, name, state, error? }]>   the loader, below
ose.modules.list() / unload(id) / base() / setBase(url)
ose.log(text)                                                 into the host log
ose.reload()                                                  reload the rice (Ctrl+R)
ose.uid() / debounce(fn, ms) / esc(text) / toast(text, kind?, ms?)   small shared helpers
```

Two of the hoses are the other way round: things the **rice hands the kernel**, once, so that
the kernel can stay ignorant of both the editor and the sidebar. Neither is for a module.

```
ose.init({ page, keys, theme })   -> the one call the rice makes once its shell exists:
                                     mounts the router into `page`, starts the key engine and
                                     the theme. Each part can be switched off.
ose.setPageHost(host)             -> unregister    whoever draws a markdown page:
    { open(el, path, opts), close(), scrollToLine(line, col), selection(), headingLine(text, h) }
    The router never imports `ose:editor`; the rice joins them here. With no page host the
    router shows the file as text and navigation still works.
ose.setPageList(fn)               -> unregister    fn() -> [paths], what `ose.pages()` answers
```

A module receives a **facade** of this object from `activate(ose)`: the same shape, with
`files`, `watch`, `run` and `state` scoped by its manifest (`data`, `run`, `id`). A call
outside the scope rejects with `not allowed by module.json: <what>`. The rice receives the
unscoped object.

Reading is allowed under any folder the manifest's `data` names, writing under the same ones,
and an empty `data` means read the whole vault and write nothing at all. `watch(fn)` with no
folders means the module's own data, never the vault. `run` refuses a program the manifest
does not name, before the call leaves the page and again in the host, matching the stem the
same way the host does; `cwd` may be one of the `data` folders or the module's own folder,
which the facade also hands it as `ose.module.folder` (`.ose/app/modules/<id>`, where
docs/MODULES.md rule 6 has the module ship the scripts it runs). `route.own` and
`route.index` refuse a pattern that is not in `routes`. `state(key)` is `modules.<id>`.
`schedule(id, …)` becomes `<module>.<id>`. And every registration a module makes is tagged
with its id, so `ose.modules.unload(id)` takes back its commands, views, tiles, routes,
settings sections, watches and schedules, kills the processes it started and calls
`deactivate()` — one call, nothing left behind.

`ose.modules.load()` reads every `modules/*/module.json` from the rice, checks `requires`
against `ose.api`, imports the entry and calls `activate(facade)`. A module that throws is
**rolled back**: whatever it registered before it threw is taken back, so a failed module
leaves no orphan command in the palette. It is listed as `disabled` with the reason and named
in a toast, and the other modules activate normally (docs/MODULES.md).

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
`tokens.css` and `base.css`: every colour, font, size and the spacing scale, and the rules for
everything in this list — a rice that links `ui.css` and calls `toast()` gets a styled toast
without shipping a line of CSS. A rice or a module overrides tokens in its own stylesheet and
never writes a hex value.

`ose:ui` is a **facade over `ose:kernel`**: the file served at `<kernel origin>/ui.js` is a
list of names and no code. It has to be, because the kernel's own router, key engine and
module loader raise these same dialogs and these same toasts, and a second copy of them in the
window would be a second overlay stack — Esc closing the one that is not on top. The import
map line, the served file and everything in this section are exactly as they read; only the
inside differs. `ose:md` is pure parsers with no state, so that one is a bundle of its own.

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
