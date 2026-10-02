# The Ose core

The core is `src/core/`: the logic of the app with none of its look. It owns the vault's files
as the page sees them, the file operations and their undo, the routes and the tabs, the leave
gate, the settings and the stores, the command, view and status registries, the keys, and the
bridge to the Rust host. Everything else (the shell in `src/shell`, the editor in `src/editor`,
the views in `src/views`) goes through one object, `ose`:

```ts
import { ose } from '../core/core.ts';
```

Imports are plain relative paths and there is one Vite build (`vite.config.js`); the editor and
the views are lazy chunks of it. The views never import the core: `initViews(ose)` hands them
the object.

## Rules

- The core draws as little as it can. It has no surface of its own: the shell draws the layout,
  the tree, the tabs, Home and Settings. What the core does put on screen is generic and comes
  from the kit (toasts, the loading line, the vault pickers) or is the router's own fallback box
  ("Not found", "No such view", a file shown as plain text when no page host is registered).
- Nothing in the core knows a view, the editor or a file of the shell. The editor reaches the
  router through the page host the shell registers (`pagehost.ts`); views reach it through
  `ose.views.register`.
- Nothing in the JavaScript decides what is hidden or what is text: the host answers both.
- Every call that touches the host is async. A host refusal is a `HostError` with `.code` and
  `.cmd`.
- Nothing of the app is written into the vault. State, the per-machine store, drafts and file
  versions are in the app's data folder on this machine, keyed by the vault. The only exception
  is the vault trash, `.trash`, used when the user chooses it or the volume has no system bin.
- A member of `ose` is added, never changed in meaning.

## The files

| File | What it holds |
|---|---|
| `core.ts` | the `ose` object, the boot (`ose.ready`), `app.close-anyway` |
| `registry.ts` | the bus, the store, the command, view and status registries, `uid`, `debounce` |
| `router.ts`, `tabs.ts` | routes, the mount cycle of the page column, the tabs and their histories |
| `pagehost.ts` | the two seams the shell fills: the page host and the page list |
| `fileops.ts`, `journal.ts` | create, rename, move, copy, trash, restore, duplicate, import; the undo journal |
| `leave.ts` | the leave gate |
| `links.ts`, `href.ts`, `mdparse.ts` | resolving links, finding inbound links, rewriting them when a file moves |
| `names.ts`, `paths.ts` | what a name may be, the free name, vault and `abs:` path helpers |
| `settings-core.ts`, `state.ts`, `local.ts` | settings, the vault's state, the per-machine store |
| `keys.ts`, `focus.ts`, `theme.ts` | the keymap and key engine, focus on a folder, the theme |
| `watch.ts`, `opens.ts`, `update.ts`, `log.ts` | the watcher, what the OS asks to open, the updater, the log |
| `pickers.ts`, `page-items.ts` | the vault pickers (Move to…, Choose a file…, Link a page…) and their rows |
| `bridge/` | the facade over the host commands, the Tauri adapter, the generated bindings |
| `types.ts`, `globals.d.ts` | shared types |

`core.ts` also exports `pickPage`, `pickFolder`, `pickFile`, `pageTitle` and `pageItems` for the
shell and the editor; `ose.pickers` carries the same pickers for code that is handed `ose`.

## Boot

`ose.ready` resolves once the bridge is up and the host has answered: the platform, the vault's
state, the per-machine store (with a one-time copy of keys older builds kept in the state file),
the vault root and its epoch. Nothing in it throws the boot: a part that fails is logged and the
defaults answer. It then starts taking the files the OS asks this window to open.

The shell calls `ose.init({ page, keys, theme, start })` once its surfaces exist: it starts the
theme and the key engine and mounts the router into the page column. The shell passes
`start: false` and navigates Home itself, so the column is not drawn twice. Before that it calls
`ose.setPageHost` and `ose.route.setHome`.

## The `ose` object

**Identity.** `version` (`{ core, sha, short, date }`, stamped by Vite), `platform` (`'windows'`,
`'macos'` or `'linux'`), `host` (always `'tauri'`), `ready`.

**`ose.vault`.** `root` and `name` of the open vault (null in a window with no vault), `epoch`
(see the bridge), `info()` (with the log's path), `pick({ adopt? })` (the native folder picker;
`adopt: false` only chooses), `open(path)` (adopt in this window, or `{ focused, label }` when
another window has it), `recent()`, `forget(path)`, and `onChangeRequested(fn)`, a second launch
naming another folder: the shell leaves the window, then adopts it. `onChange` is kept for old
callers and never fires. `ose.windows.open(vaultPath?)` opens or brings forward the window for a
vault; there are never two windows on one vault.

