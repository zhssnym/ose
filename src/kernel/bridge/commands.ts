// The host's command contract: the argument and answer types of every command the kernel's
// facade (./index.js) calls. Hand-maintained. The one host is the browser, and src/web/adapter.js
// answers every command named in `Commands` below (src/web/fs.js and src/web/local.js do the
// work). A change of a command changes this file, the facade and the adapter together.
//
// First written by the old desktop host's generator (tauri-specta); its `_Serialize` /
// `_Deserialize` pairs are kept as they were, so the facade's typedefs read the same.

/**
 * Every host command, by the name the facade calls it with (src/kernel/bridge/index.js), with
 * its arguments in order and its answer. src/web/adapter.js answers each one.
 */
export type Commands = {
	/**  `rootInfo()`: this window's vault, or nulls, and its epoch. */
	rootInfo: () => Promise<RootInfo>,
	/**  `vaultInfo()`: `rootInfo` with where the root came from and whether one is remembered. */
	vaultInfo: () => Promise<VaultInfo>,
	/**
	 *  `pickVault({adopt})`: the native folder picker, opened in the executable's folder; `null` on
	 *  cancel. With `adopt` (the default) the choice is adopted in this window; without, it is only
	 *  chosen and answered as `{root, name}`, so the page can leave the old vault first.
	 */
	pickVault: (opts: {
	adopt?: boolean | null,
} | null) => Promise<{
	root: string,
	name: string,
	epoch?: number | null,
} | null>,
	/**
	 *  `openVault(path)`: adopts a folder in this window with no dialog, or focuses the window that
	 *  already has it (`{status:'focused', label}`).
	 */
	openVault: (path: string) => Promise<OpenVault>,
	/**
	 *  `openVaultWindow(path?)`: a window for the vault at `path`, focused when one exists, made
	 *  otherwise; with no path, a new window with no vault (the chooser).
	 */
	openVaultWindow: (path: string | null) => Promise<WindowOpened>,
	/**  `recentVaults()`: the vaults this machine opened, newest first, at most ten. */
	recentVaults: () => Promise<RecentVault[]>,
	/**  `forgetVault(path?)`: with a path, drops that recent entry; without, stops remembering a root. */
	forgetVault: (path: string | null) => Promise<null>,
	/**  `platform()`: what this host is. */
	platform: () => Promise<PlatformInfo>,
	/**
	 *  `quit()`: every window closes through its own save path (CloseRequested -> the adapter's
	 *  `closing` handshake -> destroy), so Ctrl+Q saves like the close button does (S16).
	 */
	quit: () => Promise<null>,
	/**  `log(text, level)`: a line of the page's into the host log. */
	log: (text: string, level: string | null) => Promise<null>,
	/**  `tree({hidden})`: the whole vault as one entry. */
	tree: (opts: {
	hidden?: boolean | null,
} | null) => Promise<Entry_Serialize>,
	/**  `list(path, {hidden})`: one folder's entries. */
	list: (path: string, opts: {
	hidden?: boolean | null,
} | null) => Promise<Entry_Serialize[]>,
	/**  `stat(path, {sniff})` (**A**). */
	stat: (path: string, opts: {
	sniff?: boolean | null,
} | null) => Promise<Stat_Serialize>,
	/**  `exists(path)` (**A**). */
	exists: (path: string) => Promise<boolean>,
	/**  `search(query, {limit, chan, hidden})`: files, lines and names. `limit: 0` is no cap. */
	search: (query: string, opts: {
	limit?: number | null,
	chan?: string | null,
	hidden?: boolean | null,
} | null) => Promise<SearchResult>,
	/**  `readText(path)` (**A**): the file as UTF-8, nothing else. */
	readText: (path: string) => Promise<string>,
	/**  `readFile(path, {encoding})` (**A**): the text, its hash and its encoding. */
	readFile: (path: string, opts: {
	/**  Decode in this encoding instead of detecting one (a WHATWG label). */
	encoding?: string | null,
} | null) => Promise<ReadFile>,
	/**
	 *  `saveFile(path, text, {expectedHash, version, encoding})` (**A**): compares and writes in one
	 *  call under one lock. On an outside file no version is kept.
	 */
	saveFile: (path: string, text: string, opts: SaveOpts_Deserialize) => Promise<SaveOutcome_Serialize>,
	/**  `createNew(path, text, opts)`: an exclusive create; never overwrites. */
	createNew: (path: string, text: string | null, opts: {
	epoch?: number | null,
} | null) => Promise<Created>,
	/**  `createNewBinary(path, base64, opts)`: bytes into a new file, created and written in one call. */
	createNewBinary: (path: string, data: string, opts: {
	epoch?: number | null,
} | null) => Promise<Created>,
	/**  `copyFile(from, to, opts)`: a byte copy under the create-only rule. */
	copyFile: (from: string, to: string, opts: {
	epoch?: number | null,
} | null) => Promise<Created>,
	/**  `importOutside(from, to, opts)`: a registered outside file's bytes into a new vault file. */
	importOutside: (from: string, to: string, opts: {
	epoch?: number | null,
} | null) => Promise<Created>,
	/**  `appendLine(path, line, opts)`: one line, with the separator the file uses. */
	appendLine: (path: string, line: string, opts: {
	epoch?: number | null,
} | null) => Promise<Hashed>,
	/**
	 *  `replaceLine(path, index, expected, next, opts)`: one line, only while it still reads
	 *  `expected`.
	 */
	replaceLine: (path: string, index: number, expected: string, next: string, opts: {
	epoch?: number | null,
} | null) => Promise<ReplaceOutcome>,
	/**  `writeText(path, text, opts)`: the bytes exactly as given, atomically. */
	writeText: (path: string, text: string, opts: {
	epoch?: number | null,
} | null) => Promise<null>,
	/**  `appendText(path, text, opts)`. */
	appendText: (path: string, text: string, opts: {
	epoch?: number | null,
} | null) => Promise<null>,
	/**  `writeBinary(path, base64, opts)`. */
	writeBinary: (path: string, data: string, opts: {
	epoch?: number | null,
} | null) => Promise<null>,
	/**  `readBinary(path)` (**A**): the bytes as base64. */
	readBinary: (path: string) => Promise<string>,
	/**  `mkdir(path, opts)`. */
	mkdir: (path: string, opts: {
	epoch?: number | null,
} | null) => Promise<null>,
	/**  `rename(from, to, opts)`: never overwrites; the history and the drafts follow. */
	rename: (from: string, to: string, opts: {
	epoch?: number | null,
} | null) => Promise<null>,
	/**  `copyPath(from, to, opts)`: a file or a whole folder, bytes, create-only. */
	copyPath: (from: string, to: string, opts: {
	epoch?: number | null,
} | null) => Promise<Copied_Serialize>,
	/**  `trash(path, {mode})`: to the system bin or the vault's `.trash`; never a permanent delete. */
	trash: (path: string, opts: {
	/**  `vault` for the vault's `.trash`, anything else for the system bin. */
	mode?: string | null,
	epoch?: number | null,
} | null) => Promise<Trashed>,
	/**  `trashWhere(path, {mode})`: where `trash` would put it. */
	trashWhere: (path: string, opts: {
	mode?: string | null,
} | null) => Promise<TrashPlace>,
	/**  `trashList()`: what can be restored, newest first. */
	trashList: () => Promise<TrashItem_Serialize[]>,
	/**  `trashRestore(ids, opts)`: back where they came from; never overwrites. */
	trashRestore: (ids: string[], opts: {
	epoch?: number | null,
} | null) => Promise<Restored>,
	/**  `draftWrite(path, draft, opts)` (**A**) -> `{at}`. */
	draftWrite: (path: string, draft: Draft_Deserialize, opts: {
	epoch?: number | null,
} | null) => Promise<DraftAt>,
	/**  `draftList()`: this window's vault's drafts and every outside file's, newest first. */
	draftList: () => Promise<DraftInfo[]>,
	/**  `draftRead(path)` (**A**): the draft, or `null`. */
	draftRead: (path: string) => Promise<{
	text: string,
	baselineHash: string | null,
	mode: EditorMode,
	exact?: boolean,
	rev?: number | null,
	at?: number | null,
	/**  Set by the host on the way out: the vault path or `abs:` path. */
	path?: string | null,
} | null>,
	/**  `draftDrop(path, {ifRev})` (**A**): only a draft at that edit or before it goes. */
	draftDrop: (path: string, opts: {
	ifRev?: number | null,
	epoch?: number | null,
} | null) => Promise<Dropped>,
	/**  `versionKeep(path, text, {force, reason})`. */
	versionKeep: (path: string, text: string, opts: {
	force?: boolean | null,
	/**  `save`, `conflict`, `reload` or `restore`. */
	reason?: string | null,
	epoch?: number | null,
} | null) => Promise<Kept>,
	/**  `versionList(path)`: newest first. */
	versionList: (path: string) => Promise<VersionInfo[]>,
	/**  `versionRead(path, id)`: the text, or `null` when there is no such version. */
	versionRead: (path: string, id: string) => Promise<string | null>,
	/**  `versionRestore(path, id, opts)`. */
	versionRestore: (path: string, id: string, opts: {
	epoch?: number | null,
} | null) => Promise<RestoredVersion>,
	/**  `getState()`: the vault's `.ose/state.json`. */
	getState: () => Promise<Json>,
	/**  `setState(state, opts)`: the whole object. */
	setState: (state: Json, opts: {
	epoch?: number | null,
} | null) => Promise<null>,
	/**  `localGet(scope)`: this machine's object for the app or for this window's vault. */
	localGet: (scope: LocalScope) => Promise<Json>,
	/**  `localSet(scope, value, opts)`: the whole object, at most 1 MB. */
	localSet: (scope: LocalScope, value: Json, opts: {
	epoch?: number | null,
} | null) => Promise<null>,
	/**  `openExternal(url)`: http, https and mailto only. */
	openExternal: (url: string) => Promise<null>,
	/**  `openPath(path)` (**A**): in the default application; an executable is revealed instead. */
	openPath: (path: string) => Promise<null>,
	/**  `reveal(path)` (**A**): selected in the file manager. */
	reveal: (path: string) => Promise<null>,
	/**  `printToPdf(path, {name, folder})`: the page as a PDF; with no path the host asks where. */
	printToPdf: (path: string | null, opts: {
	name?: string | null,
	folder?: string | null,
} | null) => Promise<PdfOutcome>,
	/**
	 *  `showPrintUI()`: the system print dialog; returns at once. (The Rust name spells the last
	 *  two letters apart so the JS name is `showPrintUI`, the name the page has always called.)
	 */
	showPrintUI: () => Promise<Shown>,
	/**
	 *  `outsideOpen(path)`: a native absolute path or `abs:`. Inside this window's vault it answers
	 *  the vault path and registers nothing; anywhere else the file is registered for this window
	 *  (reads, saves, drafts, its folder's media and a watch) and answered as `abs:`. Idempotent.
	 */
	outsideOpen: (path: string) => Promise<OutsideFile>,
	/**
	 *  `takeOpens()`: the OS opens queued for this window, emptied. From now on an open is the
	 *  `open` event.
	 */
	takeOpens: () => Promise<OpenRequest_Serialize[]>,
	/**  `pickFile({title})`: the native open-file dialog; a native absolute path, or `null`. */
	pickFile: (opts: {
	title?: string | null,
} | null) => Promise<string | null>,
};

