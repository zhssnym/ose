# Ose Web

Ose Web is the same app in Chrome: the shell, the kernel, the editor and the planner, unchanged,
over a real folder on this machine through the File System Access API, installable as a PWA and
working offline once installed. There is no server. A vault is a `FileSystemDirectoryHandle` the
person picked with `showDirectoryPicker({ mode: 'readwrite' })`; the handle is kept in IndexedDB so
Chrome's "Allow on every visit" brings it back without asking. Changes made on disk by another
program arrive through `FileSystemObserver`, with a polling fallback. After the install the app
makes no network call at all.

Nothing about a vault changes: the files are the database, `.ose/state.json` and `.ose/history`
are where the desktop keeps them, and a vault edited in Ose Web opens in `ose.exe` as it was left,
and the other way round.

## The seam

`src/kernel/bridge/index.js` picks one adapter (`Adapter` in `src/kernel/types.js`):
`{ invoke(name, args), subscribe(fn), platform?, assetUrl?, win?, close? }`. `tauri.js` talks to the
Rust host, `http.js` to the Node dev bridge, and Ose Web adds the third, `src/web/adapter.js`,
answering every command in the browser. The reference semantics are `dev/files.mjs` and
`dev/bridge-plugin.mjs` (the Node twins of the host) and `docs/HOST.md`; the exact shapes are in
`src/kernel/bridge/bindings.ts`. Every refusal is a `HostError` with one of the host's codes
(`src/kernel/bridge/errors.js`), and a name nobody answers is `unknown_command`.

The adapter is chosen by a build flag: `vite.web.config.js` defines `__OSE_WEB__: true`,
`vite.kernel.config.js` defines it `false` (so the desktop bundle drops the branch), and the
facade reads it as `typeof __OSE_WEB__ !== 'undefined' && __OSE_WEB__`. `bridge.kind` is `'web'`;
the kernel treats `'web'` as it treats `'http'` wherever it asks "is this a browser tab"
(`kernel.js`: `host: 'browser'`, and `app.close-anyway` off).

## Files

```
src/web/
  rules.js         pure, shared: hash, the hide rule, paths and names, sort, encodings, sniff,
                   fromDom (DOMException -> HostError)            (foundation, done)
  idb.js           the one IndexedDB database `ose-web`, with a memory backend for tests
                                                                   (foundation, done)
  web.d.ts         what TypeScript's DOM lib lacks: pickers, permissions, move, the observer,
                   launchQueue, __OSE_WEB__                        (foundation, done)
  fs.js            module fs: every vault-file command, versions, state, the outside files' reads
  watch.js         module watch: FileSystemObserver or polling -> the `fs` event
  local.js         module local: drafts, the local store, the log
  vault-handle.js  module app: the vaults and outside files kept in IndexedDB, permission,
                   the tab's vault, its epoch, the one-tab-per-vault lock
  adapter.js       module app: create() -> the Adapter; dispatch; the app commands; events
  sw.js            module app: the service worker: offline cache and the `vault/` media origin
web/
  manifest.webmanifest   module app: the PWA manifest (file_handlers, icons, display)
vite.web.config.js       module app: the web build into `dist-web/` and `npm run dev:web`
tests/stubs/fsa.js       the in-memory File System Access API        (foundation, done)
tests/web/               stub.test.js, rules.test.js (done); fs, watch, local, adapter tests
```

