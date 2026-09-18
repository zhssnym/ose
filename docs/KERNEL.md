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
ose.vault.onChange(fn)       -> unsubscribe  a second launch named another folder and the host adopted it
ose.host                     'tauri' | 'webview' | 'browser'   whether window buttons, quit and drag are live
ose.vault.pick()             -> { root, name } | null  native picker; reloads the app
ose.vault.recent()           -> [{ path, name, exists, current }]
ose.vault.open(path)         -> { root, name }         adopt; reloads the app
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
ose.files.versions.keep(path, text, force?) / list(path) / read(path, id) / restore(path, id)

ose.watch(fn)                -> unsubscribe            fn({ changes:[{kind, path, to?}], lost? })
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
ose.route.navigate(route, { replace? })
ose.route.back() / forward() / canBack() / canForward()
ose.route.close()            the start surface (Ctrl+W); ose.route.reopenClosed()
ose.route.recent()           -> [paths]
ose.route.own(pattern, mount) -> unsubscribe
    pattern like 'nsi/*'. A route { type:'own', path:'nsi/chapitre-1/03-x' } is mounted by
    mount(el, route) -> { title?, unmount? }. History, the window title, quick open rows
    (through ose.route.index(pattern, () => [{ path, title }])) and back/forward work as for
    a page. `unmount` runs on a navigation, on the unload of its plugin, and when the window
    closes or reloads, and it is awaited (the three guarantees, below).
    A pattern is a plain glob with two rules. A **trailing `/*` is greedy**: `nsi/*` owns
    everything under `nsi/`, at any depth, so the route above is its page: an id with a slash
    in it is a format a plugin picks. A `*` **anywhere else is one segment**: `nsi/*` + `/notes`
    matches `nsi/chapitre-1/notes` and not `nsi/chapitre-1/03-x/notes`. `**` is greedy wherever
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
ose.keys.bind(combo, commandId, { scope: 'window' | 'body' })  -> unsubscribe
    'mod+shift+j'; mod is Ctrl or Cmd. Shell chords are bound on the window in the capture
    phase, so nothing on the page can shadow one; a binding here replaces the default on that
    chord, and dropping the binding gives the default back. A scope 'body' chord fires only
    with the caret in a page editor. The shell's keys.json is loaded through the same call.
ose.keys.shortcutFor(commandId) -> 'Ctrl+K' | null
ose.keys.defaults()          -> the shell keymap, for whoever wants to show it
ose.keys.label(combo)        -> 'mod+shift+j' as 'Ctrl+Shift+J' ('Cmd+Shift+J' on a Mac)

ose.views.register(name, { title, icon?, order?, mount(el), unmount? })  -> unsubscribe
    `unmount` belongs on the registration: the router keeps the registered object and calls
    `unmount` on it, not on whatever `mount` answered.
ose.views.list() / get(name)
ose.tiles.register({ id, title, order?, render(el) -> { refresh?, unmount? } })  -> unsubscribe
    a card on whichever view asks for tiles (the stock Day view does); render is called once
    and refresh on `ose.tiles.refresh(id)` or any watch the tile subscribes to
ose.tiles.list() / get(id) / refresh(id?) / mounted(id, handle) / forget(id)
    `mounted` is how the view that draws a tile hands the handle back, so a later `refresh`
    reaches it; `refresh()` with no id refreshes every tile currently on screen.