**`ose.files`**, one host command each:

- Plain reads and writes: `read`, `write`, `append`, `readBinary`, `writeBinary` (bytes or
  base64), `list(path, { hidden? })`, `tree({ hidden? })`, `stat(path, { sniff? })`, `exists`,
  `mkdir`, `rename`, `copyPath`. `list`, `tree` and `ose.search` follow the Show hidden setting
  unless the caller says otherwise.
- The save path: `readFile(path, { encoding? })` answers `{ text, hash, mtime, size, encoding,
  bom, lossy }`; `save(path, text, { expectedHash, version?, encoding? })` compares and writes
  in one host call under a lock and answers `{ status: 'saved', hash, mtime }` or
  `{ status: 'conflict', disk }`, writing nothing on a conflict. `expectedHash: null` means "must
  not exist yet"; leaving it out is an error. The hash is the host's (FNV-1a 64); JavaScript only
  carries and compares it. A file in another encoding is written back in it; `lossy` text is
  never saved.
- Create-only writes: `createNew`, `createNewBinary`, `copy` (`[exists]` rather than overwrite).
- One-line writes for the views: `appendLine(path, line)` and `replaceLine(path, index,
  expected, next)`, which replaces only if the line still reads `expected`.
- `drafts.write / list / read / drop`: the text a page could not write, kept on this machine.
- `versions.keep / list / read / restore`: copies of a file kept before a save replaces it.
- `trash(path)`, `trashWhere(path)`, `trashList()`: where the user's setting sends it (the system
  bin, or the vault's `.trash`). The app itself uses `ose.fileops.trash`.
- The OS: `open(path)` (the default app; an executable is revealed, never run), `reveal(path)`,
  `fileManager()` ('Explorer', 'Finder' or 'the file manager'), `assetUrl(path)` (a `vault://`
  URL for an `<img>`).
- Files outside the vault: their path is `abs:` plus the absolute path with forward slashes
  (`abs:D:/Notes/todo.md`). `pick()` is the native open-file dialog, `openOutside(path, { line?,
  activate? })` registers the file with the host and opens it in a tab (a file inside the vault
  opens as the vault file; a folder outside opens as a vault in its own window), `isOutside`,
  and `importOutside(from, to)` copies one into the vault. The host refuses an `abs:` path this
  window did not register. Outside files have no versions, links or attachments, and cannot be
  renamed, moved or trashed.

**`ose.fileops`** and **`ose.names`**: see "File operations" below. **`ose.paths`**:
`isMarkdown`, `isText`, `markdownExts`, `textExts`, the one list of what a file is by its name.

**`ose.watch(fn)` / `ose.watch(folders, fn)`** → unsubscribe. `fn({ changes: [{ kind, path,
to?, dir?, hidden? }], lost?, rescan? })`, with `kind` one of create, modify, delete, rename.
`rescan` means the host may have missed events and the caller should read again; `lost` means
the vault folder itself went. Changes to an outside file go only to a caller that names its
`abs:` path; the editor hears every change on the bus `fs`.

**`ose.route`** and **`ose.tabs`**: see "Routes and tabs" below.

**`ose.commands`**: `register({ id, title, group, hint?, shortcut?, when?, applies?, run })` →
unsubscribe, `run(id, ...args)`, `get`, `list`. `run` answers what the command answers, so a
save can be awaited. A `shortcut` arms its chord for as long as the command is registered. With
a target argument and an `applies(target)`, `applies` decides instead of `when()`, so a context
menu acts on the row it was opened on.

**`ose.keys`**: `bind(combo, commandId, { scope })`, `shortcutFor(id)`, `defaults()`,
`label(combo)`. `mod` is Cmd on macOS and Ctrl elsewhere. The core keymap and the editor body's
chords are in `keys.ts`; the shell's own are `src/shell/keys.json`, bound through `bind`. Window
chords are bound in the capture phase; a body chord wins while the caret is in a page.

**`ose.views`**: `register(name, { title, mount(el, route), unmount?, refresh?, ...extra })` →
unsubscribe, `get`, `list`. Extra fields (`section`, `order`, `icon`) are kept for whoever draws
a list. The first registration of a name wins. A handle `mount` answers is merged over the
registration.