/* Types */
export type BuildStamp = {
	sha: string,
	short: string,
	date: string,
};

export type Copied = Copied_Serialize | Copied_Deserialize;

export type Copied_Deserialize = {
	path: string,
	files: number,
	leftOut?: string[] | null,
};

export type Copied_Serialize = {
	path: string,
	files: number,
	leftOut?: string[] | null,
};

export type Created = {
	path: string,
	hash: string,
};

export type DiskState = {
	exists: boolean,
	text: string | null,
	hash: string | null,
};

export type Draft = Draft_Serialize | Draft_Deserialize;

export type DraftAt = {
	at: number,
};

export type DraftDropOpts = {
	ifRev?: number | null,
	epoch?: number | null,
};

export type DraftInfo = {
	path: string,
	baselineHash: string | null,
	mode: EditorMode,
	exact: boolean,
	rev: number | null,
	at: number,
	bytes: number,
};

export type Draft_Deserialize = {
	text: string,
	baselineHash: string | null,
	mode: EditorMode,
	exact?: boolean,
	rev?: number | null,
	at?: number | null,
	/**  Set by the host on the way out: the vault path or `abs:` path. */
	path?: string | null,
};

export type Draft_Serialize = {
	text: string,
	baselineHash: string | null,
	mode: EditorMode,
	exact?: boolean,
	rev?: number | null,
	at?: number | null,
	/**  Set by the host on the way out: the vault path or `abs:` path. */
	path?: string | null,
};

