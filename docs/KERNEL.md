# The Ose kernel

`ose.exe` is the whole app: the Rust host (docs/HOST.md), the kernel, the editor and the shell
(docs/SHELL.md), in one file. The kernel is the JavaScript that is logic rather than look, built
into four library bundles the executable embeds and serves. It never draws and knows no view and
no file name of the shell. Everything the shell and the plugins can do, they do through the hoses
below, and nothing else. This file is the contract; `ose.api` is its version, and it is **2**.

## Origins

```
ose.localhost     the kernel's embedded bundles: kernel.js, editor.js, ui.js, md.js, ui.css,
                  editor.css. Read-only, CORS open, never cached.
app.localhost     the app itself. `/index.html` and every other name are the shell, which
                  travels inside the executable (or comes from `--shell <dir>`); anything
                  under `/plugins/` is a file of `<vault>/.ose/plugins`, read from disk on
                  every request. index.html is rewritten on the way out: the import map below
                  is inserted at the top of <head>.
vault.localhost   the vault's files (images, PDFs), as before.
```

On macOS the schemes are `ose://localhost`, `app://localhost`, `vault://localhost`; the import
map the kernel injects carries whichever is right, so no shell or plugin file spells an origin.

```html
<script type="importmap">{"imports":{
  "ose:kernel": "<kernel origin>/kernel.js",
  "ose:editor": "<kernel origin>/editor.js",
  "ose:ui":     "<kernel origin>/ui.js",
  "ose:md":     "<kernel origin>/md.js"
}}</script>
```

Stylesheets: `<link rel="stylesheet" href="ose:ui.css">` is not a thing; the shell links
`<kernel origin>/ui.css` and `/editor.css` through the two `<link data-ose="ui">` and
`<link data-ose="editor">` elements the host rewrites, so no file spells an origin there either.
`ose.assets.url(name)` answers the absolute URL of any kernel asset.

## `ose:kernel`

```js
import { ose } from 'ose:kernel'
```

One object, ready before the first plugin runs (`ose.ready` resolves when the host has answered
`platform` and `rootInfo`). Every function that touches the host is async.

```
ose.api                      2
ose.version                  { kernel, sha, short, date }   the build stamp
ose.platform                 'windows' | 'macos' | 'linux'
ose.ready                    Promise<void>

ose.vault.root / .name       the open vault, filled by `ose.ready`; null while none is open
ose.vault.info()             -> { root, name, remembered, source, exeDir }   exeDir: the chooser's suggestion
ose.vault.epoch              the host's count of adopted vaults, as this window read it at boot.
                             Every mutating call carries it; a call from an older vault is
                             refused with `[stale_vault]` instead of landing in the new one
ose.vault.onChangeRequested(fn) -> unsubscribe  fn({ root, name }): a second launch named another
                             folder. The host did not adopt it; the shell leaves the window
                             (`ose.window.leave('vault-change')`), opens it and reloads
ose.vault.onChange(fn)       -> unsubscribe  kept for old callers; never fires any more
ose.host                     'tauri' | 'webview' | 'browser'   whether window buttons, quit and drag are live
ose.vault.pick(opts?)        -> { root, name } | null  native picker. `{ adopt: false }` only chooses
                             (nothing adopted, nothing recorded); without it the choice is adopted
ose.vault.recent()           -> [{ path, name, exists, current }]
ose.vault.open(path)         -> { root, name }         adopt. The caller reloads, after leaving
ose.vault.forget(path)       drop one remembered vault; no path means stop remembering at all
    There is no `ose.vault.change()`. Changing vault is a dialog, and a dialog is shell: the
    shell draws `recent()`, calls `open()` on a row and `pick()` on the button.

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
ose.files.versions.keep(path, text, opts?) / list(path) / read(path, id) / restore(path, id)
                             opts: { force?, reason? } or a boolean (the old `force`).
                             list -> [{ id, at, bytes, reason, session }], newest first; the files
                             live in `.ose/history/` and their names are the host's business

ose.files.readFile(path)     -> { text, hash, mtime, size }   the text and the hash a save compares
ose.files.save(path, text, { expectedHash, version? })  -> SaveOutcome
                             One call compares and writes, under a lock per path (docs/HOST.md
                             `saveFile`). `expectedHash` is what `readFile` (or the last save)
                             answered, or null for "the file must not exist yet"; leaving it out
                             is an error. `version`: 'save' (default, tiered), 'conflict' (forced)
                             or 'none'.
                               { status: 'saved', hash, mtime, unchanged? }
                               { status: 'conflict', disk: { exists, text, hash } }  nothing written
ose.files.createNew(path, text = '')  -> { path, hash }   exclusive: `[exists]` rather than overwrite
ose.files.copy(from, to)     -> { path, hash }         a byte copy under the same rule
ose.files.appendLine(path, line) -> { hash }           no `\n` in `line`; the separator and the
                             line ending are the file's own
ose.files.replaceLine(path, index, expected, next)
                             -> { status: 'replaced', hash } | { status: 'conflict', actual }
                             line `index` (0-based) only if it still reads `expected`
ose.files.drafts.write(path, draft) / list() / read(path) / drop(path, { ifRev? })
                             the buffer a page could not write, per machine and outside the
                             vault (D5): { text, baselineHash, mode, exact, rev }. `drop` with
                             `ifRev` drops only a draft written at or before that edit

    The hash is the host's (FNV-1a 64, 16 hex digits). JavaScript carries it from a read to a
    save and compares by equality; it never computes one. The kernel adds `{ epoch }` to the
    options of every call that changes the vault, `write`, `rename` and `trash` included.
    A host refusal is an `Error` whose `message` is the text, `.code` the host's code
    (`not_found`, `exists`, `not_utf8`, `stale_vault`, `no_vault`, `write_failed`, `bad_arg`,
    `bad_name`, `escapes_vault`, `io`, `unknown_command`) and `.cmd` the call.

ose.fileops.create(folder, name, { text?, unique? })  -> { path }
ose.fileops.rename(path, name)  -> { from, to, links }
ose.fileops.move(paths, folder) -> { moved: [{from, to}], skipped: [{path, error}], links }
ose.fileops.trash(paths)        -> { trashed: [paths], failed: [{path, error}] }
ose.fileops.duplicate(path)     -> { path }            `stem 2.ext` beside it, bytes, any type
    The one create, rename, move, trash and duplicate; the tree, the palette, the router's
    "Create it" and the editor all call these, and the name prompts are the shell's. A name is
    literal: nothing appends `.md` or strips an extension. `create` takes `a/b/c.ext` and makes
    the folders; its text defaults to `# <stem>\n` for `.md` and to nothing otherwise. Each
    operation asks the page host first (`beforePathChange`), and a page that cannot be saved
    stops it before anything moves (`code: 'not_saved'`). After the host call: the router is
    re-pointed (`ose.route.repoint`), the moved files' own relative links are rewritten while
    the page showing one is still frozen, the page is told (`afterPathChange`, with
    `rewritten` { path: hash } for the files that pass wrote), the bus says `paths:moved`
    { moves } or `paths:trashed` { paths }, and the inbound links are rewritten. None of them
    navigates. Errors carry `.code`: `bad_name`, `exists`,
    `not_saved`, or the host's.