**`ose.status`**: `set(field, text | { text, kind, onClick, title, choices, value, onChoose })`,
`clear`, `all`, `watch`. The bar's own fields come first (mode, focus, doc, save), then any other
field in the order it was first set.

**`ose.settings`**, **`ose.state`**, **`ose.local`**: see "Settings and stores" below.
**`ose.theme`**: `get`, `set('light' | 'dark' | 'system')`, `resolved`, `on`; the preference is
in the web view's localStorage, and the resolved theme goes to `<html data-theme>` and to the
host for the native frame.

**`ose.search(query, { limit, chan, hidden? })`**: a vault search in the host. `chan` names the
caller, so a newer query on the same channel abandons the older one.

**`ose.links`**: `resolve(fromPath, href)`, `href(fromPath, target)`, `inbound(path)`,
`rewriteMoved(pairs)`, `planRewrite(text, filePath, pairs)`. Links are found with the same
markdown parser the editor uses, so nothing inside code or maths is touched, and only the bytes
of a matching destination change. A file open in the editor is rewritten in its buffer through
the page host, as one undoable edit; any other markdown file is read and saved against its hash,
a version kept first. A file in another encoding, or one that changed in between, is listed in
`failed` and left alone.

**`ose.pages()`**: the markdown pages the page picker and the editor's `[[` menu offer, from the
list the shell registered with `ose.setPageList` (the sidebar narrows it to the focused folder),
else a walk of the vault.

**`ose.focus`**: `get`, `set(path)`, `exit`, `name`, `isUnder(path)`, `defaultNewFolder()`, `on`.
The folder the app is narrowed to, for this session only. `defaultNewFolder()` is where a new
page goes: the focused folder, else the folder of the page on screen, else the root.

**`ose.window`**: `title(text)`, `close()` (through the leave gate), `minimize`,
`toggleMaximize`, `isMaximized`, `onResized`, `onClose(fn)`, `leave(reason)`, `stay()`,
`onLeave(fn)`, and the updater: `appVersion()`, `checkForUpdate()`, `updateReady()`. An update
is downloaded in the background and installed only on the user's word, after the leave gate.