export type Dropped = {
	dropped: boolean,
};

export type EditorMode = "rich" | "live" | "source";

/**
 *  One entry of a listing or of the tree (docs/HOST.md "Entry"). `kind` is what a link points
 *  at when the entry is a link; `link` says it is one and what kind; `readable: false` marks a
 *  folder the host could not open; `children` is filled by `tree` alone, never under a link.
 */
export type Entry = Entry_Serialize | Entry_Deserialize;

/**
 *  One entry of a listing or of the tree (docs/HOST.md "Entry"). `kind` is what a link points
 *  at when the entry is a link; `link` says it is one and what kind; `readable: false` marks a
 *  folder the host could not open; `children` is filled by `tree` alone, never under a link.
 */
export type Entry_Deserialize = {
	name: string,
	path: string,
	kind: string,
	ext: string,
	mtime: number,
	size: number,
	hidden: boolean,
	link?: string | null,
	readable?: boolean | null,
	children?: Entry_Deserialize[] | null,
};

/**
 *  One entry of a listing or of the tree (docs/HOST.md "Entry"). `kind` is what a link points
 *  at when the entry is a link; `link` says it is one and what kind; `readable: false` marks a
 *  folder the host could not open; `children` is filled by `tree` alone, never under a link.
 */
export type Entry_Serialize = {
	name: string,
	path: string,
	kind: string,
	ext: string,
	mtime: number,
	size: number,
	hidden: boolean,
	link?: string | null,
	readable?: boolean | null,
	children?: Entry_Serialize[] | null,
};

