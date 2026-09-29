# The Ose kernel

Ose is one web app in Chrome: the host (the web adapter, docs/HOST.md), the kernel, the editor,
the planner and the shell (docs/SHELL.md), in one build. The kernel is the JavaScript that is
logic rather than look, built into library bundles the site serves. It never draws and knows no
view and no file name of the shell. Everything the shell and the built-in modules do, they do
through the hoses below, and nothing else. This file is the contract.

There are no plugins (W2). Day, Week, Month and Journal are `ose:planner`, a module that ships
in the build and registers through the same seams the shell uses: views, commands and a
settings section. The file formats they read are docs/FORMATS.md.

## Where the app is served

The build (X4, docs/HOST.md) writes `dist/`: the shell copied verbatim at its root, the four
library bundles and their stylesheets under `dist/ose/`, and the worker, the manifest and the
icons. Any static host serves it (Vercel, `vercel.json`); the page loads `index.html` from there,
and `npm run dev` serves the same files from the sources.

```
dist/index.html, main.js, …        the shell (shell/, copied as it is)
dist/ose/kernel.js  editor.js  planner.js  ui.js  chunks/…
dist/ose/ui.css  editor.css  planner.css
dist/sw.js  manifest.webmanifest  icons/
./vault/<vaultId>/…                the vault's files (images, PDFs, media with Range), answered by
                                   the worker from the vault; `./vault/~abs/<id>/<name>` a file
                                   outside the vault this tab opened
```

`shell/index.html` carries a static import map, which the build hashes into the page's CSP, and
literal stylesheet links:

```html
<script type="importmap">{"imports":{"ose:kernel":"./ose/kernel.js","ose:editor":"./ose/editor.js",
  "ose:planner":"./ose/planner.js","ose:ui":"./ose/ui.js"}}</script>
<link rel="stylesheet" href="./ose/ui.css">   (and editor.css, planner.css, then the shell's own)
```

In the dev server the import map is inert: Vite rewrites the `ose:*` imports to the sources, and
answers `/ose/*.css`. No file spells an origin. `ose.assets.url(name)` answers the URL of a
kernel asset on the page's own origin.

## `ose:kernel`

```js
import { ose } from 'ose:kernel'
```

One object. `ose.ready` resolves when the host has answered `platform` and `rootInfo`, and the
state file and the per-machine store are loaded. Every function that touches the host is async.

```
ose.version                  { kernel, sha, short, date }   the build stamp
ose.platform                 'windows' | 'macos' | 'linux'
ose.ready                    Promise<void>
ose.host                     'browser'             the one host there is
```

### The vault

```
ose.vault.root / .name       the open vault, filled by `ose.ready`; null while none is open
ose.vault.info()             -> { root, name, remembered, source, exeDir, logPath }   `exeDir`
                             is always null in a browser
ose.vault.epoch              the host's count of adopted vaults, as this window read it at boot.
                             Every mutating call carries it; a call from an older vault is
                             refused with `[stale_vault]` instead of landing in the new one
ose.vault.onChangeRequested(fn) -> unsubscribe  fn({ root, name }): another folder was asked
                             for. The host did not adopt it; the shell leaves the tab
                             (`ose.window.leave('vault-change')`), opens it and reloads. The web
                             adapter never sends it today; the hose stays for when it does
ose.vault.onChange(fn)       -> unsubscribe  kept for old callers; never fires any more
ose.vault.pick(opts?)        -> { root, name } | null  Chrome's folder picker. `{ adopt: false }` only chooses
                             (nothing adopted, nothing recorded); without it the choice is adopted
ose.vault.recent()           -> [{ path, name, exists, current }]
ose.vault.open(path)         -> { status: 'adopted', root, name, epoch }   adopt in this tab.
                             The caller reloads, after leaving. Or `{ focused: true, label }`:
                             another tab has that vault open (X6); nothing changed here
ose.vault.forget(path)       drop one remembered vault; no path means stop remembering at all
    There is no `ose.vault.change()`. Changing vault is a dialog, and a dialog is shell.

ose.windows.open(vaultPath?) -> { label, created }     a browser tab for the vault at `vaultPath`
                             (its `web:<id>` root), or a new tab with no vault, which opens on
                             the chooser
```

**A tab per vault** (X6, D14). There are never two tabs on one vault: the tab holds a Web Lock on
it (docs/HOST.md "Identity: vaults, roots, epochs, tabs"). Each tab has its own vault, its own
epoch, its own watcher and its own state. "Change vault…" adopts in place, unless the vault is
open in another tab, which is then said.

### Files

```
ose.files.read(path)         -> string                 the text, BOM kept, endings kept
ose.files.write(path, text)  -> null                   atomic; creates parents
ose.files.append(path, text) -> null
ose.files.readBinary(path)   -> Uint8Array
ose.files.writeBinary(path, bytes | base64) -> null
ose.files.list(path, { hidden? })  -> Entry[]          folders first, then natural name order
ose.files.tree({ hidden? })  -> Entry                  the root: `name` is the vault's, `path` ''
ose.files.stat(path, { sniff? })   -> { exists, kind, mtime, size, hidden, link?, text? }
                             `text` only with `sniff`: true when the first 8 KB hold no NUL and
                             are valid UTF-8 (a BOM allowed). The page host decides with it how
                             a file opens (H17)
ose.files.exists(path)       -> boolean
ose.files.mkdir(path)        -> null
ose.files.rename(from, to)   -> null                   case-only renames allowed
ose.files.trash(path)        -> { id, where }          the user's setting decides where (below)
ose.files.trashWhere(path)   -> { where: 'system' | 'vault' }   where `trash` would put it now
ose.files.trashList()        -> TrashItem[]            what can be restored, newest first
ose.files.copyPath(from, to) -> { path, files }        a file or a whole folder, bytes, create-only
ose.files.open(path)         -> null                   the file in a browser tab, for the types a
                                                       browser shows: only ever an explicit
                                                       command, never how a file opens
ose.files.assetUrl(path)     -> string                 `./vault/<id>/…` URL for an <img>; for an
                                                       `abs:` path, its `./vault/~abs/` URL

Entry = { name, path, kind: 'dir' | 'file', ext, mtime, size,
          hidden,                                      a dotfile, or the OS hidden attribute
          link?: 'file' | 'dir' | 'broken' | 'loop' | 'outside',   only on a link or junction
          readable?: false,                            a folder the host could not read
          children? }                                  `tree` only; never under a link
TrashItem = { id, name, original, deletedAt, kind, size, where: 'system' | 'vault' }
```

**One hide rule** (H16, docs/HOST.md). The host decides, for every path, one of three things,
and `list`, `tree`, `search` and the watcher all obey it:

- *excluded*, never listed, searched or watched whatever the setting says: `.ose` and `.git`
  anywhere, the executable and its companions at the vault root, and the atomic writer's temp
  files and office lock files anywhere;
- *hidden*, listed only with `{ hidden: true }`: a name starting with `.`, or the OS hidden
  attribute;
- *shown*: everything else. Nothing is hidden by name: `App`, `dist`, `node_modules` and
  `_Archive` are ordinary folders.

`ose.files.list`, `tree` and `ose.search` pass the user's Show hidden setting
(`settings.showHidden`) as `hidden` when the caller names none. The JavaScript keeps no list of
hidden names.