**The rest.** `ose.openExternal(url)` (http, https and mailto only), `ose.log(text, level?)` (a
line in the host's log; every uncaught error goes there too), `ose.reload({ skipLeave? })`
(leave, then reload the document), `ose.assets.url(name)`, `ose.bus` (`on`, `emit`),
`ose.store` (`get`, `set`, `watch`: shared values such as `root`, `route`, `theme`, `focus`),
and the helpers `uid`, `debounce`, `esc`, `toast`.

## Routes and tabs

There are two route shapes:

```
{ type: 'page', path, line?, col?, heading?, query?, selection? }
{ type: 'view', name, arg? }
```

A page route opens any file, a vault path or an `abs:` one; the page host decides how (the
editor, a media page, a box for a binary file). A view route mounts a registered view, Home
included (`{ type: 'view', name: 'home' }`, registered by the shell). `line`, `col`, `heading`,
`query`, `selection` and `arg` say where this one showing lands; they are not part of the
route's identity (`routeKey` is `page:<path>` or `view:<name>`) and are dropped once shown, so
back and forward restore the caret and scroll the page was left with.

A folder is not a route. `{ type: 'folder', path }` handed to `navigate` or `tabs.open` is a
request to reveal that folder in the sidebar (bus `tree:reveal`); it never enters a history and
nothing is mounted. A page route whose path turns out to be a folder reveals it the same way.

`ose.route`: `current()`, `navigate(route, { replace?, force?, focus?, tab? })`, `back()`,
`forward()`, `canBack()`, `canForward()`, `close()` (the active tab), `reopenClosed()`,
`setHome(route)`, `repoint(moves)`, `recent()`, `on(fn)`, `init(el, opts)`. `tab` is
`'current'`, `'new'` or a tab id. A missing page gets a "Not found" box with "Create it", an
exclusive create. The window title is the file name (or view title) and the vault's name.
`recent()` is the pages opened on this machine in this vault, newest first, kept in
`ose.local('recent')`.

`ose.tabs`: `list()`, `active()`, `open(route, { activate?, index?, reuse? })`, `activate(id)`,
`close(id)`, `closeOthers(id)`, `move(id, index)`, `reopenClosed()`, `on(fn)`. A tab is
`{ id, route, canBack, canForward }`, and the bus says `tabs` `{ tabs, active, reason }` on
every change. The core owns the model (`tabs.ts`); `src/shell/tabs.ts` only draws the strip.
Each tab has its own history of up to a hundred entries, and the last twenty closed tabs can be
reopened whole. Closing the last tab puts a fresh one on Home. When a file is trashed, every tab
showing it goes Home. Nothing of the tabs is kept across restarts.

**How a page is left.** Every navigation, back, forward or close that takes a page off the
screen asks the page host's `canLeave` first. A page that cannot be saved answers false, and
then nothing moves: the history is rolled back, no `route` or `tabs` event goes out, and the bus
says `route:refused`. A page left because another tab came forward, or because another tab shows
the same file, is parked instead (`close({ park: true })`): the editor keeps the instance alive,
buffer and undo included, and puts it back when its tab returns. Closing a background tab
releases its page (saved and destroyed); a page that cannot be saved keeps its tab. A newer
navigation overtakes an older one still waiting: the older answers false and its change to the
history is taken back. Views are never parked; their `unmount` is awaited, for at most five
seconds.

**The page host** (`pagehost.ts`) is the contract between the router and whoever draws a file.
The shell registers it in `src/shell/page.ts` with `ose.setPageHost({ open, canLeave, stay,
close, release, rewriteLinksIn, scrollToLine, selection, headingLine, beforePathChange,
afterPathChange, claims, problems })`. Only `open(el, path, opts)` is required; a missing method
means "yes" or "nothing to do". The full contract is the comment at the top of `pagehost.ts`.

## File operations and the undo journal

`ose.fileops` is the one implementation of `create(folder, name, { text?, unique? })`,
`mkdir(folder, name)`, `rename(path, name)`, `move(paths, folder)`, `copy(paths, folder)`,
`paste({ mode, paths }, folder)`, `trash(paths)`, `restore(ids)`, `trashList()`,
`duplicate(path)` and `importEntries(entries, folder, { onProgress? })` (files and folders
dropped from the OS, copied byte for byte, at most 64 MB a file). The tree, the palette, the
router's "Create it" and the editor all call these; the prompts for a name are the shell's.

A name is literal: nothing appends `.md` or strips an extension. `ose.names.check` refuses only
what Windows or macOS cannot hold, `free` finds the next free name (`x 2.md`, `folder 2`),
`split`, `extChanged` and `display` (the name the chrome shows; `.md` is hidden only with the
`hideMdExt` setting). Names are compared in Unicode form C. `create` makes missing folders and
gives a new `.md` a `# <stem>` heading.

An operation that moves or removes a path asks the page host first (`beforePathChange`), which
saves every open page at or under it; a page that cannot be saved stops the operation before
anything is touched (`code: 'not_saved'`). After the host call the router's histories are
re-pointed, the moved files' own relative links are rewritten, the page follows its file
(`afterPathChange`), the bus says `paths:created`, `paths:moved`, `paths:copied`,
`paths:trashed` or `paths:restored`, and the links into the moved files are rewritten. Nothing
navigates. Errors are `Error`s with `.code`: `bad_name`, `exists`, `not_saved`, `outside`, or
the host's.

**The journal** (`journal.ts`). Every operation that changed something is recorded as the steps
that undo it, and its result carries the `entry`, so a toast can offer Undo. It is session
memory only, newest first, at most fifty entries. `ose.fileops.journal.list()`, `canUndo()`,
`undo(id?)` and `on(fn)` (also bus `fileops:journal`). An undo walks the steps back through the
same operations, so pages follow and links are rewritten back. A created, copied or restored
file is trashed only if it is still what the operation left (same hash, or for a folder the same
entries); anything else is left in place and reported. An entry whose undo was refused stays,
and Ctrl+Z stops at it instead of walking past it. An undo is not journaled, and there is no
redo.

## Leaving the window, and why text is not lost

Everything that throws the document away (closing the window, `ose.reload()`, changing vault,
installing an update) goes through one gate, `ose.window.leave(reason)` in `leave.ts`. It runs
every `onLeave` handler and waits for all of them with no time limit; after three seconds a
sticky "Still saving…" toast says why. The editor's handler saves every open page, parked ones
included. One `false` keeps the window: a sticky toast names the pages that could not be saved,
with Show and, for a close, "Close anyway". When all let go, the per-machine store is written,
the view on screen is unmounted, the state is flushed, and the pages stay frozen until the
caller goes or calls `stay()`. The window's own close button goes through the same gate: the
Tauri adapter holds the close until every `closing` handler has settled, and a `false` keeps
the window. `app.close-anyway` ("Close window without saving") first asks every handler to keep
what it holds as a draft and confirms by name anything that could not be kept.

Underneath the gate, a save never overwrites what it did not read: `files.save` carries the hash
the page was based on, and a change on disk is a conflict the editor merges or asks about. Text
that could not be written is kept as a draft in the app's data folder until a save lands, and
offered back the next time the page opens.

## Settings and stores

All of it lives in the app's data folder on this machine; nothing goes into the vault.

- **`ose.state(key)`** → `{ get, set, flush }`: the vault's state, one object per vault
  (`<data>/vaults/<vaultKey>/state.json`), loaded at boot and written debounced (300 ms). A
  dotted key is a path into the object. It holds the vault's settings, the planner's paths
  (`planner`) and the editor's per-vault slot (`editor`). A state file that cannot be read is
  never written over that session. A vault that still has an older Ose's `.ose/state.json` is
  read from there until the first write puts its state in the data folder.
- **`ose.local(key)`** and **`ose.local.app(key)`** → `{ get, set, flush }`: the per-machine
  store, one object per vault and one for every vault. The vault one holds `recent`, `sidebar`,
  `panel` and `pageModes`; the app one holds the machine settings. A write sends only the keys
  this window changed, laid over what is on disk, so the host's own keys (window bounds, the
  theme mirror) are never reverted.