/**  Only the epoch. */
export type EpochOpts = {
	epoch?: number | null,
};

export type FailedItem = {
	id: string,
	error: string,
};

/**  One change of the `fs` event. */
export type FsChange = {
	/**  A vault path, or `abs:` for an outside file this window opened. */
	path: string,
	/**  `create`, `modify`, `delete` or `rename`. */
	kind: string,
	to?: string | null,
	dir?: boolean | null,
	hidden?: boolean | null,
};

/**  The `fs` event, sent to its own window only. */
export type FsEvent = {
	changes: FsChange[],
	/**  The vault folder itself went away (`true`) or came back (`false`). */
	lost?: boolean | null,
	/**  Something may have been missed: re-read what is shown. */
	rescan?: boolean | null,
};

export type Hashed = {
	hash: string,
};

/**
 *  Every refusal a command can answer. `#[serde(tag, content)]` makes each variant
 *  `{ "code": "<snake_case name>", "message": "<text>" }` on the wire.
 */
export type HostError = 
/**  The file or folder is not there. */
{ code: "not_found"; message: string } | 
/**  Something is already at the target of a create-only write. */
{ code: "exists"; message: string } | 
/**  The file is not valid in the encoding it was asked to be read in. */
{ code: "not_utf8"; message: string } | 
/**  A character of the text has no bytes in the file's encoding; nothing was written. */
{ code: "unencodable"; message: string } | 
/**
 *  The file's bytes do not survive a decode and an encode: it opens read-only, and a save
 *  in its encoding is refused.
 */
{ code: "lossy"; message: string } | 
/**  The page belongs to another vault epoch than the one this window has open. */
{ code: "stale_vault"; message: string } | 
/**  This window has no vault open. */
{ code: "no_vault"; message: string } | 
/**  The write did not go through; the message says where the bytes are when they survived. */
{ code: "write_failed"; message: string } | 
/**  An argument that is not what the command takes. */
{ code: "bad_arg"; message: string } | 
/**  A name the filesystem would refuse or silently change. */
{ code: "bad_name"; message: string } | 
/**  A path that leaves the vault, or an outside path given to a command that takes none. */
{ code: "escapes_vault"; message: string } | 
/**  An outside (`abs:`) path this window has not opened. */
{ code: "not_registered"; message: string } | 
/**  Not on this platform, not in this build, or not for an outside file. */
{ code: "unsupported"; message: string } | 
/**  Everything else the disk or the system said. */
{ code: "io"; message: string };