`npm run build:web` builds `dist-web/`: the same four bundles and the shell as `dist/`, plus
`sw.js`, `manifest.webmanifest` and a `<link rel="manifest">` added to `dist-web/index.html` by the
build (the shell's own `index.html` is not edited). `npm run dev:web` serves the shell with the
`ose:*` aliases like `vite.config.js`, without the Node bridge, with `__OSE_WEB__` true. Chrome
allows the File System Access API on `http://localhost`, so dev needs no certificate. Hosting the
built folder anywhere static over HTTPS (or opening it from localhost) is the whole deployment.

`tsconfig.json` covers `src/web/**` (checkJs, the `dom.asynciterable` lib added for folder
iteration); Biome covers it as `src/**/*.js`. No new npm dependency: IndexedDB is used directly,
and the tests run on `tests/stubs/fsa.js` and `idb.js`'s memory backend.

## Modules and their interfaces

Four builders, one module each. What one module needs of another is only what is written here.

### fs: `src/web/fs.js`

```js
export function createFs(root, opts) -> Fs
// root: FileSystemDirectoryHandle (the vault), permission already granted
// opts: {
//   vaultId: string,                     // the vault's key (drafts and local use it too)
//   epoch: () => number,                 // this tab's epoch now; a mutating call naming another is stale_vault
//   os: 'windows' | 'macos' | 'linux',   // the path rules of vaultSegments(p, os === 'windows')
//   log: (level, text) => void,          // local.log's writer
//   outside: { handle(absPath) -> Promise<FileSystemFileHandle | null> },   // vault-handle.js
//   onRename: (from, to) => Promise<void>,          // local.rekeyDrafts; fs calls it after a rename
// }
```

One async method per command below, same name, same positional arguments (`fs.saveFile(path,
text, opts)`), answering exactly what the host answers. Plus the helpers the others call:

- `readBytes(path) -> Uint8Array | null` (a vault path or a registered `abs:`; null when missing)
- `writeBytes(path, bytes) -> void`, atomic (`createWritable`, closed), folders made
- `hash(bytes | string)` (rules.js's, re-exported)
- `walk(hidden, visit(path, handle) -> false | void) -> Promise<boolean>`: the hide rule's walk,
  depth first, at most 24 deep; false when `visit` stopped it
- `followRename(from, to)`: what a rename seen on disk does to the app's own data: moves
  `.ose/history` and calls `opts.onRename` (the watcher calls it for a paired rename)
- `keepVersion(path, bytes, { force, reason })` (local calls it when a draft re-key collides)
- `requireVault()`: throws `no_vault` when the root is gone or permission was withdrawn
- `fileHandle(path, { create })`, `dirHandle(path, { create })`: the handle of a vault path

Versions belong to fs, not local: they live in the vault, `.ose/history`, as on the desktop
(docs/HOST.md "Versions"), and `saveFile` keeps one under the same lock as its write.

### watch: `src/web/watch.js`

```js
export function startWatch(root, fs, emit, opts?) -> stop()
// emit(event, data): the adapter's fan-out; watch sends only ('fs', FsEvent)
// opts: { outside?: { list() -> Promise<{ path, handle }[]> }, interval?: number (ms, default 2000),
//         observer?: constructor (default globalThis.FileSystemObserver) }
```

### local: `src/web/local.js`

```js
export function createLocal(vaultKey, opts?) -> Local
// vaultKey: the vault's id (or null with no vault: then only 'app' scope, draftList empty)
// opts: { epoch: () => number, keepVersion?: (path, bytes, o) => Promise<unknown> }
// methods: draftWrite, draftList, draftRead, draftDrop, localGet, localSet, log   (the commands)
//   rekeyDrafts(from, to)   (fs.onRename)
//   logLines(n?) -> string[]   the newest lines, for "Copy the log"
//   write(level, text)      the log writer fs and the adapter use (log() is the page's `ui:` one)
```

### app: `src/web/adapter.js`, `vault-handle.js`, `sw.js`, the manifest, the build

```js
export async function create() -> Adapter
// { invoke(name, args), subscribe(fn), platform, assetUrl(path), win: { setTitle, destroy }, close() }
```

`invoke` looks the name up in one table: the fs commands (when a vault is open), the local
commands, and the app's own; a name in none is `new HostError('unknown_command: <name>',
'unknown_command', name)`. With no vault open, a vault command is `no_vault`. `invoke` catches
everything its handlers throw and rethrows `fromDom(e)`, so no `DOMException` reaches the facade.

`vault-handle.js` exports the registries: `vaults` (`list`, `add(handle) -> id` deduplicated with
`isSameEntry`, `get(id)`, `forget(id)`, `touch(id)`), `outside` (`register(handle) -> absPath`,
`handle(absPath)`, `list()`), `permission(handle, { ask })`, `currentVault()` / `setCurrentVault(id)`
(per tab), `epoch()` / `bumpEpoch()`, and `holdVault(id) -> boolean` (the tab lock).

## Identity: vaults, roots, epochs, tabs

- A vault is `{ id, name, handle, openedAt }` in the IndexedDB store `vaults`. `id` is 16 random
  hex digits, made the first time a folder is picked; a folder picked again (`isSameEntry`) keeps
  its id. `rootInfo().root` is `web:<id>`, `name` is the folder's name. There is no absolute path in
  a browser, and `web:` is neither a drive nor a leading slash, so the address bar never takes it
  for one. The vault key of drafts and the local store is the `id`.
- A tab has one vault: `sessionStorage['ose.web.vault']`, else `?vault=<id>` on the URL (what
  `openVaultWindow` opens), else `meta.lastVault`. At boot the adapter reads its handle and asks
  `queryPermission({ mode: 'readwrite' })`: `granted` opens it; anything else answers `rootInfo`
  with nulls, and the shell's chooser shows the recent vaults. `requestPermission` needs a user
  gesture, which the chooser's click is: `openVault(root)` asks, then adopts.
- The epoch is per tab, in `sessionStorage['ose.web.epoch']`, 1 at first, one more on every adopt.
  A mutating call naming another is `stale_vault`, as on the desktop.
- One tab per vault, as one window per vault (X6): the tab holds the Web Lock `ose-vault:<id>`
  while it has the vault. `openVault` of a vault another tab holds answers
  `{ status: 'focused', label: 'tab' }` (a tab cannot focus another; the shell's toast says it is
  open elsewhere). A vault whose lock is taken at boot opens nothing: the chooser shows.
- Saves take the Web Lock `ose-save:<id>:<path>` inside the in-tab per-path lock, so two tabs (a
  vault tab and a tab with the same file opened from outside) never interleave a compare and a write.

## Files outside the vault

A browser has no paths. A file from outside comes as a `FileSystemFileHandle`, from `pickFile`
(`showOpenFilePicker`) or from the OS through the manifest's `file_handlers` and `launchQueue`. It
is kept in the store `outside` as `{ id, name, handle, openedAt }` and named
`abs:/web/<id>/<name>`, which is an `abs:` path to everything above the adapter. A handle that
`root.resolve()` places inside the open vault is that vault path instead (`inside: true`).
`outsideOpen` of an `abs:/web/…` path re-asks permission when needed (a gesture: the recovery sheet
and the address bar are clicks and keys); a native path typed into the address bar is `unsupported`
("a browser tab cannot open a path; use Open file…"). The **A** commands take these paths. What
the desktop refuses on an outside file (versions, rename, trash, copy, links, attachments), Ose
Web refuses the same way. Media beside an outside file cannot be reached (no folder access): only
the file itself is served.

## The hide rule

As `hide.rs`, ported in `rules.js` (`classify`, `isExcluded`): `.ose` and `.git` anywhere, the
app's files at the root, `.trash/.info`, and temp files; dotfiles are hidden until Show hidden.
Two differences, both forced by the browser: there is no system hidden flag (hidden is dotfiles
only), and Chrome's swap file `<name>.crswap` (where `createWritable` writes until `close()`) is a
temp file, excluded everywhere. The desktop's `hide.rs` and `dev/files.mjs` should learn
`.crswap` too, so a crash of a web save never shows a stray file in `ose.exe`: that is a separate
change, not part of this one. The File System Access API does not expose links: no entry has
`link`, and the walk never meets one.

## Machine-local state

What the desktop keeps in the app's folders on this machine, Ose Web keeps for its origin in
IndexedDB (`idb.js`, database `ose-web`): the vaults and outside handles, drafts (`drafts`,
`<vaultKey>/<pathKey>` with `pathKey = hash(path)`, the vault key `outside` for `abs:` paths), the
local store (`local`: `app` and `vault:<vaultKey>`, 1 MB each, the host keys `window` and `theme`
kept out of `app` as local.rs does), and the log (`log`, the newest 5000 lines). Nothing of it is
in the vault. What the desktop keeps in the vault, Ose Web keeps there too: `.ose/state.json`
(`getState`/`setState`) and `.ose/history` (versions). The origin's storage is asked to persist
(`navigator.storage.persist()`) at the first adopt, so Chrome does not evict drafts under pressure.

## Writes

`createWritable()` writes into a swap file and replaces the target on `close()`: that is the
atomic write, the bytes on disk are the old ones or the new ones. Every write goes through it
(`fs.writeBytes`), folders made on the way. On `saveFile` and `replaceLine`, the last look before
the rename (files.rs) is a read of the target just before `close()`: when it holds neither the
bytes compared nor the new ones, the writable is `abort()`ed and the answer is the conflict. When
`close()` fails, the new bytes are written to `<stem>.unsaved-<stamp>.<ext>` beside the target
(exclusive create) and the error is `write_failed … your text is in <that path>`, as the desktop's
set-aside; when that fails too, the page keeps the text and its draft. `appendLine` opens with
`keepExistingData: true`, seeks to the end and writes only the new line. Creates are exclusive:
the name is looked up first, under the path's lock.

## Errors

`rules.js` `fromDom(e, path)` maps what Chrome throws: `NotFoundError` and `TypeMismatchError` to
`not_found`, `InvalidModificationError` to `exists`, `NoModificationAllowedError` and
`QuotaExceededError` to `write_failed`, `NotAllowedError` and `SecurityError` to `no_vault`
(permission withdrawn), `NotSupportedError` to `unsupported`, `TypeError` (a name Chrome refuses)
to `bad_name`, anything else to `io`. `AbortError` from a picker is not an error: the command
answers null (cancelled).

## Events

The adapter's fan-out is http.js's: `subscribe(fn)` gets `{ event, data }`, and the results come
back as a list.

- `fs`: `{ changes: [{ path, kind, to?, dir?, hidden? }], rescan?, lost? }` exactly as
  `watcher.rs` sends it (see "The watcher" below).
- `open`: `{ requests: OpenRequest[] }` for a `launchQueue` launch after the first `takeOpens`.
- `window`: `{ closing: true }` on `beforeunload`. A browser does not wait for promises there:
  when any handler answers `false` or a promise that has not settled, the adapter calls
  `preventDefault()` and Chrome asks "Leave site?". The drafts cover the rest.

## The watcher

`startWatch` observes the root recursively with `FileSystemObserver` when there is one, and
falls back to polling (a walk under the hide rule every 2 s, 10 s while the document is hidden,
comparing `{kind, size, lastModified}`) when there is not or when `observe()` throws.

- Records: `appeared` → `create`, `disappeared` → `delete`, `modified` → `modify`, `moved` →
  `rename` with `to` (the path is `relativePathMovedFrom`, `to` is `relativePathComponents`),
  `unknown` → `{ changes: [], rescan: true }`, `errored` → restart the observer, `rescan: true`,
  and `lost: true` when the root cannot be read (then `lost: false` once it can again).
- 150 ms of quiet per path, then one event for what gathered; a path's changes merge (create then
  modify is create; create then delete is nothing; the kind is decided at flush from whether the
  path still exists, as watcher.rs does).
- Excluded paths are never reported (`isExcluded`, so the `.crswap` of every save is dropped);
  `dir: true` on a folder that is there, `hidden: true` on a dot path.
- A move into or out of `.trash` is a `delete` and a `create`, never a rename.
- A rename is `followRename(from, to)` on fs: the history and the drafts follow it, only when
  `from` is gone and `to` is there.
- Polling pairs a delete and a create of one flush as a rename when they have the same name, size
  and `lastModified` (or, in one folder, the same size and `lastModified` and exactly one pair).
- Outside files (`opts.outside`) are observed one by one (a file handle can be observed), or
  polled by `lastModified`; their changes carry their `abs:` path, `modify` or `delete`.
- The page's own writes are reported too, as the desktop's are; the editor tells its own save
  from another program's by the hash.

## The service worker and the `vault/` origin

`sw.js` precaches the build (the list `vite.web.config.js` writes into it, versioned by the build
stamp) and answers every app request from the cache: after the first visit nothing is fetched.
`assetUrl(path)` is `./vault/<vaultId>/<path>` (and `./vault/~abs/<outsideId>/<name>`); the worker
answers it from the handle in IndexedDB (`getFile()`, `Range` answered with 206 as protocol.rs
does, the type from protocol.rs's table), and when the worker has no permission it asks the page
that made the request (`clients.get(event.clientId)`, a `MessageChannel`) for the bytes. The
adapter's `create()` waits for the worker to control the page (at most 3 s; `clients.claim()` on
activate) so the first `<img>` already goes through it. The facade's `staticAssetUrl` answers the
same form for Ose Web before the adapter is ready.

## Commands

Module, arguments and answer as `docs/HOST.md`; what the web does. **A**: also takes an `abs:`
path. Every mutating command checks `opts.epoch` against the tab's epoch first (`stale_vault`),
and needs the vault (`no_vault` when the root is gone or permission was withdrawn).

### fs

| Command | Semantics (as dev/files.mjs) | Web |
|---|---|---|
| `tree(opts?: {hidden?})` | the vault as one Entry, `path: ''`, children folders first in natural order; `readable: false` on an unreadable folder; at most 24 deep | walk the handles; `mtime` of a file from `getFile().lastModified`, of a folder 0; `getFile` in parallel, at most 16 at once |
| `list(path, opts?: {hidden?})` | one folder's entries; an excluded path or a file is `not_found` | `entries()` of the folder handle |
| `stat` **A** `(path, opts?: {sniff?})` | `{exists, kind, mtime, size, hidden}`; missing is `{exists:false, kind:null, mtime:0, size:0, hidden:false}`; `sniff` adds `text` and `encoding` from the first 8 KB | `getFile().slice(0, 8192)` |
| `exists` **A** `(path)` | boolean | a lookup |
| `search(query, opts?: {limit?, chan?, hidden?})` | bridge-plugin.mjs `search`: terms ANDed, `path:` and `file:`, quoted phrases, names matched, the text extensions read, 20 lines per file, `col`, `limit` counts files (0 no cap), `chan` cancels an older walk (`stale`), never `.trash`; `{hits, files, total, capped, stale}` | the same code over `walk` |
| `readText` **A** `(path)` | UTF-8 or `not_utf8`; missing `not_found` | |
| `readFile` **A** `(path, opts?: {encoding?})` | `{text, hash, mtime, size, encoding, bom, lossy}`; hash of the bytes; encodings UTF-8, UTF-16LE/BE, windows-1252 (others `unsupported`) | `decodeText`; names as the host: `UTF-8` |
| `saveFile` **A** `(path, text, opts: {expectedHash, version?, encoding?, convert?, epoch?})` | `bad_arg` without a string text or an `expectedHash` that is not a string or null; encode first (`unencodable`); under the path lock: disk not round-tripping in a non-UTF-8 encoding is `lossy`; disk equal is `{status:'saved', hash, mtime, unchanged:true}`; hash mismatch (or null expected and a file there) is `{status:'conflict', disk:{exists, text, hash}}`; else write, last look, then the replaced bytes become a version (`save` tiered, `conflict` forced, `none`; never on `abs:`); log `save ok` / `save conflict` / `save failed` | see "Writes" |
| `createNew(path, text?, opts?)` | exclusive, `checkName`, `{path, hash}`; `exists` | |
| `createNewBinary(path, data, opts?)` | base64 decoded first; exclusive; a failed write removes the file | `atob` |
| `copyFile(from, to, opts?)` | a file's bytes into a new file, exclusive; a folder is `bad_arg` | |
| `importOutside(from, to, opts?)` | `from` must be a registered `abs:` (`bad_arg` / `not_registered`) | the outside handle's bytes |
| `appendLine(path, line, opts?)` | no `\r`/`\n` in `line` (`bad_arg`); the file's own EOL; a separator first when the file does not end in `\n`; file and folders made; `{hash}` of the whole new file | append only |
| `replaceLine(path, index, expected, next, opts?)` | `not_utf8` on a non-UTF-8 file; `{status:'conflict', actual}` when line `index` is not `expected` (null past the end); line 0 compared without a BOM; unchanged answers the hash; version after; `{status:'replaced', hash}` | last look before close |
| `writeText` / `appendText` / `writeBinary` `(path, data, opts?)` | the bytes as given; null | atomic; `appendText` appends |
| `readBinary` **A** `(path)` | base64 | |
| `mkdir(path, opts?)` | recursive; null | |
| `rename(from, to, opts?)` | never overwrites (`exists`); missing `not_found`; same path null; a case-only rename through `.<name>.<n>.case`; then the history moves and the drafts re-key; null | `handle.move(parent, name)`; a folder Chrome will not move is copied and the original removed only after the copy is whole |
| `copyPath(from, to, opts?)` | a file or folder, create-only; into itself `bad_arg`; the root as target `bad_name`; a half copy is removed; `{path, files}` | no links, so no `leftOut` |
| `trash(path, opts?: {mode?, epoch?})` | always the vault bin: `.trash/<ms>-<name>` (`<ms>-<n>-<name>` when taken), sidecar `.trash/.info/<entry>.json` `{v:1, original, deletedAt, kind}`; the root is `bad_arg`; `{id:'vault:<entry>', where:'vault'}` | `mode` ignored: a browser has no system bin |
| `trashWhere(path, opts?)` | `{where:'vault'}` | |
| `trashList()` | the bin's entries, newest first, `known:false` without a sidecar, `size` summed | |
| `trashRestore(ids, opts?)` | per id: `bad_arg` for a bad id, `not_found` when gone, `exists` when the place is taken; `{restored:[{id, path}], failed:[{id, error:'[code] message'}]}` | |
| `versionKeep(path, text, opts?: {force?, reason?, epoch?})` | `.ose/history/<path>/<id>.<reason>[-s].<ext>`; identical to the newest is not kept; not forced within a minute is not kept; tiered pruning (`survivors`), 200 MB cap; `abs:` is `unsupported`; `{kept, id}` | |
| `versionList(path)` | `[{id, at, bytes, reason, session}]`, newest first | |
| `versionRead(path, id)` | the text; a bad id `bad_arg`, a missing one `not_found` | |
| `versionRestore(path, id, opts?)` | the current bytes kept (`restore`), then the version written; `{kept, id, hash}` | |
| `getState()` | `.ose/state.json` parsed, `{}` when missing or broken | |
| `setState(state, opts?)` | the whole object, pretty JSON, atomic; `stale_vault`, `no_vault` | |

### watch

| Event | Web |
|---|---|
| `fs` | `startWatch` (see "The watcher"); started by the adapter when a vault opens, stopped on `close()` |

### local

| Command | Semantics | Web |
|---|---|---|
| `draftWrite` **A** `(path, draft, opts?)` | `bad_arg` without an object with a string `text`; stored `{v:1, vault, path, text, baselineHash, mode ('rich'\|'live'\|'source', else 'rich'), exact (default true), rev (default 0), at}`; `{at}` | IndexedDB `drafts`, one draft command at a time |
| `draftList()` | this vault's drafts and every outside file's, without text, `bytes` the UTF-8 length, newest first | |
| `draftRead` **A** `(path)` | the draft or null | |
| `draftDrop` **A** `(path, opts?: {ifRev?, epoch?})` | `{dropped:false}` when none or its `rev` is newer than `ifRev`; else removed, `{dropped:true}` | |
| `localGet(scope)` | `'app'` or `'vault'` (else `bad_arg`); `{}` when none; `window`/`theme` never shown from `app` | IndexedDB `local` |
| `localSet(scope, value, opts?)` | an object (`bad_arg`), at most 1 MB of JSON (`bad_arg`); the vault scope checks the epoch; host keys kept | |
| `log(text, level?)` | `<stamp> <level> ui: <text>`, level one of error/warn/info/debug else info; null; never fails | IndexedDB `log`, 5000 lines, and the console |

### app

| Command | Semantics | Web |
|---|---|---|
| `rootInfo()` | `{root, name, epoch}`, nulls with no vault | `web:<id>` |
| `vaultInfo()` | `{root, name, remembered, source, epoch}` | `remembered` true when the vault is in IndexedDB; `source` `remembered`, `picked` or `opened`, null with none |
| `pickVault(opts?: {adopt?})` | the picker; null on cancel; `adopt:false` answers `{root, name}` only | `showDirectoryPicker({id:'ose-vault', mode:'readwrite'})`; stored; adopted unless `adopt:false`; `{root, name, epoch}` |
| `openVault(path)` | adopt with no dialog, or `{status:'focused', label}` | `web:<id>` of a known vault (else `not_found`); permission asked (`no_vault` when refused); the tab lock; `{status:'adopted', root, name, epoch}` |
| `openVaultWindow(path?)` | `{label, created}` | `window.open('./?vault=<id>')`, or `./` with no path; `{label:'tab', created:true}`; a blocked pop-up is `unsupported` |
| `recentVaults()` | `[{path, name, exists, current}]`, newest first, at most ten | from IndexedDB; `exists` true (a browser cannot tell without asking) |
| `forgetVault(path?)` | with a path drop that entry; without, forget the remembered root; null | delete the record / clear `meta.lastVault` |
| `platform()` | `{os, version, exe, exeDir, root, logPath, build, dragIcon}` | `os` from `navigator.userAgentData` or the UA; `version` and `build` from the build stamp; `exe` `''`, `exeDir` null, `logPath` `'IndexedDB: ose-web/log'`, `dragIcon` null |
| `quit()` | null | null: a tab is closed by its person |
| `outsideOpen(path)` | `{path, inside, name, exists, kind}` | see "Files outside the vault" |
| `takeOpens()` | the OS opens queued, emptied | the `launchQueue` files, queued from `create()`; a folder handle is added to the recent vaults and not opened |
| `pickFile(opts?: {title?})` | a path or null | `showOpenFilePicker`, registered, its `abs:/web/…` path |
| `openExternal(url)` | http, https, mailto only (`bad_arg` otherwise); null | `window.open(url, '_blank', 'noopener')` |
| `openPath` **A** `(path)` | the default app | a PDF, image, text or media file opens in a new tab from a blob URL; anything else `unsupported`; an executable never |
| `reveal` **A** `(path)` | the file manager | `unsupported` |
| `printToPdf(path, opts?)` | `{path, bytes}` or `{cancelled}` | `{browser:true}`, as the dev bridge: the page says Export to PDF needs the app |
| `showPrintUI()` | `{shown:true}` | `{browser:true}`: the page calls `window.print()` |

Not host commands, the adapter's own: `win.setTitle` (the tab title), `win.destroy`
(`window.close()`), `assetUrl` (the worker's `vault/` form), `platform` (the OS name), no `dragOut`
(a browser cannot drag files out).

## What differs from the desktop

- Trash is always the vault's `.trash`; `trashWhere` says so, and the confirmation names it.
- No path is ever typed or shown: roots are `web:<id>`, outside files `abs:/web/<id>/<name>`.
  Files outside the vault come only through Open file… or the OS (installed PWA, "Open with").
- Drafts, the local store and the log live in the origin's IndexedDB, not in folders; clearing
  the site's data in Chrome clears them.
- One vault per tab instead of per window; "open in new window" is a new tab.
- No system hidden flag, no links, no drag out, no Reveal, no Export to PDF, no Ctrl+Q.
- Folder mtimes are not known (0); file mtimes are `lastModified`.
- The encodings are UTF-8, UTF-16LE, UTF-16BE and windows-1252, as the dev bridge's.

## Testing

`tests/stubs/fsa.js` is an in-memory File System Access API: path-based handles, `createWritable`
with a visible `.crswap` and replace on close, `move` that refuses a taken name (and optionally
folders), permissions, fault injection (`fsa.fail(op, path, name)`), outside changes
(`fsa.write`, `remove`, `rename`, `mkdir`, `touch`, `loseRoot`) and a `FileSystemObserver` twin
(`fsa.install()` puts it and the pickers on `globalThis`). `idb.js` runs on memory where there is
no IndexedDB. Each module has its test file in `tests/web/`, and the fs tests run the same cases
as `tests/dev-bridge/files.test.js` where the semantics are shared. Never a real vault.