**Trash** never deletes. With the setting `trash: 'system'` a file goes to the Recycle Bin (the
Trash on macOS); where the volume has none, or the bin refuses, it goes to `.trash` in the vault
and the answer says `where: 'vault'`. `id` is what a restore takes; it is null where the
platform cannot give it back (macOS's system Trash).

```
ose.files.versions.keep(path, text, opts?) / list(path) / read(path, id) / restore(path, id)
                             opts: { force?, reason? }; the boolean `force` is gone.
                             list -> [{ id, at, bytes, reason, session }], newest first; the files
                             live in `.ose/history/` and their names are the host's business

ose.files.readFile(path, { encoding? })
                             -> { text, hash, mtime, size, encoding, bom, lossy }   the text and
                             the hash a save compares. A file that is not UTF-8 is detected and
                             decoded (X10): `encoding` is its WHATWG label ('utf-8',
                             'windows-1252', 'utf-16le', 'shift_jis', …), `bom` whether it
                             starts with one (a UTF-8 BOM stays in `text`, as always), and
                             `lossy` true when the decoded text would not encode back to the
                             same bytes: such a page opens read-only and is never saved as it
                             is. `encoding` in the options forces a decoding ("Reopen with
                             encoding…")
ose.files.save(path, text, { expectedHash, version?, encoding? })  -> SaveOutcome
                             One call compares and writes, under a lock per path (docs/HOST.md
                             `saveFile`). `expectedHash` is what `readFile` (or the last save)
                             answered, or null for "the file must not exist yet"; leaving it out
                             is an error. `version`: 'save' (default, tiered), 'conflict' (forced)
                             or 'none'. `encoding`: the one `readFile` answered, so the file is
                             written back in its own encoding (absent is UTF-8); a character it
                             cannot hold is `[unencodable]` and nothing is written. Converting a
                             file to UTF-8 is always an explicit command.
                               { status: 'saved', hash, mtime, unchanged? }
                               { status: 'conflict', disk: { exists, text, hash } }  nothing written
ose.files.createNew(path, text = '')  -> { path, hash }   exclusive: `[exists]` rather than overwrite
ose.files.createNewBinary(path, bytes | base64)  -> { path, hash }   the same, written with its
                             bytes in one call: a failure leaves no empty file behind
ose.files.copy(from, to)     -> { path, hash }         a byte copy of one file under the same rule
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
    options of every call that changes the vault. A host refusal is a `HostError` whose
    `message` is the text, `.code` the host's code (`not_found`, `exists`, `not_utf8`,
    `unencodable`, `lossy`, `stale_vault`, `no_vault`, `write_failed`, `bad_arg`, `bad_name`,
    `escapes_vault`, `not_registered`, `unsupported`, `io`, and `unknown_command` for a name
    the host does not have) and `.cmd` the call.
```

**Files outside the vault** (X7, H24, M19). A file anywhere on the machine opens in a tab of its
own, marked "outside vault". Its path in JavaScript is `abs:` and the absolute path with forward
slashes, the drive letter upper case, no `\\?\` prefix and NFC on macOS: `abs:D:/Notes/todo.md`,
`abs:/Users/h/Notes/a.md`. The host registers it for the window that opened it, for the window's
life, and refuses an `abs:` path this window did not register (`[not_registered]`).

```
ose.files.openOutside(path, { line?, activate? })  -> Promise<boolean>   an `abs:` path (a
                             file the picker or the OS handed over; a native path typed in is
                             refused): registered, then opened in a tab (one already on it is
                             reused). A file inside this vault opens as the vault file it is
ose.files.isOutside(path)    -> boolean                an `abs:` path
ose.files.pick({ title? })   -> `abs:` path | null     Chrome's file picker
ose.files.importOutside(from, to) -> { path, hash }    a registered `abs:` file copied byte for
                             byte to the vault path `to`, create-only ("Copy into the vault…")
```

On an `abs:` path these work: `read`, `readFile`, `save` (never keeps a version), `stat`,
`exists`, `readBinary`, the drafts (kept under the vault key `outside`), `open`,
`assetUrl` (read-only, the file itself) and the watcher (the file itself). Refused: versions (`[unsupported]`), rename, move, trash, duplicate, links,
backlinks and attachments. `paths.js` has the helpers: `ABS`, `isOutside`, `absOf` (the path after
`abs:`), `absFrom` (a path in the `abs:` form) and `outsideLabel` (the path without the
prefix). `clean` keeps the prefix.

### File operations and the undo journal

```
ose.fileops.create(folder, name, { text?, unique? })  -> { path, entry }
ose.fileops.mkdir(folder, name)  -> { path, entry }    the tree's and the folder view's New folder
ose.fileops.rename(path, name)   -> { from, to, links, entry }
ose.fileops.move(paths, folder)  -> { moved: [{from, to}], skipped: [{path, error}], links, entry }
ose.fileops.copy(paths, folder)  -> { copied: [{from, to}], skipped: [{path, error}], entry }
                                 bytes, a file or a whole folder; the next free name
                                 (`x 2.ext`, `folder 2`), so a copy into its own folder lands beside it
ose.fileops.paste({ mode: 'cut' | 'copy', paths }, folder)
                                 cut: `move` (a path already in `folder` stays); copy: `copy`
ose.fileops.trash(paths)         -> { trashed: [paths], items: [{path, id, where}], failed, entry }
ose.fileops.restore(ids)         -> { restored: [{id, path}], failed: [{id, error}], entry }
                                 never overwrites: a place taken again fails `[exists]`
ose.fileops.trashList()          -> TrashItem[]
ose.fileops.duplicate(path)      -> { path, entry }    `stem 2.ext` beside it, bytes, any type
ose.fileops.importEntries(entries, folder, { onProgress? })
                                 -> { created, failed: [{path, error}], files, entry }
                                 files and folders dropped from the OS (§5.5 of the wave-3
                                 contract), byte for byte, one undo step
```

**Importing a drop.** The shell turns an OS drop into `entries: [{ path, kind, file? }]`, `path`
relative inside the drop (`Photos/2024/a.jpg`), walking folders itself. Every file lands as its
bytes through the create-only `createNewBinary`, so a BOM, CRLF or a file in another encoding
arrives exactly as it was, and a failure leaves no empty file. A top-level name that is taken
gets the next free one (`x 2.ext`, `folder 2`), and a folder keeps that name for its whole
subtree; nothing is written over. A file over 64 MB is refused ("too large to copy by drop; copy
it in Explorer/Finder", `code: 'too_large'`), and so is a name no file can have; each refusal is
listed and the rest still land. `onProgress(done, total)` is called after each file. `created`
is the top-level paths now in `folder`, `files` how many files were written. The one journal
entry ("Copied 3 items into Notes") trashes, on undo, each top-level item that is still what the
drop left.

**Outside the vault.** Rename, move, trash and duplicate refuse an `abs:` path with
`code: 'outside'` and `reason: 'outside'`, touching nothing (move and trash list it under
`skipped` and `failed`). `copy` of an `abs:` path into a vault folder goes through
`importOutside`.

The one create, new folder, rename, move, copy, trash, restore and duplicate; the tree, the
folder view, the palette, the router's "Create it" and the editor all call these, and the name
prompts are the shell's. A name is literal: nothing appends `.md` or strips an extension.
`create` takes `a/b/c.ext` and makes the folders; its text defaults to `# <stem>\n` for `.md`
and to nothing otherwise.

Every operation that moves or removes a path asks the page host first (`beforePathChange`), and
a page that cannot be saved stops it before anything moves (`code: 'not_saved'`). After the host
call: the router is re-pointed (`ose.route.repoint`), the moved files' own relative links are
rewritten while the page showing one is still frozen, the page is told (`afterPathChange`, with
`rewritten` { path: hash } for the files that pass wrote), the bus says so, and the inbound
links are rewritten (below). None of them navigates. Errors carry `.code`: `bad_name`,
`exists`, `not_saved`, or the host's.

Bus events: `paths:created` { paths }, `paths:moved` { moves }, `paths:copied` { pairs },
`paths:trashed` { paths, items }, `paths:restored` { items }.

**The journal** (M17). Every operation that changed something is written down as the steps that
undo it, and its result carries that `entry`, so a toast can offer [Undo]. Session memory only,
newest first, at most fifty.

```
ose.fileops.journal.list()       -> JournalEntry[]
ose.fileops.journal.canUndo()    -> boolean            the newest entry not undone yet is undoable
ose.fileops.journal.undo(id?)    -> { ok, entry, failed: [{ step, error }] }   no id: that entry,
                                 so repeated Ctrl+Z walks back; an entry that cannot be undone
                                 stops the walk. With an id (a toast's [Undo]): that entry,
                                 refused while a newer entry not undone touches the same paths
ose.fileops.journal.on(fn)       -> unsubscribe        also bus `fileops:journal` { entries }

JournalEntry = { id, at, verb, label, steps, undone, undoable }
    verb    'create' | 'mkdir' | 'rename' | 'move' | 'copy' | 'duplicate' | 'trash' | 'restore'
            | 'import'
    label   sentence case, real names: "Renamed notes.md to notes.txt", "Moved 3 items to
            2-learning", "Moved draft.md to the Recycle Bin"
Step = { op: 'created', path, dir, hash }
     | { op: 'moved', from, to }
     | { op: 'copied', from, to, dir, hash, manifest? }
     | { op: 'trashed', path, id, where }
     | { op: 'restored', id, path, dir, hash, manifest? }
```

`undo` walks the steps back in reverse order, each through the ordinary operation, so an open
page follows and links are rewritten back: a move goes back; a trash is restored by its `id` (a
null `id` makes the entry not undoable). A created, copied or restored path is trashed only if it
is still what the operation left, and the page is asked (and saves) before the disk is compared:
a file by its hash, or its size and time for a file that is not text; a new folder only while it
is empty; a copied or restored folder only while it holds the same entries with the same sizes
and times (`manifest`). Anything else is left in place with "changed since, left in place" or
"not empty any more, left in place". A step that fails is listed and the others still run. The
steps that were undone leave the entry, so none is applied twice; the entry is marked undone
once none is left, and until then Ctrl+Z stops at it rather than walking past to an older entry.
An undo is not journaled, and there is no redo.

### Names

```
ose.names.split(name)        -> { stem, ext }          ext without the dot; `.env` has none
ose.names.check(name, { folders? })  -> { ok: true, name } | { ok: false, reason }
                             trims, then refuses what Windows or macOS cannot hold: empty, `.`,
                             `..`, `\ : * ? " < > |`, control characters, `/` (unless folders),
                             a trailing dot or space, CON/PRN/AUX/NUL/COM1-9/LPT1-9, over 255
ose.names.free(folder, name, { dir? })  -> Promise<path>   the name, else `stem 2.ext`, `stem 3.ext`…
                             with `dir` the whole name is the stem (`v1.2 2`, not `v1 2.2`)
ose.names.extChanged(a, b)   -> boolean                the extensions differ, case and Unicode
                                                       form aside
ose.names.display(path)      -> string                 the name the chrome shows (W8, H20): the
                             file's real name with its extension, the same for every file. Only
                             the machine setting `hideMdExt` strips a `.md`, for display only.
                             '' for the vault root, where the caller says the vault's name
```

A window, a tab and the address bar name a file by its file name, never by its H1 (M13).

**Unicode form** (M49, X11). macOS hands over a name typed in Finder in form D (`é` as `e` and a
combining accent). The host sends every name out in form C on macOS (`list`, `tree`, `search`,
the watcher, `trashList`, outside opens) and takes paths in as given, since APFS ignores the
form; Windows is untouched. The kernel compares in form C: `names.js` has `nfc(s)` and
`sameName(a, b)`, a rename that only changes the form (or the case) is a rename in place, and
`links.js` resolves a link written in either form to the same file.

### The watcher

```
ose.watch(fn)                -> unsubscribe            fn({ changes: [{ kind, path, to?, dir?, hidden? }],
                                                            lost?, rescan? })
ose.watch(folders, fn)       -> unsubscribe            only changes under those folders
    Every change the hide rule does not exclude. `dir` and `hidden` say what the path is, so a
    tree can patch one row instead of walking again. `rescan`: the host may have missed events
    (the OS watcher overflowed or restarted); re-read what you show. `lost`: the vault folder
    itself went away.
    A file outside the vault that this window opened is watched too (its folder, not
    recursive), and its changes arrive with its `abs:` path, a rename as a delete and a create.
    They go to the page that shows it (the editor hears every change on the bus `fs`), never to
    the tree: `ose.watch(fn)` leaves them out, and only `ose.watch(['abs:…'], fn)` hears them.
```

### Routes

Three shapes. The fields marked * are not part of a route's identity: they say where *this*
show lands and are spent once it has been shown, so every later back and forward to that route
restores what it was left with instead.

```
{ type: 'page',   path, line?*, col?*, heading?*, query?*, selection?* }
{ type: 'folder', path /* '' is the vault root */, select?* /* a child's name */ }
{ type: 'view',   name, arg?* /* e.g. a settings section id */ }

routeKey = 'page:<path>' | 'folder:<path>' | 'view:<name>'
```

A page route's `path` is a vault path, or an `abs:` path for a file outside the vault (X7).
Mounting an `abs:` route first registers it with the host (`outsideOpen`, idempotent), so a
restored session, Recent and back or forward all work; a path the host finds inside this vault
after all is shown as the vault file it is, and a missing one gets a "Not found" box with no
"Create it". `routeKey`, `routeLabel` and the title all take `abs:` paths.

A page route opens any existing file (H17): the page host decides how, by content (the
editor, a media page, or a box for a binary file). A page route whose path turns out to be a
folder shows that folder. A missing path gets the router's box with "Create it", which is an
exclusive create; a path the page host claims (a media file) is handed to it even when missing.
A view's `mount(el, route)` receives the route, so `arg` reaches it.

```
ose.route.current()          -> the route on screen, or null
ose.route.navigate(route, { replace?, force?, focus?, tab? })  -> Promise<boolean>
                             pushes onto the active tab's history. `tab`: 'current' (default),
                             'new' (a tab of its own), or a tab id (that tab comes forward and
                             is navigated). Another tab showing the same route is not looked
                             for: that is `tabs.open`'s `reuse`
ose.route.back() / forward() -> Promise<boolean>;  canBack() / canForward()   the active tab's
ose.route.close()            -> Promise<boolean>  close the active tab (Ctrl+W)
ose.route.reopenClosed()     -> Promise<boolean>  the last closed tab, with its whole history
ose.route.setHome(route)     the route the last tab falls back to instead of the empty surface
ose.route.repoint(moves)     moves: [{ from, to }]. A file or folder moved and the page followed
                             it: every page and folder route at `from` or under `from/`, in every
                             tab's whole history and the closed tabs, the recent list, the scroll,
                             selection and caret memories, the store's `route` and the window
                             title now say `to`. Nothing is mounted and no `route` event goes out;
                             the bus says `route:repointed` { moves, current } and `tabs`
ose.route.recent()           -> [paths]           pages opened on this machine, newest first
ose.route.on(fn)             -> unsubscribe       fn(route) after every change of the route on screen
ose.route.init(el, opts?)    the shell mounts the router into its page column, once
                             (`{ start: false }`: no empty surface on the mount)
```

A navigation away from a page asks the page host's `canLeave` first (C1). A page that cannot be
saved answers false, and then nothing moves: no `route` or `tabs` event, no change to the
column, the strip or the title, and the history is back as it was. The answer is false and the
bus says `route:refused` { from, to }. A newer navigation (or a tab switch) that starts while one waits
supersedes it: the older one answers false, the entry it pushed or the step it took in its tab's
history is taken back, and a yes its page already gave is undone (`stay()`) before the newer one
parks or asks that page itself, which it waits for (at most 5 s). When the newer one stopped
waiting (a save slower than that) and has moved on, the older one's late yes is handed back only
to the page it asked, and only while that page is still on screen: never to the page that
replaced it, which may be frozen by the newer one's own question. A page the newer one parked in
the meantime is thawed by the editor when it comes back. A jump to a line or a heading of the open page never asks; the same folder with a `select`,
or the same view with an `arg`, is shown again in place.

The window title is `<file name> · <vault>` for a page (`names.display`), `<file name> — outside
vault` for a file outside the vault, `<folder name> ·
<vault>` for a folder (the vault's name at the root), `<view title> · <vault>` for a view, and the
vault's name alone on the empty surface. The mouse's back and forward buttons (4 and 5) act on
the active tab, in one handler, the kernel's.

**Folders** (H15). The kernel draws nothing: the shell registers the folder host
(`ose.setFolderHost`, below), and the router treats its handle as it treats a view's: it awaits
`unmount`, calls `refresh` on a watcher change (debounced 300 ms) and on `settings`, and
remembers `selection()` and the scroll per tab and route key, handing them back as `select` and
`scrollTop` when the folder is shown again. The recent list stays pages only.

### Tabs and their history

The kernel owns the tabs (M23): a strip of tabs, each with its own back and forward stack, and
one column that shows the active tab's current entry. `shell/tabs.js` draws the strip from
`ose.tabs.on` and registers the tab commands; it keeps no model of its own.

```
ose.tabs.list()              -> Tab[] in strip order
ose.tabs.active()            -> Tab | null
ose.tabs.open(route, { activate = true, index, reuse = true })  -> Promise<{ id, shown }>
                             `reuse`: a tab whose current route is the same is brought forward
                             instead (a line or heading the route carries still lands). A tab
                             opened with `activate: false` mounts nothing until it comes forward
ose.tabs.activate(id)        -> Promise<boolean>
ose.tabs.close(id)           -> Promise<boolean>  false: its page could not be let go, nothing changed
ose.tabs.closeOthers(id)     -> Promise<boolean>
ose.tabs.move(id, index)
ose.tabs.reopenClosed()      -> Promise<boolean>  the tab comes back with its whole history, where it was
ose.tabs.on(fn)              -> unsubscribe       fn({ tabs, active, reason }); also bus `tabs`

Tab = { id, route /* identity fields only */ | null, canBack, canForward }
```

Closing the active tab brings forward the tab used before it (else a neighbour). Closing the
last tab puts a fresh tab on Home (`setHome`), so the strip is never empty; with no Home set the
column shows the empty surface. The last tab already on nothing but Home has nothing to close.
`app.reopen-closed` "Reopen closed tab" (Ctrl+Shift+T) is the one reopen command; a tab that was
nothing but Home is not kept for it.

**How a page is left.** The router tells the page host why the page on screen goes:

| Why the page on screen goes | What the router calls |
|---|---|
| another tab is brought forward | `host.close({ park: true })`: no `canLeave`, the buffer and its undo stay alive |
| a navigation inside the tab, or closing the active tab, while another tab's current entry is the same file | `host.close({ park: true })` |
| a navigation inside the tab, or closing the active tab, otherwise | `canLeave('navigate')`, then `host.close()` (the C1 veto and rollback) |
| closing a background tab whose current entry is a page no other tab shows | `await host.release(path)`; false keeps the tab |

**After a trash.** On `paths:trashed`, every tab whose current entry is at or under a trashed
path shows `{ type: 'folder', path: <the folder that held it>, select: <its name> }` instead.
History entries are left alone.

### Session restore

The tabs, each tab's history, the active one, and each route's scroll and each folder's
selection are kept per machine and per vault (H19) and put back at the next start. On by
default; `settings.restoreSession: false` turns it off and clears what was kept.

```
ose.session.snapshot()       -> Session
ose.session.restore(session?) -> Promise<boolean>   reads `ose.local('session')` when none is
                             passed, rebuilds the tabs and mounts only the active one. False when
                             nothing usable was there, or the page on screen refused to be left

Session = { v: 1, at, active: <tab index>,
            tabs: [{ stack: Route[] /* identity fields only */, index,
                     scroll: { [routeKey]: px }, select: { [folder routeKey]: name } }] }
```

Written to `ose.local('session')`, debounced 500 ms, on `tabs`, `route` and scroll changes and
on `route:select` (a folder view says its selection moved, debounced), and flushed on `pagehide`
and by the leave gate; nothing is written until something has been shown since boot. A snapshot
reads the live scroll and the live selection of the route on screen, not only what was
remembered when a route was last left. A tab whose route no longer exists is still restored and shows the router's box when it
comes forward. The bus says `session:restored` { tabs }. The shell's start calls `restore()` when
nothing is on screen and the setting is on, and navigates Home otherwise.

### Commands, keys, views, status

```
ose.commands.register({ id, title, group, shortcut?, when?, applies?, run })  -> unsubscribe
    `shortcut` is a binding, not a printed hint: registering the command arms the chord with
    scope 'window', `ose.keys.shortcutFor(id)` answers it, and the unsubscribe takes it back
    with the command. It is written like a `keys.bind` combo ('Mod+Shift+J', 'mod+shift+j' and
    'MOD+SHIFT+J' are one chord). An explicit `ose.keys.bind` wins over a `shortcut`, and both
    win over a kernel default, as `tab.close` replaces `page.close` on Ctrl+W.
ose.commands.run(id, ...args) / get(id) / list()
    `run` answers what the command's `run` answers, so a command that saves answers the
    promise and a caller can await it. With a target (a first argument that is not undefined
    or null) and an `applies(target)` on the command, `applies` decides instead of `when()`:
    a context menu runs the command on the row it was opened on, focused or not (H21).
ose.keys.bind(combo, commandId, { scope: 'window' | 'body' })  -> unsubscribe
    'mod+shift+j'; mod is Ctrl or Cmd. Window chords are bound in the capture phase, so nothing
    on the page can shadow one; a binding here replaces the default on that chord, and dropping
    the binding gives the default back. Two owners may hold one chord: the last binding is the
    live one and dropping it uncovers the one under it. A scope 'body' chord fires only with the
    caret in a page editor. The shell's keys.json is loaded through the same call.
    **Body keys win**: while the caret is in a page editor, a chord the editor body binds itself
    (`ose.keys.defaults()` lists them, e.g. Alt+Up = `block.move-up`) goes to the editor, and a
    window binding of the same chord (keys.json's `folder.up`) applies everywhere else. Inside a
    code block and a source editor CodeMirror keeps its own chords the same way, except Alt+Left
    and Alt+Right: those are Back and Forward in a whole-file editor (a text file, Source) and
    only a code block inside a page keeps them.
ose.keys.shortcutFor(commandId) -> 'Ctrl+K' | null   what the chord does, never a chord that runs something else
ose.keys.defaults()          -> the kernel keymap and the body chords, for whoever shows them
ose.keys.label(combo)        -> 'mod+shift+j' as 'Ctrl+Shift+J' ('Cmd+Shift+J' on a Mac)

ose.views.register(name, { title, mount(el, route), unmount?, refresh?, ...extra })  -> unsubscribe
    Every extra field is kept as given (`section`, `order`, `icon`: the planner registers
    `section: 'planner'`, and Home draws the planner row from `ose.views.list()`). A handle
    `mount` answers (`{ unmount?, refresh? }`) is merged over the registration: what the handle
    carries wins. An `async mount` is awaited before the caret is placed. The first registration
    of a name wins; a second keeps nothing and the console says so.
ose.views.list() / get(name)
ose.status.set(field, text | { text, kind, onClick, title, choices, value, onChoose }) / clear(field)
    `choices` [{ value, label }] makes the field a choice: the shell draws it as a button whose
    menu lists them, the current `value` checked, and a pick calls `onChoose(value)`. `title`
    names the field for the tooltip and a screen reader. The editing mode is one:
      ose.status.set('mode', { text: 'Live', title: 'Editing mode', value: 'live',
        choices: [{ value: 'rich', label: 'Rich' }, { value: 'live', label: 'Live' },
                  { value: 'source', label: 'Source' }], onChoose })
    A plain text file sets `{ text: 'Text' }` and no choices.
ose.status.all()             -> [{ key, text, kind, onClick, title?, choices?, value?, onChoose? }]
ose.status.watch(fn)         -> unsubscribe            every change, with the whole list
    The bar's own four first (mode, focus, doc, save), then every other field in the order it
    was first set.
```

### Settings, state and the per-machine store

Two kinds of state (W5). The vault's `.ose/state.json` travels with the vault: pins, the
planner's paths, the vault's settings. The per-machine store, outside the vault and never
synced, holds the interface: the session, recent files, the sidebar, per-folder sort, the side
panel, reading comfort, Show hidden, the restore switch.

```
ose.state(key)               -> { get(), set(value), flush() }   `.ose/state.json`, one key per
                                concern, written debounced; a dotted key is a path into the object
ose.local(key)               -> { get(), set(value), flush() }   per machine and per vault
ose.local.app(key)           -> { get(), set(value), flush() }   per machine, every vault
    Both loaded in `ose.ready` and written debounced (300 ms); a write sends only the keys this
    window changed, laid over what is on disk, so the host's own keys in the same file (the
    window bounds, the theme mirror) are never reverted. A scope that cannot be read (for any
    reason, an unknown command included) stays unloaded for the session: the defaults answer,
    the failure is logged, and nothing is written over it. `set(undefined)` removes a key.

    ose.local (vault):  session, recent, sidebar { open, width, expanded }, folders (per-folder
                        sort, { [path]: { key, dir } }), panel { open, id, width }, notices
    ose.local.app:      settings (the machine keys below)
    ose.state:          pins, planner, settings (the vault keys below)

    The first time a machine opens a vault after the upgrade, `recent`, `sidebar` and the
    reading settings are copied from the state file into the store (`migrated: 1`). Copied,
    never deleted from the synced file.

ose.settings.get()           -> the defaults, merged with both scopes
ose.settings.set(partial)    each key to its own scope; `undefined` resets a key. Bus `settings`
ose.settings.on(fn)          -> unsubscribe            every write, with the whole object
ose.settings.section({ id, title, order?, render(el) -> { unmount? } })  -> unsubscribe
                             a section of the Settings page (the planner's is `planner`, order 40)
ose.settings.sections()      -> the registered sections, sorted by `order` (100 by default)
ose.settings.apply()         put fontSize, lineHeight, pageFace, layout, zoom and readable width
                             on the document
ose.settings.zoom() / setZoom(pct)                          one of 90, 100, 110, 125, 150
ose.settings.onRepaint(fn)   -> unsubscribe   a settings page open while a chord changes a value
                             redraws itself through this; the kernel never reaches into it

    key                                         scope     default
    fontSize, lineHeight, pageFace, layout,     machine   16, 1.35, 'document', 'scroll',
      readableWidth, zoom, spellcheck                     true, 100, true
    showHidden                                  machine   false
    restoreSession                              machine   true
    hideMdExt                                   machine   false
    editorMode                                  machine   'rich'     ('live', 'source'): how a
                                                                     markdown file with no
                                                                     remembered mode opens (X1)
    trash                                       vault     'system'   ('vault' = `.trash`)
    attachments                                 vault     'beside'   (or a vault folder)
    titleSync                                   vault     false      (file name follows the H1)
    Any other key a module sets is the vault's.

    `pageFace` is `document` (the serif, the default) or `plain` (the interface face). It lands
    as `data-face` on <html> and tokens.css makes `--font-doc` resolve to `--font-ui` for
    `plain`. Only the family moves: sizes, leading, rhythm, frames, rules and the maths face do
    not.

ose.theme.get() / set('light' | 'dark' | 'system') / on(fn) / resolved()
    Unset is 'system' (M26): the app follows the platform until the user picks. The preference
    is in the web view's localStorage, which is per machine already.
```

### Search and links

```
ose.search(query, { limit, chan, hidden? })  -> { hits: [{ path, line, col, text, kind }], files,
                                                  total, capped, stale }
    `limit: 0` is no cap. `chan` names the caller, so a newer query on the same channel abandons
    the walk the older one started. `path:` and `file:` filters are words in the query itself.
    `hidden` follows Show hidden when it is not given.
ose.links.resolve(fromPath, href) -> { path, heading } | null
ose.links.href(fromPath, target)  -> string
ose.links.inbound(path)           -> [{ path, count, lines }]
ose.links.rewriteMoved(pairs)     -> { files, links, failed: [paths], rewritten }
ose.links.planRewrite(text, filePath, pairs)  -> Promise<[{ from, to, insert }]>
    Links are found with the markdown parser the editor uses (mdast, GFM, maths): an inline
    link, an image and a reference definition, and nothing inside code, an HTML comment or a
    maths span. Only the destination's bytes change. Only markdown files are rewritten
    (`ose.paths.isMarkdown`), and only one that reads as UTF-8 with nothing lossy: a page in
    another encoding keeps its links and is listed in `failed`, because the rewrite writes UTF-8
    and its kept version is the decoded text, not the bytes. `inbound` reads text files only.
    A file open in the editor, on screen or parked (H5), is never touched on disk: the page
    host's `rewriteLinksIn(path, pairs)` rewrites its buffer as one undoable edit and the
    editor's autosave writes it. Every other file is read with `readFile` and written with
    `save` against that hash, a forced version kept first; a file that changed in between is
    not written and is listed in `failed`. `planRewrite` is the pure half: the splices the disk
    rewrite would make in `text`, as UTF-16 offsets, ascending, so the editor can apply exactly
    the same edit to a Source buffer. It is async only because the parser loads on first use.
```

### Everything else

```
ose.pages()                  -> Promise<[paths]>   the markdown pages the page picker and the
                             editor's `[[` menu offer; the shell registers the list through
                             `ose.setPageList`, and with none registered the vault is walked
ose.focus.get() / set(path) / exit() / name() / isUnder(path) / defaultNewFolder() / on(fn)
    The focused folder: what narrows the tree and the page list. The sidebar UI that sets it is
    the shell's. `defaultNewFolder()` is where a new file goes when the caller names no folder:
    the focused folder, else the folder of what is on screen (a folder route's own path, a
    page's folder), else the vault root ''. Focus lasts for the session and is never restored
    (H18). Esc leaves it from anywhere that is not text being edited, and while it is on the
    status bar carries a `focus` field that names the folder and leaves focus when pressed.
ose.window.title(text) / close()
                             The window is Chrome's own (X9): there is no minimise, maximise,
                             drag, resize or quit hose. `close()` is this tab's close path
                             through the leave gate, then `window.close()`, which Chrome honours
                             for the installed app's window
ose.window.onClose(fn)       -> unsubscribe   `close()` awaits `fn()` before the window goes;
                             `false` keeps it. A handler that throws counts as done
ose.window.leave(reason)     -> Promise<boolean>   reason: 'close' | 'reload' | 'vault-change'
ose.window.onLeave(fn)       -> unsubscribe        fn({ reason }) -> boolean | Promise<boolean>
                             reason is also 'abandon' (below), where a string names what is lost
ose.window.stay()            a successful leave whose caller changed its mind
ose.openExternal(url)        an http, https or mailto link in a note; every other scheme refused
ose.assets.url(name)         -> the URL of a kernel asset (see "Where the app is served").
                             `ose.assets.origins()` is retired with the app and ose origins (X4)
ose.paths.isMarkdown(path) / isText(path) / markdownExts / textExts
                             what a file is by its name: the one list the editor, the tree, the
                             folder view, the palette and backlinks agree on. Markdown is md,
                             markdown, mdown and mkd; text is markdown plus txt, text, log, csv,
                             tsv, rst, adoc, org, tex and bib. A file not named may still read as
                             text (`stat(path, { sniff: true })`)
ose.log(text, level?)        into the host log, `<stamp> <level> ui: <text>`; level 'error' |
                             'warn' | 'info' (default) | 'debug'. Never rejects
ose.reload(opts?)            -> Promise<boolean>   "Reload window": the page again
                             (`location.reload()`, in the host as in a browser). Leaves the
                             window first and answers false when a page could not be saved;
                             `{ skipLeave: true }` for a caller that has already left. No chord
ose.bus.on(event, fn) / emit(event, payload)          app-wide events
ose.store.get(key) / set(key, v) / watch(key, fn)     shared reactive values (theme, focus, route)
ose.uid() / debounce(fn, ms) / esc(text)   small shared helpers
ose.toast(text, kind?, ms?, opts?)  -> kill
    kind 'info' | 'ok' | 'warn' | 'err'; ms 4500 by default. `ms: 0` is sticky: no timer, no
    click-to-dismiss, Esc does not take it, and it carries a close button. `opts.actions`:
    [{ label, run }], buttons reachable with Tab; running one closes the toast. An 'err' toast
    is `role="alert"`. A failure the user must act on is sticky.
```

### Leaving the window

Everything that throws the window's document away asks one gate first: `ose.window.close()`,
`ose.reload()`, Change vault. A close through Chrome's own button or a reload through its
toolbar cannot be held: the editor starts a draft of every dirty page on `beforeunload` and the
kernel banks its state on `pagehide`, so the text comes back as recovered changes. `ose.window.leave(reason)`
runs every `onLeave` handler and awaits all of them, with no time limit (after three seconds a
sticky "Still saving…" toast says why the window is still there). The editor's handler saves
every open page, parked ones included.

- One handler answers false, or rejects: the window stays. The bus says `window:stay` and
  `window:refused` { reason }, a sticky error toast says "Not closed (reloaded, switched): a page
  could not be saved." with [Show] (`page.show-problem`) and, for a close, [Close anyway]
  (`app.close-anyway`, "Close window without saving"). The answer is false. When the page host
  names the pages that could not let go (`problems()`), the toast names them instead of "a
  page", and says when one is not open in any tab (a page left parked when its tab was taken
  back by an overtaken navigation): [Show] then brings that page back into a tab of its own,
  buffer and all, before it shows the banner. `window:stay` thaws every page, parked ones
  included, so none is left frozen.
- All of them let go: the session and the per-machine store are written, then for a reload or a
  vault change the view on screen is unmounted and the state file flushed (a close does both in
  the router's own `closing` handler). The bus says `window:leaving` { reason } and the answer
  is true. The pages stay frozen: the caller goes, or calls `ose.window.stay()`, which says
  `window:stay` and puts an unmounted view back.

One leave runs at a time; a second call while one waits answers the same promise. The kernel
itself subscribes the adapter's close fan-out to `leave('close')`.

`app.close-anyway` destroys the window without the fan-out, and it is in the palette at any time,
not only after a refusal. Before it does, every `onLeave` handler hears `{ reason: 'abandon' }`:
the window goes whatever it answers, so a handler keeps what it holds somewhere that outlives the
window (the editor writes a draft of every dirty page) and answers true once it is kept. `false`,
a rejection, no answer within five seconds, or a string (or strings) naming the page means it is
not. When anything is not kept, a confirm names it and Cancel keeps the window (`window:stay`).
The drafts are outside the window and survive it.

### The page lifecycle

A view's or a folder's `unmount` is the one place it can stop what it started, so the kernel
promises three things about it:

1. **It is awaited, for up to five seconds.** The router waits for the promise `unmount` answers
   before it mounts the next page, the way it waits for the editor's `close()`. A throw is caught
   and logged and the next mount still proceeds. An `unmount` that has not settled after five
   seconds is left running, a toast names the page that would not close, and the next page is
   drawn.
2. **It runs when the tab is left.** Views and folders are never parked: bringing another tab
   forward unmounts them like a navigation does, and they mount again when their tab comes back.
3. **It runs when the window closes or reloads.** A reload and a change of vault go through the
   leave gate, which awaits the unmount and flushes the state file before the document goes. The
   window's `closing` notice does the same beside the gate's own `leave('close')`. `pagehide` is
   the last resort, where only what `unmount` finishes synchronously is certain to be written.
   The editor is not unmounted here: it answers the gate's `onLeave`, saving every page.

### Errors reach the log

Every `error` and `unhandledrejection` on the window goes to the host log at level error, with
the message, the source line and the stack (at most thirty a minute, then one line saying how
many were dropped). The kernel logs its own file operations, the leave gate's answers, a failed
state or store write and every `files.save` that did not end in `saved`.

### What the shell hands the kernel

Four hoses are the other way round: things the **shell hands the kernel**, once, so that the
kernel can stay ignorant of the editor, the folder view and the sidebar.

```
ose.init({ page, keys, theme, start })   the one call the shell makes once its surfaces exist:
                                     mounts the router into `page`, starts the key engine and
                                     the theme. Each part can be switched off. `start: false`
                                     mounts the router without drawing the empty surface, for a
                                     shell that opens on Home or a restored session.
ose.setPageHost(host)             -> unregister    whoever draws a file:
    { open(el, path, opts), canLeave(reason), stay(), close({ park }?), release(path),
      rewriteLinksIn(path, pairs), scrollToLine(line, col), selection(), headingLine(text, h),
      beforePathChange(change), afterPathChange(change), claims(path), problems() }
    The router never imports `ose:editor`; the shell joins them here. With no page host the
    router shows the file as text and navigation still works. Every method but `open` is
    optional, and a missing one means "yes" or "nothing to do".
      open(el, path, { line, col, query, selection })   reuses a parked instance of `path`
      canLeave('navigate') -> Promise<boolean>   false: the page stays, the router changes nothing
      stay()                                     undo the freeze a true canLeave left
      close({ park }?) -> Promise<boolean>       false: still mounted, the column is not cleared.
                                                 `park: true`: detach and keep alive; always true
      release(path) -> Promise<boolean>          a parked instance is saved and destroyed; false:
                                                 it could not be saved, its tab stays
      rewriteLinksIn(path, pairs) -> Promise<{ handled, changed, failed? }>   the file is open:
                                                 its links are rewritten in the buffer (H5)
      beforePathChange({ kind, from, to }) -> Promise<{ ok, reason? }>   before a rename, move,
                                                 trash or copy (`kind`); ok:false stops it
      afterPathChange({ kind, from, to, ok, rewritten? })   after the host call, whether it
                                                 worked or not; `rewritten` { path: hash }: moved
                                                 files whose own links fileops rewrote before
                                                 this call, the hash the disk now holds
      claims(path) -> boolean                    true: a missing path is drawn by the host itself
                                                 (a media file), not by the router's "Not found"
      problems() -> string[]                     the paths of the pages, on screen or parked, that
                                                 hold unsaved work they could not write: the leave
                                                 gate names them and can bring one back
ose.setFolderHost({ open(el, path, { select, scrollTop }) -> Promise<FolderHandle> })  -> unregister
    FolderHandle = { unmount(), refresh(), selection() -> string | null }
    whoever draws a folder route; a missing or unreadable folder draws its own box
ose.setPageList(fn)               -> unregister    fn() -> [paths], what `ose.pages()` answers
```

## `ose:editor`

```js
import { markdownPage, releasePage, parkedPaths, rewriteLinksIn, codeEditor, render,
         renderMath } from 'ose:editor'

markdownPage(el, path, opts)  -> { close(), park(), save(o), canLeave(reason), stay(), path, dirty,
                                   mode, state, focus(), find(query), on(event, fn) }
    the editor for any text file the page host hands over (H17): `.md`, `.markdown`, `.mdown`
    and `.mkd` get the Rich | Live | Source switch (below); every other text file,
    extensionless ones included, opens as plain Source with its line endings and BOM kept. Title strip, properties, autosave, the 3-way merge of changes made on disk, versions,
    find and replace, drop, links, backlinks, every command.
    opts: { line, col, heading, selection, readOnly }
    **One live instance per file** (M12, M24): when a parked instance of `path` exists,
    `markdownPage` puts its root back into `el` and answers the same handle, with the same
    buffer, undo history, mode, scroll and selection. `park()` (the page host's
    `close({ park: true })`) detaches the root and keeps the instance alive, flushing a save in
    the background; only the instance on screen publishes the status bar and the title. At most
    eight are parked, and past that the least recently used clean one is released; a dirty or
    unsaved one is never evicted. Autosave, drafts, the watcher, the leave gate and
    `beforePathChange` / `afterPathChange` / `saveAll` cover parked instances too.
    save(o?: {explicit, closing}) -> Promise<boolean>: true only when the disk holds the buffer
    (written, or nothing to write); every other outcome, a failed write, a conflict not
    resolved, a guard verdict of unsafe, a deleted or read-only page with a dirty buffer, is
    false. canLeave(reason) -> Promise<boolean> freezes the page and saves it if dirty; false
    leaves it editable, shows the banner and writes the draft. stay() undoes the freeze of a
    true canLeave. close() -> Promise<boolean> runs canLeave first; false keeps the page and
    tears nothing down. mode is 'rich' | 'live' | 'source'. state is the DocState below.
    on() takes 'state', 'mode', 'recovered', 'guard', 'saved', 'dirty', 'conflict', 'title'
    and 'closed'.
releasePage(path) -> Promise<boolean>
    a parked instance of `path` is saved and destroyed (the page host's `release`); false: it
    could not be saved, and the background tab that holds it is not closed.
parkedPaths() -> string[]
rewriteLinksIn(path, pairs) -> Promise<{ handled, changed, failed? }>
    `path` is open (on screen or parked): its links into `pairs` are rewritten in the buffer as
    one undoable edit, leaving the page dirty and every other byte as it was. Source mode
    applies `ose.links.planRewrite`; Rich mode sets the href of every link mark and image whose
    target resolves to a `from`. `{ handled: false }` for a file that is not open, which the
    kernel then rewrites on disk (H5).
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
    'doc:mode' { path, mode: 'rich' | 'live' | 'source', forced: null | 'plain' | 'unsafe' |
    'lossy-open' };
    'doc:recovered' { path, at, applied } when a draft was found at open.
    Commands: page.save and page.close answer their promise (page.close is `ose.route.close()`:
    it closes the tab); page.save-as, page.discard-changes, page.show-problem,
    page.recovered-compare, page.recovered-restore, page.mode-rich, page.mode-live,
    page.mode-source, page.mode-next, page.reading-toggle (see "Modes" below; page.view-rich
    and page.view-source are gone), page.merge-resolve ("Resolve changes made on disk") and
    page.merge-undo ("Undo merge"); page.source-toggle is 'Switch between source (raw
    markdown) and the editing view'. The shell's
    file.* rename, trash and duplicate.
    The page names its file in the chrome; it still publishes its H1 on `store 'pageTitle'`, but
    nothing in the chrome reads it (M13), and the file name follows the H1 only with the vault
    setting `titleSync`. A new page (`page.new`) is created in `ose.focus.defaultNewFolder()`.
    A link to a folder navigates to its folder route; a link to any other existing file to its
    page route, and the page host decides how it opens (H15, H17).
Changes made on disk (H7): the file is read again. A clean page reloads in place as one
    transaction (undo survives). A dirty page whose buffer is exact is merged three ways against
    the text it was based on (`merge.js`, node-diff3): a clean merge goes into the buffer as one
    step, the page stays dirty, and a banner says "Merged changes made on disk by another
    program." with [Show changes] and [Undo merge]. Overlapping changes leave the buffer alone:
    the status is `conflict`, autosave pauses, leaving is refused, and a banner offers
    [Resolve…] (a side-by-side merge view: Keep both, Keep mine, Take theirs, Cancel), [Keep
    mine] and [Take theirs]. There is no blind "Changed on disk" dialog any more.
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
    A path editor keeps a draft of what it could not write (`mode: 'source'`, `exact: true`),
    offers it back when the file is opened again, answers the leave gate like a page, and drops
    the draft after a clean save.
renderMath(tex, { display })  -> HTMLElement
    one formula, rendered with Temml to MathML: a `<span class="ose-math">` or, with
    `display: true`, a `<div class="ose-math ose-math-display">`. The browser lays MathML out in
    the platform's maths face (`Cambria Math` on Windows), which is the face Word's equation
    editor uses, so a formula and the page's serif text are one document. It never throws and
    never loses the text: TeX Temml refuses comes back as its own source in the error colour,
    with Temml's message on the element's `title`. A view that draws a statement of its own
    calls this; `render()` and the page editor already do.
render(markdown, { basePath, onLink, codeLanguage })  -> HTMLElement
    read-only, links resolved, images through the `vault/` origin, and fenced code coloured with
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

The stylesheet is `ose/editor.css`. Tokens come from `ui.css`.

### Modes: Rich, Live, Source, and Reading

A markdown page has three editing modes (X1), in the meta line's segmented switch and in the
status bar's `mode` field (a menu, `ose.status.set` with `choices`):

- **Rich** is the block editor (Crepe), with the fidelity layer below ("Writing"). It stays the
  default.
- **Live** is CodeMirror over the whole file, frontmatter and H1 included, with the markup drawn
  off the caret line (docs/LIVE.md): headings sized, emphasis and links styled, bullets and task
  checkboxes as widgets, quotes and callouts boxed, images through the vault origin, tables
  rendered off the cursor and raw on it, maths with Temml, fenced code highlighted, the
  frontmatter folded into a "Properties" block. In Live the file text is the only truth: a save
  writes `view.state.doc.toString()` with the byte-order mark and the line separators put back
  (`src/editor/source.js`), never a serializer, so a widget bug is a display glitch and never a
  changed byte. A checkbox click is one transaction that changes one character. The title strip
  and the properties strip are hidden: the text holds both. A Live view that fails to mount
  falls back to Source.
- **Source** is the same CodeMirror with nothing drawn.

A plain text file has one mode, Source; a page the rich view cannot hold (`forced`) is Source
too. Which mode a markdown file opens in: the mode it was last left in, per machine and per
vault (`ose.local('pageModes')`, at most 300, `src/editor/modes.js`), else the machine setting
`editorMode` (Settings › Editor, "Open markdown files in"), else Rich. A forced mode and a file
outside the vault are never remembered. The wave-2 `sourcePages` list in the state file is read
once to migrate and never written again.

Commands (no new chords): `page.mode-rich` "Edit as rich text", `page.mode-live` "Edit in Live
preview", `page.mode-source` "Edit as source", `page.mode-next` "Next editing mode" (the status
field's click), `page.source-toggle` (Ctrl+E, unchanged: Source and back to the page's last
other mode), `page.reading-toggle` "Reading view", `page.save-utf8` "Save as UTF-8" and
`page.reopen-encoding` "Reopen with encoding…". In Live the format, block and follow-link
commands go to the Live view; one it does not implement toasts "Not available in Live".

Every mode keeps the same guarantees: drafts, the leave gate and its freeze, the conditional
save, the three-way merge of changes made on disk, link rewrites as an undoable edit, parking
with the buffer and undo history alive (one live instance per file), find, go to line, word
count and the caret remembered per route. Switching modes passes the text through: Rich to Live
works like Rich to Source, and Live to Rich runs the same open check that may refuse and stay.

**Reading** is a view, not a fourth mode (X3): `page.reading-toggle`, or "Read" in the meta line,
shows the buffer rendered read-only (marked with `breaks: true`, then DOMPurify: no script, no
event handler, no iframe) in place of the editor, which stays mounted underneath. Links follow,
images go through the vault origin, task boxes are disabled, the top line is kept both ways,
and it re-renders when a change from disk is applied. Toggling back returns to the mode it came
from, with a dirty buffer untouched.

**Encodings** (X10). The page keeps the `encoding` `readFile` answered and saves with it. A file
whose decoding would not write the same bytes back (`lossy`) opens read-only with a banner that
names the encoding; a character the encoding cannot hold refuses the save with the not-saved
banner and a "Save as UTF-8" action. The meta line shows the encoding when it is not UTF-8.

**Outside the vault** (X7). A page on an `abs:` path says "Outside the vault" and the full path
in its meta line, and keeps drafts and the merge; it has no versions (their commands toast), no
backlinks, no link rewriting, no title sync, and no attachments (a drop or a paste toasts
"Attachments need a file inside the vault").

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
and `renderMath` for any other caller.

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
this list. Whoever links `ui.css` and calls `toast()` gets a styled toast without shipping a line
of CSS. A stylesheet of its own (the planner's) overrides tokens and never writes a hex value.

An overlay takes the keyboard the moment it is opened: `openOverlay` focuses its box before it
answers, so a key typed right after the chord that opened it never reaches the page behind.
`focusField(box, el, then?)` puts the focus on the overlay's own field in the same task (and
once more after a task, only if it did not take); every dialog here uses it, and a surface that
builds its own input on `openOverlay` should too.

`ose:ui` is a **facade over `ose:kernel`**: the file served at `ose/ui.js` is a list of
names and no code. It has to be, because the kernel's own router, key engine and file operations
raise these same dialogs and these same toasts, and a second copy of them in the window would be a
second overlay stack, with Esc closing the one that is not on top. The import map line, the served
file and everything in this section are exactly as they read; only the inside differs.

## The host underneath

docs/HOST.md: one typed command per operation (X5), the `vault/` origin, the one hide rule, the
watcher, file versions, drafts, the trash, the per-machine store, tabs per vault, OS opens, files
outside the vault, encodings. Nothing here starts a program, and the app makes no network call
but loading its own files.

**The bridge** (`src/kernel/bridge/`). `bridge/index.js` is the facade every module calls; its
method names are the command names and never change with the transport. Underneath it an adapter
answers `invoke(name, args)`:

- `src/web/adapter.js`, the one adapter, answers every command in the browser over the folder
  the person picked (docs/HOST.md). `bridge.kind` is `'web'`. The command types are kept by hand
  in `bridge/commands.ts`; a name the adapter does not have is `unknown_command`, a hard error,
  never a null.

Each facade method names its answer from `commands.ts` (`RootInfo`, `Stat`, `Entry`, `Kept`, …);
the untyped `call` answers `unknown`, so a field the host does not send is a type error. The
facade adds the epoch to every mutating command's options struct (`setState` and `versionKeep`
included), drops trailing absent
arguments (an option left out is absent, not null), and turns every refusal into a `HostError`
(`bridge/errors.js`). There is no `rpc` dispatcher, no `reloadShell`, and no window drag, resize,
minimise or maximise.

**OS opens** (`src/kernel/opens.js`, §5.3). Once Ose is installed, the OS can hand it files (a
double click, Open with: the manifest's `file_handlers`), and Chrome passes them on through its
launch queue. The adapter turns each into an OpenRequest `{ path, outside, kind, line? }`, `path`
a vault path when the file is inside the open vault, else `abs:`. A booting tab takes its queue
with `takeOpens` once its first surface is up (after session restore), and a running tab gets
the `open` event: each request opens in a tab of its own (a tab already on it is reused), a
folder as a folder route, and the last one comes forward.

## Rules

- A hose is added, never changed in meaning; a change of meaning is written here first.
- The kernel never draws and ships no HTML at all.
- Nothing in the kernel knows a view or a file name of the shell. It serves and it answers.
- Nothing in the JavaScript decides what is hidden or what is text: the host answers both.