ose.names.split(name)        -> { stem, ext }          ext without the dot; `.env` has none
ose.names.check(name, { folders? })  -> { ok: true, name } | { ok: false, reason }
                             trims, then refuses what Windows or macOS cannot hold: empty, `.`,
                             `..`, `\ : * ? " < > |`, control characters, `/` (unless folders),
                             a trailing dot or space, CON/PRN/AUX/NUL/COM1-9/LPT1-9, over 255
ose.names.free(folder, name) -> Promise<path>          the name, else `stem 2.ext`, `stem 3.ext`…
ose.names.extChanged(a, b)   -> boolean                the extensions differ, case aside

ose.watch(fn)                -> unsubscribe            fn({ changes:[{kind, path, to?}], lost?, rescan? })
                             `rescan`: the host may have missed events (the OS watcher
                             overflowed or restarted); re-read what you show
ose.watch(folders, fn)       -> unsubscribe            only changes under those folders
    `lost` is the host saying it dropped events: re-read rather than trust the list.

ose.run(cmd, args, opts)     -> Promise<{ code, stdout, stderr, timedOut }>
    opts: { cwd, timeout (ms, default 60000), env, input, onLine(line, stream),
            onStart(id, pid), id }
    `cmd` is a program name and `args` an array: never a shell. `cwd` is vault-relative and must
    be inside the vault; env is merged over a UTF-8 environment (PYTHONUTF8=1,
    PYTHONIOENCODING=utf-8, LANG=C.UTF-8, LC_ALL=C.UTF-8); the process is killed at the timeout
    and when the app exits. There is no allow list: a plugin is the vault owner's own code and
    may run any program.
    Underneath, the host answers `{ id, pid }` the moment the process starts and streams
    everything else as `run` events, ending with `{ id, done, code, timedOut }`; it buffers
    nothing. The kernel is what turns that into the one promise above, joining the lines it saw.
    `code` is null when the process was killed, and `timedOut` is true only for the timeout,
    never for a `kill`.
ose.run.kill(id)             a running process, id from opts.onStart(id, pid)

ose.route.current()          -> { type, path?, name?, line?, col?, heading? }
ose.route.navigate(route, { replace?, force?, focus? })  -> Promise<boolean>
ose.route.back() / forward() -> Promise<boolean>;  canBack() / canForward()
ose.route.close()            -> Promise<boolean>  the start surface (Ctrl+W); ose.route.reopenClosed()
    A navigation away from a page asks the page host's `canLeave` first (C1). A page that
    cannot be saved answers false, and then nothing moves: no `route` event, no change to the
    column, the tabs or the title, and the history is back as it was. The answer is false and
    the bus says `route:refused` { from, to }. A newer navigation that starts while one waits
    supersedes it. A jump to a line or a heading of the open page never asks.