ose.status.set(field, text | { text, kind, onClick }) / clear(field)
ose.status.all()             -> [{ key, text, kind, onClick }]
ose.status.watch(fn)         -> unsubscribe            every change, with the whole list
    The bar's own five first (mode, path, doc, save, watch), then every other field in the
    order it was first set, so a plugin's `set('nsi', …)` is a field the bar draws.
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
ose.links.inbound(path)           -> [{ path, count }]
ose.links.rewriteMoved(pairs)     -> { files, links }

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
ose.assets.url(name)         -> the absolute URL of a kernel asset
ose.assets.origins()         -> { kernel, app, vault }      the three, as the host named them
ose.log(text)                                                 into the host log
ose.reload()                                                  the page, and every plugin from disk (Ctrl+R)
ose.uid() / debounce(fn, ms) / esc(text) / toast(text, kind?, ms?)   small shared helpers
```

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
    { open(el, path, opts), close(), scrollToLine(line, col), selection(), headingLine(text, h) }
    The router never imports `ose:editor`; the shell joins them here. With no page host the
    router shows the file as text and navigation still works.
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
`activate(facade)`. Plugins load independently and concurrently. One that throws is disabled for
the session: whatever it registered is taken back, a toast names it, `list()` carries the error,
and the rest of Ose is untouched. The whole contract is `docs/PLUGINS.md`.

A plugin's `activate` receives a **facade** of `ose`: the same object with four things of its own
and no guard anywhere else.

```
plugin   { id, name, folder }    the folder as a vault path, a legal `cwd` for `ose.run`
state    ose.state(key) mapped onto `plugins.<id>.<key>`; `paths` under it is the kernel's
paths    ose.paths.of(<id>)
tagging  commands.register, views.register, tiles.register, settings.section, keys.bind, bus.on,
         route.own/index/on, watch and schedule all carry the plugin id
```

`ose.plugins.unload(id)` takes back every one of those, unmounts the page it has on screen, kills
the processes it started, unlinks its stylesheet and calls `deactivate()`. It answers a promise:
the unmount is awaited inside it, so the plugin's last write is finished first. The paths it
declared are left standing, so Settings still lists what a disabled plugin needs. A plugin may not
write anywhere outside the vault, because nothing can: `ose.files` is the vault and only the vault.

### The three guarantees for a page that keeps a clock

A view's or an owned route's `unmount` is the one place a plugin can stop what it started, so the
kernel promises exactly three things about it:

1. **It is awaited.** The router waits for the promise `unmount` answers before it mounts the
   next page, the way it waits for the editor's `close()`. A throw is caught and logged and the
   next mount still proceeds. A synchronous `unmount` is unchanged.
2. **It runs on the unload of its plugin.** `ose.plugins.unload(id)` unmounts the page before
   `deactivate`, and leaves the column on nothing; what nothing means is the shell's business
   (the stock shell puts its home there).
3. **It runs when the window closes or reloads.** The window's `closing` notice and `pagehide`
   (Ctrl+R navigates the web view, and a browser reloads the document) both unmount the view or
   owned route on screen and then flush the state file. The editor is left to its own `closing`
   subscriber, which saves and may veto. On that path nothing can be awaited: only what `unmount`
   finishes synchronously is certain to be written, which is why a page that counts time banks on
   a timer as well (docs/PLUGINS.md rule 5).

## `ose:editor`

```js
import { markdownPage, codeEditor, render, renderMath } from 'ose:editor'

markdownPage(el, path, opts)  -> { close(), save(), path, dirty, focus(), find(query), on(event, fn) }
    the block editor as it exists: title strip, properties, autosave, changed-on-disk dialog,
    versions, source mode (Ctrl+E), find and replace, drop, links, backlinks, every command.
    opts: { line, col, heading, selection, readOnly }
    Registers its commands on mount and removes them on close; the shell's page route mounts it.
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
import { openOverlay, prompt, confirm, choose, pickPage, pickFolder, pickFile, contextMenu,
         toast, dismissToast, copyText, icon, esc } from 'ose:ui'
```

The dialogs, the overlay stack (Esc closes the newest; focus returns where it was), the context
menu, toasts, the fuzzy picker, the icon set, and `esc` for HTML. `ui.css` carries `tokens.css`
and `base.css`: every colour, font, size and the spacing scale, and the rules for everything in
this list, plus the missing box `ose.paths` draws. Whoever links `ui.css` and calls `toast()` gets
a styled toast without shipping a line of CSS. A plugin overrides tokens in its own stylesheet and
never writes a hex value.

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