/**
 *  Any JSON the page keeps (its state, the local store): `unknown` in TypeScript. (specta's own
 *  `serde_json::Value` recurses without end in this beta, so the value travels in a newtype.)
 */
export type Json = unknown;

export type KeepOpts = {
	force?: boolean | null,
	/**  `save`, `conflict`, `reload` or `restore`. */
	reason?: string | null,
	epoch?: number | null,
};

export type Kept = {
	kept: boolean,
	id: string | null,
};

export type ListOpts = {
	hidden?: boolean | null,
};

export type LocalScope = "app" | "vault";

/**  The payload of the `open` event. */
export type OpenEvent = OpenEvent_Serialize | OpenEvent_Deserialize;

/**  The payload of the `open` event. */
export type OpenEvent_Deserialize = {
	requests: OpenRequest_Deserialize[],
};

/**  The payload of the `open` event. */
export type OpenEvent_Serialize = {
	requests: OpenRequest_Serialize[],
};

export type OpenKind = "file" | "dir";

/**  One OS open for a window: a vault path, or `abs:` for a file outside every vault. */
export type OpenRequest = OpenRequest_Serialize | OpenRequest_Deserialize;

/**  One OS open for a window: a vault path, or `abs:` for a file outside every vault. */
export type OpenRequest_Deserialize = {
	/**  A vault path, or `abs:<absolute path>` for a file outside the vault. */
	path: string,
	outside: boolean,
	kind: OpenKind,
	line?: number | null,
};

/**  One OS open for a window: a vault path, or `abs:` for a file outside every vault. */
export type OpenRequest_Serialize = {
	/**  A vault path, or `abs:<absolute path>` for a file outside the vault. */
	path: string,
	outside: boolean,
	kind: OpenKind,
	line?: number | null,
};

export type OpenVault = { status: "adopted"; root: string; name: string; epoch: number } | { status: "focused"; label: string };

export type OutsideFile = {
	/**  The vault path when the file is inside this window's vault, else its `abs:` path. */
	path: string,
	inside: boolean,
	name: string,
	exists: boolean,
	kind: string | null,
};

export type PdfOpts = {
	name?: string | null,
	folder?: string | null,
};

export type PdfOutcome = ({ path: string; bytes: number }) & { cancelled?: never } | ({ cancelled: boolean }) & { bytes?: never; path?: never };

export type PickFileOpts = {
	title?: string | null,
};

export type PickVaultOpts = {
	adopt?: boolean | null,
};

export type PickedVault = PickedVault_Serialize | PickedVault_Deserialize;

export type PickedVault_Deserialize = {
	root: string,
	name: string,
	epoch?: number | null,
};

export type PickedVault_Serialize = {
	root: string,
	name: string,
	epoch?: number | null,
};

export type PlatformInfo = {
	os: string,
	version: string,
	exe: string,
	exeDir: string | null,
	root: string | null,
	logPath: string,
	build: BuildStamp | null,
	/**  A PNG the host wrote for the drag-out image, or null. */
	dragIcon: string | null,
};

export type ReadFile = {
	text: string,
	hash: string,
	mtime: number,
	size: number,
	/**
	 *  The encoding the text was decoded from, as the Encoding Standard names it (`UTF-8`,
	 *  `UTF-16LE`, `windows-1252`, …).
	 */
	encoding: string,
	bom: boolean,
	/**  The bytes do not come back from encoding the text: open read-only. */
	lossy: boolean,
};

export type ReadOpts = {
	/**  Decode in this encoding instead of detecting one (a WHATWG label). */
	encoding?: string | null,
};

export type RecentVault = {
	path: string,
	name: string,
	exists: boolean,
	current: boolean,
};

export type ReplaceOutcome = { status: "replaced"; hash: string } | { status: "conflict"; actual: string | null };

export type Restored = {
	restored: RestoredItem[],
	failed: FailedItem[],
};

export type RestoredItem = {
	id: string,
	path: string,
};