ose.route.repoint(moves)     moves: [{ from, to }]. A file or folder moved and the page followed
                             it: every page route at `from` or under `from/` (the current one,
                             the history, the closed stack, the recent list, the scroll and caret
                             memories, the store's `route`, the status path, the window title)
                             now says `to`. Nothing is mounted and no `route` event goes out; the
                             bus says `route:repointed` { moves, current }
ose.route.recent()           -> [paths]
ose.route.own(pattern, mount) -> unsubscribe
    pattern like 'journal/*'. A route { type:'own', path:'journal/2026-09/03-x' } is mounted by
    mount(el, route) -> { title?, unmount? }. History, the window title, quick open rows
    (through ose.route.index(pattern, () => [{ path, title }])) and back/forward work as for
    a page. `unmount` runs on a navigation, on the unload of its plugin, and when the window
    closes or reloads, and it is awaited (the three guarantees, below).
    A pattern is a plain glob with two rules. A **trailing `/*` is greedy**: `journal/*` owns
    everything under `journal/`, at any depth, so the route above is its page: an id with a slash
    in it is a format a plugin picks. A `*` **anywhere else is one segment**: `journal/*` + `/notes`
    matches `journal/2026-09/notes` and not `journal/2026-09/03-x/notes`. `**` is greedy wherever
    it stands, for the rare pattern that needs depth in the middle. Everything else is literal,
    and the first registration wins a collision.
ose.route.index(pattern, fn) register what quick open lists for an owned pattern
ose.route.on(fn)             -> unsubscribe            fn(route) after every change
ose.route.indexed()          -> [{ path, title, pattern }]   everything the owners registered
ose.route.title(text)        the owned page's own title; the window title becomes `<text> · <vault>`,
                             and the bus carries `route:title` { route, title } for a shell that draws it elsewhere
ose.route.init(el, opts?)    the shell mounts the router into its page column, once
                             (`{ start: false }`: no empty surface on the mount)

ose.commands.register({ id, title, group, shortcut?, when?, run })  -> unsubscribe
    `shortcut` is a binding, not a printed hint: registering the command arms the chord with
    scope 'window', `ose.keys.shortcutFor(id)` answers it, and the unsubscribe takes it back
    with the command. It is written like a `keys.bind` combo ('Mod+Shift+J', 'mod+shift+j' and
    'MOD+SHIFT+J' are one chord). An explicit `ose.keys.bind` wins over a `shortcut`, and both
    win over a shell default. The one exception: a **plugin's** `shortcut` never takes a chord the
    kernel's own keymap holds (`ose.keys.defaults()`): the kernel keeps the chord, the plugin's
    command keeps none (`shortcutFor` answers null) and the console says so once, naming both.
    The shell is not a plugin and may replace a default this way, as `tab.close` replaces
    `page.close` on Ctrl+W.
ose.commands.run(id, ...args) / get(id) / list()
    `run` answers what the command's `run` answers, so a command that saves answers the
    promise and a caller can await it. With a target (a first argument that is not undefined
    or null) and an `applies(target)` on the command, `applies` decides instead of `when()`:
    a context menu runs the command on the row it was opened on, focused or not (H21).
ose.keys.bind(combo, commandId, { scope: 'window' | 'body' })  -> unsubscribe
    'mod+shift+j'; mod is Ctrl or Cmd. Shell chords are bound on the window in the capture
    phase, so nothing on the page can shadow one; a binding here replaces the default on that
    chord, and dropping the binding gives the default back. A scope 'body' chord fires only
    with the caret in a page editor. The shell's keys.json is loaded through the same call.
    Two owners may hold one chord: the last binding is the live one and dropping it uncovers the
    one under it. A **plugin's** bind never takes a chord the kernel's own keymap holds, exactly
    as a plugin's `shortcut` does not: the chord stays where it was and the console says so once.
ose.keys.shortcutFor(commandId) -> 'Ctrl+K' | null
ose.keys.defaults()          -> the shell keymap, for whoever wants to show it
ose.keys.label(combo)        -> 'mod+shift+j' as 'Ctrl+Shift+J' ('Cmd+Shift+J' on a Mac)

ose.views.register(name, { title, icon?, order?, mount(el), unmount? })  -> unsubscribe
    `unmount` belongs on the registration, and a handle `mount` answers (`{ unmount?, refresh? }`)
    is merged over it: what the handle carries wins, what it leaves out the registration still
    answers. An `async mount` is awaited before the caret is placed. The first registration of a
    name wins, as for `route.own`: another owner asking for a name that is taken keeps nothing
    and the console says so.
ose.views.list() / get(name)
ose.tiles.register({ id, title, order?, render(el) -> { refresh?, unmount? } })  -> unsubscribe
    a card on whichever view asks for tiles (the stock Day view does); render is called once
    and refresh on `ose.tiles.refresh(id)` or any watch the tile subscribes to; an id already
    registered by another owner is refused the same way a view name is
ose.tiles.list() / get(id) / refresh(id?) / mounted(id, handle) / forget(id)
    `mounted` is how the view that draws a tile hands the handle back, so a later `refresh`
    reaches it; `refresh()` with no id refreshes every tile currently on screen.
ose.status.set(field, text | { text, kind, onClick }) / clear(field)
ose.status.all()             -> [{ key, text, kind, onClick }]
ose.status.watch(fn)         -> unsubscribe            every change, with the whole list
    The bar's own five first (mode, path, doc, save, watch), then every other field in the
    order it was first set, so a plugin's `set('week', …)` is a field the bar draws.
ose.settings.get() / set(partial) / on(fn)     the shared settings object (docs/SHELL.md)
ose.settings.section({ id, title, render(el) })  -> unsubscribe   a section in the settings dialog
ose.settings.sections()      -> the registered sections, in order, for the dialog to draw
ose.settings.apply()         put fontSize, lineHeight, pageFace, zoom and readable width on
                             the document
    `pageFace` is `document` (the serif, the default) or `plain` (the interface face). It lands
    as `data-face` on <html> and tokens.css makes `--font-doc` resolve to `--font-ui` for
    `plain`, so the page column, the title strip, `render()` and paper follow it in one frame.
    Only the family moves: sizes, leading, rhythm, frames, rules and the maths face do not.
ose.settings.zoom() / setZoom(pct)                          one of 90, 100, 110, 125, 150
ose.settings.onRepaint(fn)   -> unsubscribe
    A settings dialog that is open while a chord changes a value redraws itself through this.
    The kernel does not know that dialog and never reaches into it.
ose.state(key)               -> { get(), set(value), flush() }   editor-only state in
                                .ose/state.json, one key per plugin or shell concern, written
                                debounced; a dotted key is a path into the object
ose.schedule(id, spec, fn)   -> unsubscribe
    spec: { every: 'day' | 'hour' | 'week', at: '07:00', weekday? } or { everyMs }. Runs while
    the app is open and catches up once at boot when a run was missed; the last run of each id
    is kept in state under `schedules`. Nothing runs when Ose is closed.

ose.bus.on(event, fn) / emit(event, payload)          app-wide events; plugins talk through it
ose.store.get(key) / set(key, v) / watch(key, fn)     shared reactive values (theme, focus…)

ose.search(query, { limit, chan })  -> { hits:[{ path, line, col, text, kind }], files, total,
                                         capped, stale }
    `limit: 0` is no cap. `chan` names the caller, so a newer query on the same channel abandons
    the walk the older one started. `path:` and `file:` filters are words in the query itself.
ose.links.resolve(fromPath, href) -> { path, heading } | null
ose.links.href(fromPath, target)  -> string
ose.links.inbound(path)           -> [{ path, count, lines }]
ose.links.rewriteMoved(pairs)     -> { files, links, failed: [paths] }
    Links are found with the markdown parser the editor uses (mdast, GFM, maths): an inline
    link, an image and a reference definition, and nothing inside code, an HTML comment or a
    maths span. Only the destination's bytes change. Each file is read with `readFile` and
    written with `save` against that hash, a forced version kept first; a file that changed in
    between is not written and is listed in `failed`. Only `.md` files are rewritten.

ose.paths                    no caller spells a vault path; the section below
ose.plugins                  what is in `.ose/plugins` is what runs; the section below
ose.theme.get() / set('light' | 'dark' | 'system') / on(fn) / resolved()
ose.window.title(text) / minimize() / maximize() / close() / quit() / isMaximized()
ose.window.drag() / resize(edge) / onMaximize(fn)   the frameless title bar's move, the eight resize
                             edges (top right bottom left topleft topright bottomleft bottomright),
                             and the maximised state as it changes
ose.window.onClose(fn)       -> unsubscribe
    The window is closing. `fn()` may return a promise and the host **awaits it** before the
    window is destroyed, so the open page's last save finishes; resolving `false` keeps the
    window open, which is what the editor does when the save needs an answer from the user.
    A handler that throws is logged and counts as done: the close must never hang on a bug.
ose.window.leave(reason)     -> Promise<boolean>   reason: 'close' | 'reload' | 'vault-change'
ose.window.onLeave(fn)       -> unsubscribe        fn({ reason }) -> boolean | Promise<boolean>
                             reason is also 'abandon' (below), where a string names what is lost
ose.window.stay()            a successful leave whose caller changed its mind
    The leave gate (C5), described under "Leaving the window" below.
ose.openExternal(url)        an http, https or mailto link in a note. Every other scheme is
                             refused by the host; a vault file is `ose.files.open(path)`.
ose.pages({ owned? })        -> Promise<[paths]>            every markdown page the shell offers; with
                                                         owned: true the owned routes join (quick open
                                                         wants them, a link picker does not)
    Quick open, the page picker and the editor's `[[` menu all ask here, so all three offer
    the same rows. The shell registers the list through `ose.setPageList`; with none registered
    the vault is walked instead.
ose.focus.get() / set(path) / exit() / name() / isUnder(path) / defaultNewFolder() / on(fn)
    The focused folder: what narrows the tree and the page list, and where a new page is
    created. The sidebar UI that sets it is the shell's; the value is not, because
    `ose.pages()` and `page.new` both need it. `defaultNewFolder()` reads the shell's own
    `scratch` path (`ose.paths.of('app').peek('scratch')`) and falls back to the vault root.
    Focus lasts for the session and is never restored at boot (H18). Esc leaves it from
    anywhere that is not text being edited, and while it is on the status bar carries a
    `focus` field that names the folder and leaves focus when pressed.
ose.assets.url(name)         -> the absolute URL of a kernel asset
ose.assets.origins()         -> { kernel, app, vault }      the three, as the host named them
ose.log(text, level?)        into the host log, `<stamp> <level> ui: <text>`; level 'error' |
                             'warn' | 'info' (default) | 'debug'. Never rejects
ose.reload(opts?)            -> Promise<boolean>   the page, and every plugin from disk. Leaves
                             the window first (`window.leave('reload')`) and answers false when
                             a page could not be saved; `{ skipLeave: true }` for a caller that
                             has already left. No chord (D8): "Reload plugins" in the palette
ose.uid() / debounce(fn, ms) / esc(text)   small shared helpers
ose.toast(text, kind?, ms?, opts?)  -> kill
    kind 'info' | 'ok' | 'warn' | 'err'; ms 4500 by default. `ms: 0` is sticky: no timer, no
    click-to-dismiss, Esc does not take it, and it carries a close button. `opts.actions`:
    [{ label, run }], buttons reachable with Tab; running one closes the toast. An 'err' toast
    is `role="alert"`. A failure the user must act on is sticky.
```

### Leaving the window

Everything that throws the window's document away asks one gate first: the close button,
`ose.reload()`, Change vault, a second launch that names another folder. `ose.window.leave(reason)`
runs every `onLeave` handler and awaits all of them, with no time limit (after three seconds a
sticky "Still saving…" toast says why the window is still there). The editor's handler saves
every open page.

- One handler answers false, or rejects: the window stays. The bus says `window:stay` and
  `window:refused` { reason }, a sticky error toast says "Not closed (reloaded, switched): a page
  could not be saved." with [Show] (`page.show-problem`) and, for a close, [Close anyway]
  (`app.close-anyway`, "Close window without saving"). The answer is false.
- All of them let go: for a reload or a vault change the view on screen is unmounted and the
  state file flushed (a close does both in the router's own `closing` handler). The bus says
  `window:leaving` { reason } and the answer is true. The pages stay frozen: the caller goes,
  or calls `ose.window.stay()`, which says `window:stay` and puts an unmounted view back.

One leave runs at a time; a second call while one waits answers the same promise. The kernel
itself subscribes the Tauri close fan-out to `leave('close')`.

`app.close-anyway` destroys the window without the fan-out, and it is in the palette at any time,
not only after a refusal. Before it does, every `onLeave` handler hears `{ reason: 'abandon' }`:
the window goes whatever it answers, so a handler keeps what it holds somewhere that outlives the
window (the editor writes a draft of every dirty page) and answers true once it is kept. `false`,
a rejection, no answer within five seconds, or a string (or strings) naming the page means it is
not. When anything is not kept, a confirm names it ("… has unsaved text that could not be kept
anywhere. Closing now loses it.") and Cancel keeps the window (`window:stay`). The drafts are
outside the window and survive it.

### Errors reach the log

Every `error` and `unhandledrejection` on the window goes to the host log at level error, with
the message, the source line and the stack (at most thirty a minute, then one line saying how
many were dropped). The kernel logs its own file operations, the leave gate's answers, a failed
state write and every `files.save` that did not end in `saved`.

Three of the hoses are the other way round: things the **shell hands the kernel**, once, so that
the kernel can stay ignorant of both the editor and the sidebar. None is for a plugin.

```
ose.init({ page, keys, theme, start })   -> the one call the shell makes once its surfaces exist:
                                     mounts the router into `page`, starts the key engine and
                                     the theme. Each part can be switched off. `start: false`
                                     mounts the router without drawing the empty surface, for a
                                     shell that opens on a home of its own: the column stays
                                     blank until it navigates, instead of flashing the kernel's
                                     surface away under it on every boot.
                                     `ose.route.init(el, { start })` is the same option.
ose.setPageHost(host)             -> unregister    whoever draws a markdown page:
    { open(el, path, opts), canLeave(reason), stay(), close(), scrollToLine(line, col),
      selection(), headingLine(text, h), beforePathChange(change), afterPathChange(change),
      claims(path) }
    The router never imports `ose:editor`; the shell joins them here. With no page host the
    router shows the file as text and navigation still works. Every method but `open` is
    optional, and a missing one means "yes" or "nothing to do".
      canLeave('navigate') -> Promise<boolean>   false: the page stays, the router changes nothing
      stay()                                     undo the freeze a true canLeave left
      close() -> Promise<boolean>                false: still mounted, the column is not cleared
      beforePathChange({ kind, from, to }) -> Promise<{ ok, reason? }>   before a rename, move,
                                                 trash or copy (`kind`); ok:false stops it
      afterPathChange({ kind, from, to, ok, rewritten? })   after the host call, whether it
                                                 worked or not; `rewritten` { path: hash }: moved
                                                 files whose own links fileops rewrote before
                                                 this call, the hash the disk now holds
      claims(path) -> boolean                    true: a missing path is drawn by the host itself
                                                 (a media file), not by the router's "not found"
ose.setPageList(fn)               -> unregister    fn() -> [paths], what `ose.pages()` answers
```

## `ose.paths`: nothing spells a vault path

An owner declares what it needs by name and asks for it by key; the kernel finds it in the tree,
asks the user once when the name is not enough, and keeps the answer. The spec shape and the
missing box are `docs/PLUGINS.md`; this is the kernel-level surface.

Only a saved choice and exactly one exact name match ever resolve. A name that merely contains the
one asked for is a candidate on the row and a one-click button in the box, never an answer: a
plugin reading the wrong folder in silence is worse than a box asking one question.

A choice made by one owner answers every owner that declared the same thing (the same kind, name
and `ext`), so the user is asked once and not once per plugin. It is resolved, not copied: the
row says which owner it came from (`sharedFrom`), and that owner's `reset` releases it for
everyone.

```
ose.paths.declare(owner, specs) -> [keys]      declaring again replaces the spec and keeps the
                                               choice already saved
ose.paths.of(owner)             -> { get, peek, choose, reset, list, on }    the scoped object
ose.paths.all()                 -> every row of every owner, for Settings
ose.paths.on(fn)                -> unsubscribe    every owner's changes; the scoped `on` hears
                                                  one owner's. Each change is also `paths` on
                                                  the bus, `{ owner, key, path }`.

scoped:
  await get(key, { el })  -> path | null    with `el`, a null also draws the missing box into it
  peek(key)               -> path | null    synchronous, off the cached tree
  await choose(key)       -> path | null    the picker; null on cancel
  reset(key)                                forgets the saved choice
  list()                  -> rows
  on(fn)                  -> unsubscribe    fn({ owner, key, path })

row = { owner, key, kind: 'file'|'folder', name, ext, label, hint, path, saved, status,
        candidates, sharedFrom }
status = 'ok' | 'missing' | 'ambiguous'   `path` is null unless `ok`; `ext` is null for a folder
candidates                                what the box would offer: the several exact matches,
                                          or the names that only contain the one asked for
sharedFrom                                the owner whose saved choice answered, else null
```

A plugin's `ose.paths` is `ose.paths.of(<its id>)` and sees only its own keys. The shell declares
its own under the owner `app`: `scratch`, the folder new pages land in. Choices are saved under
`plugins.<id>.paths.<key>`, and `app.paths.<key>` for the shell.

A choice made **in the box** mounts the route on screen again, so the view that drew the box
reads the path it now has. A `choose` or `reset` called from code saves, emits and leaves the
route alone: a dialog is over a page that asked for nothing and must not be torn down under it.

## `ose.plugins`

```
ose.plugins.load()      -> Promise<rows>    the shell calls it once, after its surfaces exist
ose.plugins.list()      -> rows
ose.plugins.unload(id)  -> Promise<boolean>
ose.plugins.get(id)     -> the loader's entry, or null. Debugging only; nothing in the app
                           reads it.
ose.plugins.folder      '.ose/plugins'

row = { id, name, description, state: 'active' | 'disabled', error?, single, views }
views = [{ name, title, order }]   read off the view registry by the plugin tag, so a disabled
                                   plugin has none: there is no manifest to promise a view that
                                   never registered
```

`load()` lists `.ose/plugins`, imports each entry from the app origin (`/plugins/<id>/index.js`
or `/plugins/<id>.js`), declares its `paths`, links its `style.css` when it has one, and calls
`activate(facade)`. Plugins load independently and concurrently. One that throws, or whose
`activate` has not settled ten seconds later, is disabled for the session: whatever it registered
is taken back, a toast names it, `list()` carries the error, and the rest of Ose is untouched.
The whole contract is `docs/PLUGINS.md`.

A plugin's `activate` receives a **facade** of `ose`: the same object with four things of its own
and no guard anywhere else.

```
plugin   { id, name, folder }    the folder as a vault path, a legal `cwd` for `ose.run`
state    ose.state(key) mapped onto `plugins.<id>.<key>`; `paths` under it is the kernel's
paths    ose.paths.of(<id>)
tagging  commands.register, views.register, tiles.register, settings.section, keys.bind, bus.on,
         route.own/index/on, watch and schedule all carry the plugin id; every other `on` and
         `watch` it can subscribe through (settings, theme, focus, paths, store, status, vault
         and window) and every status field it set are taken back on unload the same way
```

`ose.plugins.unload(id)` takes back every one of those, unmounts the page it has on screen, kills
the processes it started, unlinks its stylesheet and calls `deactivate()` once, and only if the
plugin was handed the facade; unloading an already unloaded plugin does nothing. It answers a promise:
the unmount is awaited inside it, so the plugin's last write is finished first. The paths it
declared are left standing, so Settings still lists what a disabled plugin needs. A plugin may not
write anywhere outside the vault, because nothing can: `ose.files` is the vault and only the vault.

### The three guarantees for a page that keeps a clock

A view's or an owned route's `unmount` is the one place a plugin can stop what it started, so the
kernel promises exactly three things about it:

1. **It is awaited, for up to five seconds.** The router waits for the promise `unmount` answers
   before it mounts the next page, the way it waits for the editor's `close()`. A throw is caught
   and logged and the next mount still proceeds. A synchronous `unmount` is unchanged. The wait is
   bounded: an `unmount` that has not settled after five seconds is left running, a toast names
   the page that would not close, and the next page is drawn, because a plugin that hangs must not
   take the column, the close button and every later navigation with it.
2. **It runs on the unload of its plugin.** `ose.plugins.unload(id)` unmounts the page before
   `deactivate`, and leaves the column on nothing; what nothing means is the shell's business
   (the stock shell puts its home there).
3. **It runs when the window closes or reloads.** A reload and a change of vault go through the
   leave gate ("Leaving the window"), which awaits the unmount and flushes the state file before
   the document goes. The window's `closing` notice unmounts the view or owned route on screen
   and then flushes the state file, beside the gate's own `leave('close')`. `pagehide` does
   the same as a last resort; on that path nothing can be awaited, and only what `unmount`
   finishes synchronously is certain to be written, which is why a page that counts time banks
   on a timer as well (docs/PLUGINS.md rule 5). The editor is not unmounted here: it answers the
   gate's `onLeave`, saving every page, and may veto.

## `ose:editor`

```js
import { markdownPage, codeEditor, render, renderMath } from 'ose:editor'

markdownPage(el, path, opts)  -> { close(), save(o), canLeave(reason), stay(), path, dirty, mode,
                                   state, focus(), find(query), on(event, fn) }
    the block editor as it exists: title strip, properties, autosave, changed-on-disk dialog,
    versions, the Rich | Source switch (Ctrl+E), find and replace, drop, links, backlinks,
    every command.
    opts: { line, col, heading, selection, readOnly }
    Registers its commands on mount and removes them on close; the shell's page route mounts it.
    save(o?: {explicit, closing}) -> Promise<boolean>: true only when the disk holds the buffer
    (written, or nothing to write); every other outcome, a failed write, a conflict not
    resolved, a guard verdict of unsafe, a deleted or read-only page with a dirty buffer, is
    false. canLeave(reason) -> Promise<boolean> freezes the page and saves it if dirty; false
    leaves it editable, shows the banner and writes the draft. stay() undoes the freeze of a
    true canLeave. close() -> Promise<boolean> runs canLeave first; false keeps the page and
    tears nothing down. mode is 'rich' | 'source'. state is the DocState below.
    on() takes 'state', 'mode', 'recovered', 'guard', 'saved', 'dirty', 'conflict', 'title'
    and 'closed'.
beforePathChange({ kind, from, to }) -> Promise<{ ok, reason? }>
afterPathChange({ kind, from, to, ok, rewritten? }) -> Promise<void>
    module level, acting on every mounted page at `from` or under `from/` (the page host of
    the shell forwards to them; ose.fileops asks them). before: freeze and save; a page that
    cannot be saved answers { ok:false, reason:'<name> has unsaved changes that could not be
    saved' } and nothing is touched. `copy` only flushes. after, ok: the page follows its file
    to the new path in place, buffer, caret and undo kept; a trashed page is marked clean.
    `rewritten[newPath]`, when present, is the hash of the file after fileops rewrote its own
    relative links (a page moved to another folder): the page, still frozen and clean, takes
    that disk text as its baseline before it thaws, so the rewrite is not seen as an outside
    change.
saveAll({ explicit, closing }) -> Promise<boolean>
    every page saved; false when any one could not be. The editor answers ose.window.onLeave
    with it, so the window never closes, reloads or switches vault over unsaved text.
    Bus events, for every mounted page: 'doc:state' DocState = { path, status: 'clean' |
    'dirty' | 'saving' | 'not-saved' | 'conflict' | 'deleted', dirty, reason, message, draft,
    mode, savedAt }; 'doc:dirty' { path, dirty } and 'doc:saved' { path } as before;
    'doc:mode' { path, mode, forced: null | 'plain' | 'unsafe' | 'lossy-open' };
    'doc:recovered' { path, at, applied } when a draft was found at open.
    Commands: page.save and page.close answer their promise; page.save-as, page.discard-changes,
    page.show-problem, page.recovered-compare, page.recovered-restore, page.view-source and
    page.view-rich are new; page.source-toggle is 'Switch between rich view and source (raw
    markdown)'. page.rename, page.trash and page.duplicate are gone: the shell's file.* do it.
codeEditor(el, { path | text, language, readOnly, grow, gutter, indent, placeholder,
                 onChange, onSave })
    -> { path, dirty, readOnly, ready, getText(), setText(), setReadOnly(), save(), focus(),
         close(), on(event, fn) }
    CodeMirror with highlighting from the language pack, the same atomic save and conflict
    handling when `path` is given; plain in-memory when `text` is given. `on` takes `dirty`,
    `saved`, `conflict` and `closed`; `ready` resolves when the file and its language are in.
    `language` is a name or an alias from the pack, and without one the file name decides.
    `save()` resolves **true when there is nothing left unwritten**, and false whenever text
    the user typed is still only in the editor: a conflict they cancelled, a file no longer
    on disk, a keystroke that landed while the write was in flight. A caller may move on
    exactly when it answered true. `close()` saves once, asks before losing anything it could
    not write, and resolves **false when the user chose to keep editing**: the editor is
    then still mounted and still theirs; `close({ force: true })` closes regardless.
    `setText()` is an edit: it marks the editor dirty, so the save after it writes.
    A path editor is read-only until its file arrives, and the file never replaces text that
    was already put into the buffer. The file's line endings are its own: a CRLF file is
    written back CRLF and one keystroke in it does not reformat the rest (a file that mixes
    both settles on its majority the first time it is written). Undo does not walk back past
    the file into the empty buffer the editor mounted with.
    `grow: true` gives the editor the height of its text and no scroller of its own, so the
    column around it scrolls: that is the bargain source mode makes with the page column. An empty
    file still stands five lines tall. The default fills the element it is given and scrolls
    inside it, which is right when the caller owns the height and wrong when it does not.
    `gutter: false` takes the line numbers away. `indent` is what Tab inserts: four spaces
    for Python, two for everything else, unless it is given.
    It is a very small IDE and nothing more. Line numbers; the line under the caret carries a
    faint stripe while the editor holds the caret; the bracket under the caret is marked and so
    is its partner; every other occurrence of what is selected is marked faintly; brackets close
    as they are typed and Backspace between an empty pair takes both; the line re-indents when
    the language says the word that ends a block has been typed; Tab and Shift+Tab indent and
    dedent (Tab with nothing selected inserts one indent at the caret, Tab over a selection
    indents the block); Ctrl+/ comments and uncomments the lines the selection touches, in the
    language's own syntax; Ctrl+F is find and replace; Ctrl+Z and Ctrl+Y undo and redo; there
    can be more than one cursor (Ctrl+Alt+Up and Down, Ctrl+D for the next occurrence,
    Ctrl+click). No completion popup, no lint, no fold gutter, no minimap.
    Escape leaves the text and puts the keyboard on the page around it, so Tab from there
    carries on through the app and the editor is never a trap; Ctrl+M is CodeMirror's own
    toggle for making Tab move the focus without leaving.
    Source mode inside a page is exactly this editor for a file the pack knows by its name. A
    `.md` page in source mode gains the Tab behaviour, which is a fix and not a comfort, and
    none of the rest, and a `.txt` or a `.log` stays the plain text it is.
    Ctrl+S saves from anywhere inside the editor, its own Find panel included: the key engine
    stands down for `mod+s` and `mod+f` inside `.ed-code` (a page's fenced block is not
    `.ed-code`, so there Ctrl+S still saves the page).
    Colours are the `--code-*` tokens, the same palette a fenced code block in a page is
    drawn with, in both themes.
renderMath(tex, { display })  -> HTMLElement
    one formula, rendered with Temml to MathML: a `<span class="ose-math">` or, with
    `display: true`, a `<div class="ose-math ose-math-display">`. The browser lays MathML out in
    the platform's maths face (`Cambria Math` on Windows), which is the face Word's equation
    editor uses, so a formula and the page's serif text are one document. It never throws and
    never loses the text: TeX Temml refuses comes back as its own source in the error colour,
    with Temml's message on the element's `title`. A plugin that draws a statement of its own
    calls this; `render()` and the page editor already do.
render(markdown, { basePath, onLink, codeLanguage })  -> HTMLElement
    read-only, links resolved, images through vault.localhost, and fenced code coloured with
    the same grammars and the same `--code-*` tokens the editor uses. `codeLanguage` is the
    language assumed for a fence that names none; a fence that names one always wins, and a
    block with neither, or with a name the pack does not have, stays plain text.
    `render` is synchronous and stays synchronous: the element it answers is complete before
    any grammar is asked for, and a block is repainted where it stands once its grammar lands.
    A grammar that will not load colours nothing and throws nothing.
    A Python transcript keeps its shape rather than being read as a program: the `>>>` and
    `...` prompts are drawn in the comment ink, only what follows a prompt is parsed, and the
    interpreter's answer keeps the body colour.
    Maths is read by the same rule the page editor reads, so a `$` means one thing in the app.
    A plain newline inside a paragraph is a line break, as the page editor reads it (marked
    `breaks: true`); two trailing spaces and a trailing `\` break too.
```

The stylesheet is `editor.css` on the kernel origin. Tokens come from `ui.css`.

### Space

A blank line separates two blocks, which is all markdown means by one. A second blank line means
nothing to markdown, so here it means space the writer put there: **a run of N blank lines
between two blocks is N minus 1 empty paragraphs**. In the editor each of them is a real block
the caret goes into, Backspace takes away and typing fills, so pressing Enter twice at the end of
a paragraph leaves one line of space, as in Word. Nothing is swept: what is on screen is in the
file and what is in the file is on screen, at every keystroke.

The rule is `space.js`, in three pieces. A remark transformer reads the blank lines back off the
source positions after the file is parsed, at the top level and inside a blockquote, where a
blank line is written `>` on a line of its own. A `join` rule in `stringify.js` makes an empty
paragraph cost exactly one more blank line than none. And the landing pad — the empty paragraph
the editor keeps after a table, a code block or a display formula, so there is somewhere to type
— is remembered rather than guessed, and is never written.

Inside a list item and inside a table cell a blank line keeps the meaning markdown gives it (it
makes a list loose) and no empty paragraph is read there. `render()` reads the same rule from
marked's `space` token, so a note shown read-only has the shape it has in the editor and on
paper.

### Writing

A page is written only when reading the text back gives the document on screen (`guard.js`
`checkWrite`): the reconciled text first, then the same reconciled from the serializer's raw
output, then the canonical text; if none reads back equal the page writes nothing and opens the
text in Source, dirty, with a banner, and a draft keeps it. At open, `checkOpen` asks whether the
rich view holds everything the file says, and a file it cannot hold opens as text. Hard breaks
keep the file's own spelling (bare newline, two spaces or a backslash). An html block always has
its paragraph to itself.

Every save is one host call, `ose.files.save(path, text, { expectedHash })`, with the hash the
page read the file at: the host writes only if the disk still holds what the page was based on,
and a change on disk is a conflict the page asks about, never an overwrite. A buffer that is not
on disk, after a failed write, a conflict, a deleted file or a refused leave, is kept as a draft
on this machine (`ose.files.drafts`, outside the vault); the next open of that page offers it
back, and a clean save drops it.

### Maths

`$...$` is a formula and `$$...$$` is a display formula, by pandoc's rule: an opening `$` is
followed by a character that is not a space, a closing `$` is preceded by one and is not followed
by a digit. So `$u_n$` is maths, `Un prix de 5 $ puis de 10 $` is text and so is
`$20,000 and $30,000`; `\$` is a literal dollar, `$$` inside a paragraph is two of them, and
nothing inside a code span or a fenced block is ever maths. A display formula is `$$` at the
start of a block closed by the first `$$` with nothing but whitespace after it on its line, so
`$$x$$` and a `$$` fence over several lines are both display formulas and each writes itself back
as it was written; a `$$` that never closes, or one on the line under a sentence, stays text.
One rule, read by all three surfaces: the block editor (`math.js` as a micromark extension
through remark, `math-node.js` for the nodes), `render()` (the same rule as a marked extension),
and `renderMath` for a plugin.

In the block editor a formula is an atom holding its TeX in one attribute, `math_inline` or
`math_block`, and nothing holds a second copy. It shows rendered; a click or the caret arriving
on it shows the TeX in place in the code face; Enter in an inline formula, Escape, an arrow key
out of either end, or the caret going anywhere else commits it and renders it again. In a
display formula Enter is a new line and Escape commits, because `\begin{aligned}` needs one. The
commit is one transaction, so undo takes a formula back in one step. Typing `$x^2$` and closing
the dollar makes a formula, `$$` on an empty line opens a display one, copying one copies its TeX
with its dollars, and an empty one is deleted rather than written. A file opened and saved
without touching a formula keeps every byte: the serializer escapes every `$` in running text and
`postProcess` takes the backslashes off again wherever the whole line proves that changes no
formula (`stringify.js`, `dollarsSafe`), and a display formula is a fence to that clean-up
exactly as a code block is.

### Code

Every language in CodeMirror's pack is there, loaded from a chunk of its own the first time
something asks for it, and the same table answers all three surfaces: a fence's name in a page,
a file's name in the column, and `codeLanguage` in `render`. So `python`, a `.py` file and a
statement's examples are coloured by one set of rules. A file whose extension the pack does not
know opens as plain text, which is what it is.

## `ose:ui`

```js
import { openOverlay, focusField, prompt, confirm, choose, pickPage, pickFolder, pickFile,
         contextMenu, toast, dismissToast, copyText, icon, esc } from 'ose:ui'
```

The dialogs, the overlay stack (Esc closes the newest; focus returns where it was), the context
menu, toasts, the fuzzy picker, the icon set, and `esc` for HTML. `ui.css` carries `tokens.css`
and `base.css`: every colour, font, size and the spacing scale, and the rules for everything in
this list, plus the missing box `ose.paths` draws. Whoever links `ui.css` and calls `toast()` gets
a styled toast without shipping a line of CSS. A plugin overrides tokens in its own stylesheet and
never writes a hex value.

An overlay takes the keyboard the moment it is opened: `openOverlay` focuses its box before it
answers, so a key typed right after the chord that opened it never reaches the page behind.
`focusField(box, el, then?)` puts the focus on the overlay's own field in the same task (and
once more after a task, only if it did not take); every dialog here uses it, and a surface that
builds its own input on `openOverlay` should too.

