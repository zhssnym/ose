// JSDoc typedefs shared by the core (checkJs, §8.3 of the wave-3 contract). Types only: this
// module exports nothing at run time, and importing it costs nothing. The host's own shapes
// (ReadFile, SaveOutcome, OpenRequest, …) are declared in ./bridge/commands.ts and are named
// from there; what is here is what the core itself defines.

/**
 * A page route: a file, vault path or `abs:` path (X7). `line` and `col` are 1-based, `heading`
 * a `#fragment`, `query` the find text, `selection` the caret to restore; all are spent once
 * the route has been shown.
 * @typedef {object} PageRoute
 * @property {'page'} type
 * @property {string} path
 * @property {number} [line]
 * @property {number} [col]
 * @property {string} [heading]
 * @property {string} [query]
 * @property {{ from: number, to: number }} [selection]
 */

/**
 * A folder route: `path` '' is the vault root; `select` the child to put the selection on.
 * @typedef {object} FolderRoute
 * @property {'folder'} type
 * @property {string} path
 * @property {string} [select]
 */

/**
 * A view route: a registered view by name; `arg` what it is asked to show.
 * @typedef {object} ViewRoute
 * @property {'view'} type
 * @property {string} name
 * @property {string} [arg]
 */

/** @typedef {PageRoute | FolderRoute | ViewRoute} Route */

/**
 * One tab: its history (`stack`, `index` the entry on screen), and per route key the scroll
 * offset and a folder's selected child.
 * @typedef {object} TabRecord
 * @property {string} id
 * @property {Route[]} stack
 * @property {number} index
 * @property {Map<string, number>} scroll
 * @property {Map<string, string | null>} select
 */

/**
 * A status bar field as it is set (`ose.status.set(key, field)`, docs/CORE.md).
 * @typedef {object} StatusField
 * @property {unknown} [text]
 * @property {string | null} [kind]
 * @property {(() => void) | null} [onClick]
 * @property {string} [title]
 * @property {{ value: string, label?: string }[]} [choices]
 * @property {string | null} [value]
 * @property {((value: string) => void) | null} [onChoose]
 */

/**
 * A status bar field as it is kept and listed.
 * @typedef {object} StatusEntry
 * @property {string} text
 * @property {string | null} kind
 * @property {(() => void) | null} onClick
 * @property {string} [title]
 * @property {{ value: string, label: string }[]} [choices]
 * @property {string | null} [value]
 * @property {((value: string) => void) | null} [onChoose]
 */

/**
 * One change the watcher reports (docs/HOST.md "Events"). `path` is a vault path, or the
 * `abs:` path of a file outside the vault this window opened.
 * @typedef {object} FsChange
 * @property {string} kind
 * @property {string} path
 * @property {string} [to]
 * @property {boolean} [dir]
 * @property {boolean} [hidden]
 */

/**
 * @typedef {object} FsEvent
 * @property {FsChange[]} changes
 * @property {boolean} [lost]
 * @property {boolean} [rescan]
 */

/**
 * One item of an OS drop, as the shell gathers it (§5.5): `path` relative inside the drop.
 * @typedef {object} ImportEntry
 * @property {string} path
 * @property {'dir' | 'file'} kind
 * @property {File} [file]
 */

/**
 * Window control the adapter has (a browser tab: its title, and a close through the gate).
 * @typedef {object} AdapterWindow
 * @property {() => Promise<unknown>} [close]
 * @property {(theme: string) => Promise<unknown>} [setTheme]
 * @property {(text: string) => unknown} [setTitle]
 * @property {() => unknown} [destroy]
 */

/**
 * What every bridge adapter answers (./bridge/index.js).
 * @typedef {object} Adapter
 * @property {(name: string, args: unknown[]) => Promise<unknown>} invoke
 * @property {(fn: (msg: { event: string, data: any }) => unknown) => () => void} subscribe
 * @property {string} [platform]
 * @property {(path: string) => string} [assetUrl]
 * @property {AdapterWindow} [win]
 * @property {() => void} [close]
 */

/**
 * The page host the shell registers (./pagehost.js); every method but `open` is optional.
 * @typedef {object} PageHost
 * @property {(el: HTMLElement, path: string, opts: { line?: number, col?: number, query?: string, selection?: { from: number, to: number } | null }) => Promise<unknown>} open
 * @property {(reason: string) => Promise<boolean> | boolean} [canLeave]
 * @property {() => void} [stay]
 * @property {(opts?: { park?: boolean }) => Promise<boolean> | boolean} [close]
 * @property {(path: string) => Promise<boolean> | boolean} [release]
 * @property {(path: string, pairs: { from: string, to: string }[], opts?: { settled?: boolean }) => Promise<{ handled: boolean, changed?: number, failed?: string } | null | undefined>} [rewriteLinksIn]
 * @property {(line: number, col?: number) => boolean} [scrollToLine]
 * @property {() => { from: number, to: number } | null} [selection]
 * @property {(text: string, heading: string) => number} [headingLine]
 * @property {(change: { kind: string, from: string, to: string | null }) => Promise<{ ok: boolean, reason?: string }>} [beforePathChange]
 * @property {(change: { kind: string, from: string, to: string | null, ok: boolean, rewritten?: Record<string, string> }) => Promise<unknown>} [afterPathChange]
 * @property {(path: string) => boolean} [claims]
 * @property {() => (string | { path: string })[]} [problems]
 */

/**
 * The folder host the shell registers (./pagehost.js).
 * @typedef {object} FolderHost
 * @property {(el: HTMLElement, path: string, opts: { select?: string, scrollTop?: number }) => Promise<FolderHandle | null | undefined>} open
 */

/**
 * @typedef {object} FolderHandle
 * @property {() => unknown} [unmount]
 * @property {() => void} [refresh]
 * @property {() => string | null} [selection]
 */

export {};