export type RestoredVersion = {
	kept: boolean,
	id: string | null,
	hash: string,
};

export type RootInfo = {
	root: string | null,
	name: string | null,
	epoch: number,
};

export type RootSource = "arg" | "exe" | "env" | "remembered" | "picked" | "opened";

export type SaveOpts = SaveOpts_Serialize | SaveOpts_Deserialize;

export type SaveOpts_Deserialize = {
	/**  Required: the hash `readFile` answered, or `null` when the file must not exist. */
	expectedHash: string | null,
	version?: VersionMode | null,
	/**  The encoding to write in; UTF-8 when absent. */
	encoding?: string | null,
	/**
	 *  `true` only for an explicit conversion to UTF-8 (`page.save-utf8`). A UTF-8 save over a
	 *  file whose bytes are not UTF-8 is `lossy` without it, and nothing is written.
	 */
	convert?: boolean | null,
	epoch?: number | null,
};

export type SaveOpts_Serialize = {
	/**  Required: the hash `readFile` answered, or `null` when the file must not exist. */
	expectedHash: string | null,
	version?: VersionMode | null,
	/**  The encoding to write in; UTF-8 when absent. */
	encoding?: string | null,
	/**
	 *  `true` only for an explicit conversion to UTF-8 (`page.save-utf8`). A UTF-8 save over a
	 *  file whose bytes are not UTF-8 is `lossy` without it, and nothing is written.
	 */
	convert?: boolean | null,
	epoch?: number | null,
};

export type SaveOutcome = SaveOutcome_Serialize | SaveOutcome_Deserialize;

export type SaveOutcome_Deserialize = ({ status: "saved"; hash: string; mtime: number; unchanged?: boolean | null }) & { disk?: never } | ({ status: "conflict"; disk: DiskState }) & { hash?: never; mtime?: never; unchanged?: never };

export type SaveOutcome_Serialize = ({ status: "saved"; hash: string; mtime: number; unchanged?: boolean | null }) & { disk?: never } | ({ status: "conflict"; disk: DiskState }) & { hash?: never; mtime?: never; unchanged?: never };

export type SearchHit = {
	path: string,
	line: number,
	col: number,
	text: string,
	kind: string,
};

export type SearchOpts = {
	limit?: number | null,
	chan?: string | null,
	hidden?: boolean | null,
};

export type SearchResult = {
	hits: SearchHit[],
	files: number,
	total: number,
	capped: boolean,
	stale: boolean,
};

export type Shown = {
	shown: boolean,
};

export type Stat = Stat_Serialize | Stat_Deserialize;

export type StatOpts = {
	sniff?: boolean | null,
};

export type Stat_Deserialize = {
	exists: boolean,
	kind: string | null,
	mtime: number,
	size: number,
	hidden: boolean,
	link?: string | null,
	text?: boolean | null,
	encoding?: string | null,
};

export type Stat_Serialize = {
	exists: boolean,
	kind: string | null,
	mtime: number,
	size: number,
	hidden: boolean,
	link?: string | null,
	text?: boolean | null,
	encoding?: string | null,
};

export type TrashItem = TrashItem_Serialize | TrashItem_Deserialize;

export type TrashItem_Deserialize = {
	id: string,
	name: string,
	original: string,
	deletedAt: number,
	kind: string,
	size: number,
	where: string,
	known?: boolean | null,
};

export type TrashItem_Serialize = {
	id: string,
	name: string,
	original: string,
	deletedAt: number,
	kind: string,
	size: number,
	where: string,
	known?: boolean | null,
};

export type TrashOpts = {
	/**  `vault` for the vault's `.trash`, anything else for the system bin. */
	mode?: string | null,
	epoch?: number | null,
};

export type TrashPlace = {
	where: string,
};

export type TrashWhereOpts = {
	mode?: string | null,
};

export type Trashed = {
	id: string | null,
	where: string,
};

export type VaultInfo = {
	root: string | null,
	name: string | null,
	remembered: boolean,
	source: RootSource | null,
	epoch: number,
};

export type VersionInfo = {
	id: string,
	at: number,
	bytes: number,
	reason: string,
	session: boolean,
};

export type VersionMode = "save" | "conflict" | "none";

export type WindowOpened = {
	label: string,
	created: boolean,
};