`ose:ui` is a **facade over `ose:kernel`**: the file served at `<kernel origin>/ui.js` is a list of
names and no code. It has to be, because the kernel's own router, key engine and plugin loader
raise these same dialogs and these same toasts, and a second copy of them in the window would be a
second overlay stack, with Esc closing the one that is not on top. The import map line, the served
file and everything in this section are exactly as they read; only the inside differs. `ose:md` is
pure parsers with no state, so that one is a bundle of its own.

## `ose:md`

```js
import { ymd, parseDate, addDays, naturalCompare, firstH1, readJsonl, parseFrontmatter,
         splitDoc } from 'ose:md'
```

Generic helpers only: nothing here knows a particular file.

```
pad ymd ym parseDate startOfDay addDays addMonths sameDay dayIdx startOfWeek startOfMonth
endOfMonth daysBetween monthDays monthName DAY_SHORT DAY_LONG dayTitle ddmm hhmm dur until
naturalCompare firstH1 pickDatedFile parseJsonl (readJsonl) parseFrontmatter splitDoc
```

The parsers for the stock files (a timetable, a monthly plan, a task list) are not here: they are
plain files in `.ose/plugins/_lib/`, owned by the plugins that read them.

## The host underneath

docs/HOST.md: one `rpc` command, the three origins, the vault protocol, the watcher, file
versions, `run`, single instance. The kernel never depends on a command the host may have
dropped: an unknown name answers `null`.

## Rules

- A hose is added, never changed in meaning. A breaking change is the next `ose.api`.
- The kernel never draws and ships no HTML at all.
- Nothing in the kernel knows a view, a plugin or a file name of the shell. It serves and it
  answers.