- **`ose.settings`**: `get()` (the defaults merged with both scopes), `set(partial)` (each key
  to its own scope; bus `settings`), `on`, `apply()` (font size, leading, face, layout, zoom and
  width onto the document), `zoom`, `setZoom`, `onRepaint`, and `section({ id, title, order?,
  render })` / `sections()` for a page of Settings (the planner registers one). The machine keys
  are `fontSize`, `lineHeight`, `pageFace`, `layout`, `readableWidth`, `zoom`, `spellcheck`,
  `showHidden`, `hideMdExt` and `editorMode`; every other key (`trash`, `attachments`,
  `titleSync`, anything a view adds) is the vault's. `settings-core.ts` has the defaults.

## The bridge

`src/core/bridge/index.ts` is the facade every module calls: one method per host command, each
typed from `bridge/commands.ts`. A call goes through the Tauri adapter (`bridge/tauri.ts`),
which looks the command up in `bridge/bindings.ts` and calls it; the bindings call Tauri's
`invoke` with the Rust name (`readFile` is `read_file` in `src-tauri/src/commands.rs`). The
host answers `{ status: 'ok', data }` or `{ status: 'error', error: { code, message } }`, and
every refusal becomes a `HostError`. A name the host does not have is `unknown_command`, never a
silent null.

The facade adds the vault's **epoch** to every call that changes the vault. The host counts the
vaults a window adopts and refuses a write carrying an older count (`stale_vault`), so a save
started against one vault can never land in the next. It also drops trailing absent arguments.

Events come the other way: the adapter listens on its own window for `fs` (the watcher), `open`
(files the OS asks to open), `vault` (a second launch) and the window's focus and close, and the
facade fans them out (`bridge.on`, and the bus for `fs`).

`bindings.ts` is generated from the Rust commands by tauri-specta and never edited by hand. To
add or change a command: change it in `commands.rs` (and its registration in
`src-tauri/src/bindings.rs`), run `OSE_WRITE_BINDINGS=1 cargo test bindings` in `src-tauri` to
write the bindings again, then update `bridge/commands.ts` and the facade method to match. The
`bindings_are_current` test fails in CI when the file is stale. The host itself is docs/HOST.md.

## The kit

`src/ui/` is the kit the core and everything else draws with: overlays and dialogs (`prompt`,
`confirm`, `choose`), the context menu, toasts, the clipboard, icons, the loading line, the
fuzzy matcher, `esc`, and the stylesheets (`tokens.css`, `base.css`, joined in `ui.css`). It
imports nothing from the core. There is one overlay stack in the window: Esc closes the newest,
and focus returns where it was.
