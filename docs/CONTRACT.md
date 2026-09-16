# os editor: contracts between modules

This file is the agreement every module codes against. Read it fully before touching anything.
If you need something that is not here, add it here first, then implement it.

## What the app is

A markdown viewer and editor that parses certain files and builds a graphical interface from
them, while keeping every file ordinary prose so an agent can read and edit the same vault
with no adapter. Pages are markdown files in a block editor. Views (day, week, month, journal)
are screens built from specific files the user names in settings. Everything is local; there is
no AI surface inside the app (batch 8). The host is Tauri 2; the UI is a Vite-built static site
embedded in the exe. In development the same UI runs in a normal browser against a Node bridge.

## Folder layout

```
App/
  index.html            entry, mounts #app
  vite.config.js        dev server + dev bridge plugin + build to dist/
  package.json
  DESIGN.md             visual system (read it)
  CONTRACT.md           this file
  dev/bridge-plugin.mjs Vite plugin: Node implementation of the bridge (dev only)
  host/                 .NET project, produces os.exe (embeds dist/)
  src/
    main.js             boot: theme, bridge, shell, register modules
    registry.js         bus, store, commands, views, status (shared, do not fork)
    bridge/index.js     bridge facade (picks adapter), the API every module uses
    bridge/webview.js   adapter for WebView2 (window.chrome.webview)
    bridge/http.js      adapter for the dev bridge (fetch + SSE)
    styles/tokens.css   all colours, fonts, sizes
    styles/base.css     reset, scrollbars, canonical components (.btn .input .chip .row ...)
    shell/              layout, titlebar, sidebar, statusbar, palette, settings, router
    editor/             Crepe-based page editor
    views/              week, habits, journal, tasks
    lib/                shared helpers (md parsers, dates, paths)
  legacy/               old dashboard, reference only, never imported
```

Ownership: one agent per folder. Do not edit another folder's files; if you need a change in
`registry.js`, `tokens.css`, or `base.css`, add to them additively (new tokens, new class,
new function) and note it in your report.

## Paths

Vault paths are relative to the vault root, forward slashes, no leading slash:
`Personal/4. Journal/2026-09-03 - Journal.md`. The root is resolved by the host (the folder
containing the exe, or the nearest ancestor that contains `CLAUDE.md` and `Inbox.md`).

Hidden from the tree and search: `.git`, `.obsidian`, `.claude`, `.vscode`, `.trash`,
`node_modules`, `App/`, `_Archive/` (shown collapsed at the bottom), and any dotfile.

## registry.js (shared kernel)

```js
import { bus, store, commands, views, status } from './registry.js'

bus.on('name', fn) -> unsubscribe      bus.emit('name', payload)
  events used app-wide:
    'route'            {type:'page'|'view', path?|name?}   after navigation
    'doc:saved'        {path}
    'doc:dirty'        {path, dirty:boolean}
    'fs'               {changes:[{path, kind}]}            re-emitted from the bridge
    'theme'            'light'|'dark'

store.get(key) / store.set(key, value) / store.watch(key, fn) -> unsubscribe
  keys:
    'theme'            'light'|'dark'        set by shell only
    'route'            current route object
    'sidebar.open'     boolean
    'claude.open'      boolean
    'claude.status'    'off'|'running'|'exited'   (batch 6; was off|idle|thinking|tool|error)
    'root'             {root, name} from bridge.rootInfo()
    'pageTitle'        {path, title} | null   what the open page calls itself, set by the editor

commands.register({ id, title, group, hint?, shortcut?, when?: () => boolean, run: () => void })
commands.list() -> [...]     commands.run(id)
  groups: 'navigate' | 'page' | 'view' | 'claude' | 'app'
  The palette (Ctrl+K) and the editor slash menu both read this list.
  ids are kebab-case: 'view.week', 'page.new', 'claude.toggle', 'app.theme'.

views.register(name, { title, icon?, mount(el), unmount(), refresh() })
views.get(name)   views.list()
  mount(el): render into el (el is empty, already in the page column). unmount(): cleanup.
  refresh(): called after relevant 'fs' events (the shell calls it; the view decides what to reread).

status.set(key, text|null)      key: 'mode'|'path'|'doc'|'save'|'watch'|'claude'
  The status bar renders keys in that order, separated by ' · ', null hides a key.
```

## bridge/index.js (the only way to touch the host)

```js
import { bridge } from './bridge/index.js'

bridge.kind                    'webview' | 'http'
bridge.ready                   Promise resolved when the adapter is connected

// filesystem
bridge.rootInfo()              -> {root, name}
bridge.tree()                  -> Node  {name, path, kind:'dir'|'file', ext, mtime, size, children?}
bridge.list(path)              -> [Node]  (one level)
bridge.stat(path)              -> {exists, kind, mtime, size}
bridge.exists(path)            -> boolean
bridge.readText(path)          -> string
bridge.writeText(path, text)   -> void   (creates parent dirs)
bridge.appendText(path, text)  -> void
bridge.mkdir(path)             -> void
bridge.rename(from, to)        -> void
bridge.trash(path)             -> void   (Recycle Bin, never permanent)
bridge.search(query, {limit=200}) -> [{path, line, text}]   case-insensitive substring in *.md
bridge.assetUrl(path)          -> string  usable in <img src>  (webview: https://vault.os/<path>, http: /vault/<path>)

// events
bridge.on('fs', ({changes:[{path, kind:'create'|'modify'|'delete'|'rename', to?}]}) => {}) -> unsubscribe
bridge.on('claude', ({id, event}) => {})   event: a parsed stream-json object from Claude Code,
                                           or {type:'stderr', text}, or {type:'exit', code}
bridge.on('window', ({maximized, focused}) => {})

// claude (Claude Code CLI as a child process)
bridge.claudeStart({cwd, permissionMode:'acceptEdits'|'bypassPermissions'|'plan'|'default', resume?, model?})
                               -> {id}
bridge.claudeSend(id, text)    -> void   writes a user message line to stdin
bridge.claudeInterrupt(id)     -> void   control_request interrupt
bridge.claudeStop(id)          -> void   kills the process

// window (no-ops in http mode)
bridge.win.minimize() .maximize() .close() .isMaximized() -> boolean
bridge.win.startDrag()         call on mousedown in the title bar
bridge.win.startResize(edge)   edge: 'left'|'right'|'top'|'bottom'|'topleft'|'topright'|'bottomleft'|'bottomright'
bridge.win.setTheme('light'|'dark')   host recolours the frame, DWM border, and form background

// misc
bridge.openExternal(url)       default browser
bridge.reveal(path)            Explorer with the file selected
bridge.getState()              -> object  (App/state.json, may be {})
bridge.setState(obj)           -> void    (whole object replaced)
```

Errors reject with `Error(message)`. Never swallow them silently; surface in the status bar.

## Host protocol (WebView2)

_Historical: the .NET WebView2 host was retired on 2026-09-06 in favour of the Tauri host
(TAURI.md). The adapter in `src/bridge/webview.js` stays for reference only._

Web to host: `window.chrome.webview.postMessage({ id, cmd, args })` where `cmd` is the bridge
method name in camelCase (`readText`, `claudeSend`, `winStartDrag`, ...), `args` an array.
Host to web: `postWebMessageAsJson` of `{ id, ok:true, result }` or `{ id, ok:false, error }`,
and unsolicited events `{ event:'fs'|'claude'|'window', data }`.

UI is served from `https://app.os/` (embedded resources answered in `WebResourceRequested`).
Vault files are served read-only from `https://vault.os/<path>` via
`SetVirtualHostNameToFolderMapping`.

## Dev bridge protocol (browser)

`POST /__bridge/<cmd>` with JSON body `{args:[...]}`, reply `{ok, result|error}`.
Events: `GET /__bridge/events` as Server-Sent Events, each `data:` is `{event, data}`.
Assets: `GET /vault/<path>`. Root is `process.env.OS_ROOT` or the parent of `App/`.

## Editor contract

```js
import { openPage, closePage, getOpenPath, saveNow } from './editor/index.js'
openPage(el, path)     mount editor for the file into el (called by the shell router)
closePage()            flush pending save, unmount
```

- Markdown is the source of truth. Never write on open, only after a user edit.
- Save: debounced 600ms after the last change, plus on blur, route change, and window close.
- Stringify settings must preserve Hassan's conventions: `-` bullets, `_` emphasis, `**` strong,
  no trailing spaces, single blank line between blocks, ATX headings, `---` rule, tables kept.
- YAML frontmatter (`---` block at the very top) is preserved verbatim and shown as a
  collapsible "properties" strip above the title, never fed to the editor body.
- The first H1 in the file is the page title (editable). A file without an H1 uses the file
  name as title and creating one is a user action, not automatic.
- Relative image paths resolve through `bridge.assetUrl`.
- External fs changes to the open file: if the editor is not dirty, reload silently; if dirty,
  keep the user's version, toast once, and ask at the next save (batch 9: Cancel / Reload from
  disk / Keep mine). A rename with `to` re-routes the page; a delete makes it read-only.

## Views contract

Files the views read (verified 2026-09-06):

```
Learning/School/0-index/Timetable.md            week grid    (parser in legacy/js/schedule.js)
Personal/3. Action/2026/2026-09 Monthly Plan.md  monthly goals (legacy/js/md.js parseMonthlyPlan)
Personal/3. Action/<year>/<YYYY-MM> Monthly Plan.md  "# Systems" section (batch 2; the Habits folder is retired)
Personal/3. Action/systems-log.jsonl             system check log, append only, keys {date, system|habit, done, at}
Personal/4. Journal/YYYY-MM-DD - Journal.md      journal, format in legacy/js/journal.js
Todo.md                                          the only task source (batch 3), read by views/tasks-index.js
```

Task format (Obsidian Tasks syntax) across all `*.md`:
`- [ ] text 📅 2026-09-10 🔁 every week ⏫ ✅ 2026-09-08` with due `📅`, scheduled `⏳`,
start `🛫`, done `✅`, created `➕`, priority `⏫🔼🔽`, recurrence `🔁`. Toggling a task writes
back to the exact source line (add/remove `✅ YYYY-MM-DD`).

## Keyboard map (shell owns, modules must not shadow)

Replaced wholesale in batch 12 (2026-09-10): see "Keyboard map, batch 12" below. The map is
Obsidian's; `Mod` is Ctrl on Windows and Linux and Cmd on macOS.

## Done means

Runs in the browser dev mode with no console errors, runs in the host exe, both themes,
keyboard reachable, and looks like DESIGN.md. Report what you built, what you could not, and
anything you added to shared files.

## Module entry points (what main.js and the shell import)

```js
// shell/index.js
export async function initShell(rootEl)            builds layout, titlebar, sidebar, statusbar, palette, settings
export function navigate(route, {replace}={})      route: {type:'page', path} | {type:'view', name}; pushes history, persists to state
export function back() / forward()
// editor/index.js
export async function initEditor()                 registers commands (page.new, page.save, page.rename, page.trash, page.reveal ...)
export async function openPage(el, path) / closePage() / saveNow() / getOpenPath()
// views/index.js
export async function initViews()                  registers views 'day' 'week' 'month' 'journal' and their commands
```

The shell mounts pages with `openPage(mainEl, path)` and views with `views.get(name).mount(mainEl)`.

## Additions (2026-09-06, after the first cut)

- `bridge.writeBinary(path, base64)` -> void. For image uploads from the editor; the file goes
  to `<folder of the page>/attachments/<name>` and the markdown gets a relative link.
- Window closing: the host posts `{event:'window', data:{closing:true}}` on the first close
  attempt, awaits what the handlers return (at least 400ms, at most 3000ms), then closes. A
  handler resolving `false` vetoes the close (batch 9). The editor returns its final save.
- `shell/dialog.js` exports `prompt({title, value?, placeholder?, ok?}) -> Promise<string|null>`
  and `confirm({title, body?, ok?, danger?}) -> Promise<boolean>`. Modules use these for any
  input; nobody calls window.prompt/alert/confirm.
- `shell/state.js` exports `patchState(partial) -> Promise<void>` (read, shallow merge, write,
  debounced) and `stateCache()` (last known state object). Modules persist through this, never
  through `bridge.setState` directly, so nobody overwrites another module's keys.
  Key namespaces: `route`, `window`, `sidebar`, `claude`, `editor`, `views`.
- Internal links: a link to a `.md` file, relative to the current page, navigates in-app
  (`navigate({type:'page', path})`), anything else goes to `bridge.openExternal`.
- Command ids in use (register exactly these so the palette, slash menu and keyboard agree):
  shell: `app.palette` `app.quickopen` `app.search` `app.settings` `app.theme` `app.sidebar`
  `app.back` `app.forward` · editor: `page.new` `page.save` `page.rename` `page.trash`
  `page.reveal` `page.duplicate` · views: `view.month` `view.week` `view.day` `view.journal`
  `journal.new` · claude: `claude.toggle` `claude.new` `claude.interrupt` `claude.stop`
  `claude.ask-page`.

## Claude Code protocol, verified live (2026-09-06)

- The process is silent until the first user line reaches stdin; `system/init` (with
  `session_id`) arrives about 50ms after the first `claudeSend`. Do not gate the composer on init.
- Event types seen in a real turn: `system/init`, `system/status`, `stream_event`, `assistant`,
  `user` (tool_result), `system/task_summary`, `system/post_turn_summary`, `rate_limit_event`,
  `result`, `control_response`. Ignore unknown types, never error on them.
- `assistant` messages carry `content` blocks of type `text` or `tool_use` ({id, name, input});
  `user` messages carry `tool_result` blocks ({tool_use_id, content, is_error?}) and often a
  `tool_use_result` object beside the message.
- `result` carries `subtype`, `is_error`, `duration_ms`, `total_cost_usd`, `num_turns`,
  `session_id`, `permission_denials`.
- After `claudeStop` the exit code is 1 (forced kill). Treat a stop-initiated exit as normal.
- The dev bridge sends a transport-only `{event:'bridge'}` hello on SSE connect; the HTTP adapter
  swallows it. The host does not send it.
- The host must kill the whole process tree on stop and on window close.

## Batch 2 (2026-09-06, after the first night of use): decisions

Structure of the sidebar, top to bottom: **agent** (one row, opens the Agent view), **views**
(month, week, day, journal, in that order), **pages** (the tree). Habits and Tasks are no
longer views; their content moved into Month and Day. No startup route: the app opens with the
sidebar and an empty main surface (page background, nothing drawn), the user picks.

**Agent view.** `claude/` registers a view named `agent` (title "Agent"). Its mount moves the
one long-lived pane element into the main column at full width (page column rules do not
apply: the transcript uses the main width with the same 48px side padding and a max width of
900px, centred). A small toggle in the pane header ("dock") sets store `claude.mode` to
`'dock'`: the shell then shows the pane in the right side panel beside the current page and the
Agent row in the sidebar navigates back to the last page. `claude.mode = 'view'` (default)
means the side panel is never shown and the Agent row navigates to the view. Ctrl+J: in view
mode navigates to the Agent view (or back to the previous route if already there); in dock
mode toggles the side panel. Removed from the pane: the "ask" permission mode, the page-folder
persona switch. cwd is always the vault root (`''`).

**Data model.** The Habits folder is retired. Each monthly plan
`Personal/3. Action/<year>/<YYYY-MM> Monthly Plan.md` has three H1 sections: the plan title H1
(goals under label lines, as before), `# Systems` (one bullet per system with the day spec in
parentheses, same syntax as the old Habits.md), `# Monthly Review` (Hassan's text, never
written by the app). The check log is one append-only file for all months:
`Personal/3. Action/systems-log.jsonl`, lines `{date, system, done, at}`; old lines use the key
`habit` instead of `system` and must be read as equivalent. Latest line per (date, system)
wins. A month whose plan has no Systems section shows, in the matrix, the systems that appear
in the log for that month.

**Month view.** Title "<Month YYYY>", previous/next month. Sections: goals (as now), then the
systems activity matrix for the month (GitHub-contributions style: rows = systems, columns =
days, filled cells for done, blank for applicable-not-done, dimmed for not applicable or
future), then the computed numbers in mono: per system, done / applicable-to-date and the
current streak; overall completion rate to date. Then the Monthly Review text rendered
read-only (plain paragraphs). No check-ins here; cells are not clickable.

**Week view.** As now, minus Q1/Q2 (the file no longer has them; the parser ignores them if
they reappear). Spacing and readability pass: hour labels, block text truncation, today
column, now marker, totals. No toggle.

**Day view.** Title "<Weekday D Month>", previous/next day, "today" button. Two columns on
wide windows, stacked below 900px of main width. Left: the day's timeline from the same
timetable parser and event data as Week, vertical, 07:00 to 23:30, now marker when today.
Right: **systems** for that day as `.check` rows (toggling appends to the log, latest wins,
optimistic UI), then **tasks**: overdue, due that day, then undated tasks grouped by top-level
folder, each with its source path, toggling writes back to the exact line as before. The tasks
index code moves out of the retired Tasks view into `views/tasks-index.js` and is reused.

**Journal view.** Write-once by layout, not by permission. Top: the date as the title, weekday
and current time in mono under it, then the gap line `last written N days ago` (or `written
today`). Then the writing box: full column width, bordered field, mono placeholder, one primary
"Save" button right-aligned. Save writes the file exactly as before (new day: H1 then text; same
day: append after `---`), empties the box, and the text appears at the top of the record. Then
the record: every entry, latest first, one continuous column: date in the left margin in mono,
text in the body font, a 1px rule between days, a year marker where the year changes. No edit
controls; "open as page" appears on hover over a date, mono, small. No preview pane, no
separate list. Same typography and tokens as everywhere else; only the layout differs.

**Editor.** The block handle (plus and drag dots in the gutter) is removed; the slash menu
stays. `page.duplicate` is removed. Spellcheck: the editor sets `spellcheck="true"` and a `lang`
per document (auto), and the host enables Chromium spell checking for French and English if
WebView2 allows it; if it cannot be made to work, say so in the report and leave the attribute.

**Shell.** Sorting: files and folders together, natural numeric order, case-insensitive
(`0. Index` folder and `00-index.md` sort by their numbers, before letters); `_Archive` still
last. Settings dialog: Ctrl+comma toggles (closes when open); rows are theme, body text, and the
read-only vault/bridge/claude block; the sidebar, Claude width and open-at-start rows are gone.
Status bar right side always shows `ctrl+, settings` before the theme name. Page column: on a
main area wider than 1400px the column max grows to 800px and side padding scales
(`max(48px, 6vw)`), so a maximised 1920 window does not look hugged to the sidebar. The
titlebar breadcrumb for the Agent view reads `agent`.

**Spellcheck outcome (batch 2).** WebView2 uses the Windows display language's dictionary
only (fr-FR on this machine) and ignores per-element `lang` (WebView2Feedback #5294); no API,
flag or preference adds a second language. The editor therefore enables spellcheck only when
the detected document language equals the checker's language: French pages are checked,
English pages are not underlined at all.

## Batch 3 (2026-09-06, evening): decisions

**Sidebar order:** `pinned` (section hidden while the list is empty), `agent` (one row named
"Claude", view title "Claude", view name stays `agent`), `views` (month, week, day, journal),
`scratch` (the files of `Scratchpad/` listed flat, folder hidden from pages), `pages`. The search
box is removed from the sidebar.

**Pins.** State key `pins: [paths]` in `App/state.json`, written through `patchState`. Right-click
menu on any tree row: `pin` / `unpin`. A pinned page opens; a pinned folder expands the tree to it
and scrolls it into view. Pin order is display order; no drag.

**Move to.** Right-click menu on any file (tree, scratch, pins): `move to…` opens a folder picker
(a `.surface` list of vault folders, fuzzy-filterable, Enter confirms) and calls `bridge.rename`.
The open page follows its file if it was the one moved.

**Search overlay.** Ctrl+F opens a centred `.surface` (same geometry as the palette) with an input;
`bridge.search` runs debounced 150ms as you type; results are rows grouped by file with the
matching line in mono; arrows move, Enter navigates to the page, Esc closes. Command id
`app.search` keeps its name; the keymap moves it from Ctrl+Shift+F to Ctrl+F. Ctrl+P and Ctrl+K
unchanged.

**Tree rows.** One grid for every row: 16px chevron slot (chevron for folders, empty for pages),
14px glyph (`folder` or `page` from icons.js), name. Indent per depth is the same for both
kinds. Folder names in `--fg`, page names in `--fg-2`. View icons are distinct: month = a 3x3
grid, week = seven vertical bars, day = one square with a dot. Icons are 14px in the sidebar.

**Scrollbars.** `scrollbar-width` is removed from base.css (Chromium ignores the WebKit rules
when it is set); WebKit rules give 12px wide bars, square thumb `--border-strong`, no buttons,
track `--bg-2` inside panels and transparent elsewhere.

**Tasks.** The Day view's tasks come from `Todo.md` at the vault root only. The index reads one
file. Sections stay: overdue, due that day, no date (no folder grouping needed any more).

**Journal.** The writing box grows with its content without a maximum; no inner scrollbar. A
mono toggle above the record, `full` / `compact`, remembered under `views.journal.mode`.
Compact renders one 28px row per entry: date, weekday, first line ellipsised; clicking a row
expands that single entry in place; year markers stay in both modes.

**Editor slash menu.** Trigger: a `/` typed at the start of a block or immediately after a space
anywhere in a text block. Selecting a text item (Text, Heading 1, Heading 2, Quote, Bullet
list, Ordered list, Task list) converts the current block; the `/` and the typed filter are
removed first. Block items (Divider, Image, Code, Table) insert after the current block when the
block has content, replace it when empty. Filter: fuzzy subsequence over label and aliases,
aliases: h1 heading1 title; h2 heading2; p text paragraph; quote blockquote; hr divider rule
line; ul bullet list; ol numbered ordered; todo task check checkbox; img image picture; code
pre; table; date today. Menu contents, in this order and nothing else: Text, Heading 1,
Heading 2, Quote, Divider, Bullet list, Ordered list, Task list, Image, Code, Table, Date;
then the page group Rename, Move to trash, Reveal in Explorer; then Month, Week, Day, Journal,
New journal entry, Ask Claude about this page. Removed: H3 to H6, Math, Save page, Toggle agent,
New Claude session (those commands still exist for the palette and keys, they are only out of
the slash menu).

**Claude view.** Header: `Claude`, the status chip, one `…` button opening a `.surface` menu:
new session, sessions (each row: title, relative time, `rename` on hover), model (`opus`
default, `sonnet`, `default`), permission mode (edits, full access, plan), dock/full. Model and
permission are persisted under `claude.model` / `claude.permissionMode` and passed to
`bridge.claudeStart({model})` (`default` means no `--model` flag). Cost is never shown; the
result footer is `done · 12.4s` (`stopped · 4.5s` after an interrupt). Tool calls of one
assistant turn fold into one row `working · N tools` (mono, spinner glyph while running, count
when done) that expands to the tool rows; expanded while running, collapsed once the final
text of the turn arrives; the answer text is always visible. Session rename: prompt dialog,
title stored in `claude.sessions[].title`.

**Resume history.** New bridge command `claudeTranscript(sessionId) -> [line objects]`: the host
and the dev bridge read `%USERPROFILE%\.claude\projects\<encoded cwd>\<sessionId>.jsonl`, where
the encoded cwd is the absolute vault path with every character that is not a letter or digit
replaced by `-` (`D:\os` -> `D--os`), parse each line as JSON, and return the `user` and
`assistant` entries in order (skip `queue-operation`, `summary`, progress and other types). On
resume the view renders that history (user text, assistant text, tool rows folded) with a mono
divider `resumed · <date>` before the new turn. Missing file -> empty history, no error.

**CLI slash commands.** Typing `/compact`, `/clear` or another CLI command as a message is
passed through unchanged; whether the CLI honours it in print mode is tested and reported, not
assumed.

**Host.** When maximised, WM_NCCALCSIZE insets the client rect by the frame width
(SM_CXFRAME + SM_CXPADDEDBORDER, SM_CYFRAME + SM_CXPADDEDBORDER) so nothing is off-screen.
`claudeTranscript` is added to the RPC table. `claudeStart` accepts `model` (already did).

## Batch 4 (2026-09-06, night): decisions

**Sources.** `src/lib/sources.js` (owned by the shell agent, read by everyone):
`getSource(key)` -> vault-relative path, `setSource(key, path)`, `SOURCE_DEFAULTS`,
`bus.emit('sources', {key, path})` on change. Keys and defaults:
`timetable: 'Learning/School/0-index/Timetable.md'`, `plans: 'Personal/3. Action'` (the folder
holding `<year>/<YYYY-MM> Monthly Plan.md`), `systemsLog: 'Personal/3. Action/systems-log.jsonl'`,
`todo: 'Personal/1. Life/Todo.md'`. Persisted under state `sources` through `patchState`;
loaded at shell init before views mount. Settings gets a `sources` block: one row per key, the
current path in mono, a `choose…` button opening `pickFile({title, ext})` (new in dialog.js:
same surface as pickFolder, lists files, fuzzy filter; `ext` limits to `.md` or `.jsonl`;
`plans` uses pickFolder). Views re-read on the `sources` event. A missing source renders the
view's empty state with the path and the words `set it in settings (ctrl+,)`.

**Sidebar.** Section order: pinned, agent, views, pages, scratch (scratch last). Right-click on
the empty space under the tree: `new page`, `new folder`, created in `Scratchpad/` (or in the
focus folder when focused). Internal drag and drop: any file or folder row can be dragged onto
a folder row (or onto the scratch section label, meaning `Scratchpad/`, or the pages label,
meaning the root); drop calls `bridge.rename`; a folder cannot be dropped into itself or its
descendants; the target row highlights with `--accent-soft` while hovered; pins and the open
page follow the move. External drop: files dragged from Explorer onto a folder row are written
there with `bridge.writeBinary` (name kept, numbered on collision); `.md` and `.txt` go through
`writeText`; the tree refreshes from the fs event; a mono toast reports `imported 3 files`.

**Focus mode.** Right-click a folder: `focus`. State key `focus` (path or null), persisted.
When set: the pages section shows only that folder's subtree, rooted, with a mono header row
`focus · Learning/School/3-philosophie` and an `exit` control; pinned and scratch sections are
hidden; `page.new`, empty-space right-click and the tree's new page/folder create inside the
focus folder; Ctrl+F results and Ctrl+P candidates are limited to paths under the focus folder
(the shell filters the bridge results client-side); the titlebar breadcrumb starts at the focus
folder. `claude/` reads store `focus` and uses it as the session cwd (so that folder's
CLAUDE.md applies); a running session keeps its cwd until the next new session, and the header
menu shows `folder · <focus>` when set. Esc does not exit focus; only the control or the
command `app.focus-exit` (palette) does.

**Conventions document.** `Personal/3. Action/CLAUDE.md` describes the monthly plan schema,
the systems log, and where the timetable and todo formats are documented. Written by the
orchestrator; the views agent keeps the parsers matching it.

**Batch 4 additions as built.** `lib/sources.js` also exports `SOURCE_INFO`, `SOURCE_KEYS`,
`allSources()`, `isDefaultSource(key)`; only non-default keys are persisted. Focus lives in
`shell/focus.js` (`getFocus`, `setFocus`, `exitFocus`, `isUnderFocus`, `defaultNewFolder`),
re-exported from `shell/index.js`; bus event `focus` (path or null); command `app.focus-exit`.
The editor's `page.new` uses `defaultNewFolder()`, then the open page's folder, then
`Scratchpad/`. Claude's cwd is the focus folder when set. Dropping a folder from Explorer is not
supported (files only). The January to June 2026 plans were brought to the schema by renaming
or inserting the `# Monthly Review` heading only; no wording changed.

## Batch 5 (2026-09-06, night): decisions

**Six explicit sources.** `lib/sources.js` keys, defaults (the vault's current layout) and the
one-sentence description each row shows in settings:

```
timetable   2-learning/1-school/0-index/Timetable.md
            "A markdown file with one H1 per weekday (Lundi … Dimanche) and one line per block:
             - 08h20 à 09h15 Maths · salle 333 [maths]."
plans       1-personal/3-execution
            "A folder with one subfolder per year, holding one file per month named YYYY-MM.md
             (anything after the date is ignored) with the sections Goals, # Systems, # Monthly Review."
systemsLog  1-personal/3-execution/systems.jsonl
            "An append-only JSON-lines file; the app adds one line per system check and never edits it."
todo        0-tasks
            "A folder (every markdown file in it is one task list) or a single markdown file, with
             - [ ] items and optional 📅 due dates."
journal     1-personal/4-journal
            "A folder of one file per day named YYYY-MM-DD.md (anything after the date is ignored);
             the app appends, never edits."
scratch     7-scratchpad
            "The folder shown as the scratch section; new pages land here unless a folder is focused."
```

Each settings row: name, the sentence in `--fg-3`, the current path in mono, `missing` in `--err`
when the path does not exist, `choose…` (pickFile for files, pickFolder for folders; `todo`
offers both), `reset` when off the default. `SOURCE_INFO[key] = {label, kind: 'file'|'folder'|'either', ext, sentence}`.
Everything that used to be hard-coded (`Scratchpad`, the journal folder, the plan and journal
file names) reads a source. The shell's scratch section, empty-space menu and `page.new`
fallback use `getSource('scratch')`.

**Tolerant names.** A monthly plan is any `YYYY-MM*.md` inside `<plans>/<year>/`; the app
creates nothing there. A journal entry is any `YYYY-MM-DD*.md` inside the journal folder; a
new entry is written as `YYYY-MM-DD.md` with the H1 `# YYYY-MM-DD - Journal` as before. The
date always comes from the file name.

**Todo as a folder.** When the todo source is a folder, every `*.md` directly in it is a list.
The Day view groups tasks by file, in natural file order, each group labelled with the file's
first H1 (or its name), each group holding overdue, due that day, undated. Write-back goes to
the file the task came from. A single-file source behaves as one group without a label.

**Copy path, copy link.** Right-click on any file or folder: `copy path` puts the vault-relative
path on the clipboard; `copy link` puts `[<name without .md>](<path with spaces as %20>)`.
`navigator.clipboard.writeText`, with a toast `copied`.

**Link a page.** Slash item `Link` (aliases: link, page, ref) opens `pickPage({title})`
(new in shell/dialog.js: the quick-open list, fuzzy, Enter) and inserts a markdown link whose
text is the page's title (first H1, else the file name) and whose URL is the path relative to
the current page's folder, `%20`-encoded. Palette command `page.link` does the same.

**Block keys (editor).** Esc inside a block selects the whole block (NodeSelection, highlighted
with `--accent-soft` and a 2px `--accent` left bar). Backspace or Delete on a selected block
removes it. Shift+Up / Shift+Down extends the selection to the previous or next block. Esc
again or a click returns to text. Ctrl+Shift+Backspace deletes the current block without
selecting. Ctrl+Shift+Up / Ctrl+Shift+Down moves the current block (or the selection) up or
down. None of these fire inside code blocks (CodeMirror keeps its keys) or when a menu is open.

**Thinking.** Empty thinking blocks are not rendered at all. Non-empty thinking folds into the
turn's `working` row as a `thinking` entry (collapsed by default, mono, `--fg-3`), never as its
own row.

**Schema document.** The conventions doc moves with the vault: `<plans>/CLAUDE.md`
(`1-personal/3-execution/CLAUDE.md`), updated to the new names.

## Batch 6 (2026-09-07): the Claude view is a real terminal

The stream-json viewer is replaced by a pseudo-terminal running the Claude Code CLI
interactively. The bridge gains a PTY surface; the `claude*` commands and events are removed
from the host, the adapters and the dev bridge (keep `claudeInfo` for the empty state and the
settings block).

```
bridge.ptyStart({ cwd, cols, rows, cmd?, args?, env? })  -> { id }
      cwd vault-relative ('' = root); cmd defaults to the claude binary (platform::find_claude),
      args default to [] (interactive), env is a map merged over the inherited environment.
bridge.ptyWrite(id, data)      data: string (UTF-8) written to the pty input
bridge.ptyResize(id, cols, rows)
bridge.ptyKill(id)
bridge.on('pty', ({ id, data }) => {})      data: base64 of raw output bytes (chunks as they arrive)
bridge.on('pty', ({ id, exit: code }) => {})
```

Host (Rust, `src-tauri/src/pty.rs`, crate `portable-pty`): one native pty per id (ConPTY on
Windows, forkpty on unix), `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG` inherited or
`en_US.UTF-8`; a reader thread emits `pty` events with base64 chunks (coalesce to at most one
event per 8ms); resize through the pty master; kill = terminate the child and drop the master;
all ptys killed on app exit. Dev bridge (`dev/bridge-plugin.mjs`): the same through
`@homebridge/node-pty-prebuilt-multiarch` as an optional dependency; if it fails to load, the
commands reject with `pty unavailable in the dev bridge` and the view shows that.

Web (`src/claude/`): xterm.js (`@xterm/xterm`, `@xterm/addon-fit`) fills the view under a
`.panel-head` with `Claude`, a status chip (`off` / `running` / `exited`), `new session`,
`dock`/`full`, and in dock mode `close`. Theme from tokens: background `--bg`, foreground
`--fg`, cursor `--accent`, selection `--sel`, the sixteen ANSI colours mapped to the palette
(black/white from `--bg`/`--fg` family, red `--err`, green `--ok`, yellow `--warn`, blue
`--info`, magenta `--c-hum`, cyan `--info`, bright variants lighter), font `--font-mono` 13px,
line height 1.3, no bell, scrollback 5000, `cursorBlink` false. Re-themed on the `theme` event.
The terminal fits its container (fit addon + ResizeObserver, debounced 60ms, then
`ptyResize`). The session starts lazily on first mount of the view or dock with
`cwd = store.get('focus') || ''`; `new session` kills and restarts; an exited process shows
the chip `exited` and a mono line `press Enter or click new session`. `claude.ask-page`
writes `About the page \`<path>\`: ` into the pty (no newline) and focuses the terminal.

Keys: while the terminal has focus every key goes to the pty except Ctrl+K, Ctrl+P, Ctrl+F,
Ctrl+comma and Ctrl+Shift+L, which the shell keeps (xterm `attachCustomKeyEventHandler`
returns false for them); Ctrl+J is the CLI's newline in the terminal and does not toggle the
view while it is focused. Ctrl+V pastes, Ctrl+Shift+C copies the selection (plain Ctrl+C is
the CLI's interrupt).

Links: a custom xterm link provider matches vault-relative paths ending in `.md` (with or
without a line suffix) in the output; hovering underlines, Ctrl+click navigates to the page.

Removed: session.js, render.js, composer.js, protocol.js, the header menu, fixtures, the
harness, `claudeTranscript`, the `claude` sessions/model/permission state (the CLI owns all of
it now). Settings keep the read-only "claude" line (path and version).

Self-test: `ptyStart` with `cmd` = `cmd.exe` `/c echo ptyok` on Windows, `/bin/sh -c 'echo ptyok'`
elsewhere, expecting a `pty` data chunk containing `ptyok` and an exit event; then `claudeInfo`
as before (skip when absent). CI unchanged otherwise.

## Batch 7 (2026-09-07): sessions live in the vault

When `ptyStart` runs the Claude CLI (no explicit `cmd`), the host and the dev bridge set
`CLAUDE_CONFIG_DIR=<vault>/.claude` and `CLAUDE_CODE_PROJECT_DIR_NAME=vault` before the
caller's `env`. Consequence: Claude Code's user settings, plugins, trust decisions and session
transcripts for this vault live in `<vault>/.claude/`, and sessions from every machine that
opens the vault share `<vault>/.claude/projects/vault/`, so `/resume` shows the same list on
Windows and macOS. Windows stores the login token file there too (`.claude/.credentials.json`);
macOS keeps it in the Keychain. The first run on each machine asks for `/login` once. Sessions
started from a plain terminal outside the app keep using `~/.claude` unless the same two
variables are exported in the shell.

Before starting the CLI, the host and the dev bridge remove every inherited environment
variable whose name starts with `CLAUDE` (the app may have been launched from a Claude Code
session, whose child-session marker disables transcript saving), then set the two above.

## Batch 8 (2026-09-08): the app is an editor

Decision, after two days of use: the integrated Claude pane is removed, and nothing replaces
it. A terminal inside a web view is strictly worse than a real terminal, and Claude Code is
run on the vault from outside, where it belongs. Batches 6 and 7 above are history; every
interface they introduced is gone:

- `src/claude/` is deleted. There is no `initClaude`, no `mountClaudePane`, no Agent view,
  no `claude.*` command, no `claude` palette group, no `claude` status slot.
- The bridge has no `claudeInfo` and no `pty*` commands. The host has no `pty.rs`, no
  `portable-pty`, no Claude binary lookup. The dev bridge has no `node-pty`.
- The shell body is the sidebar and the page column. `--claude-w/min/max` are gone; the only
  resizer is the sidebar's. `settings.claudeWidth` and `claude.open/mode` are not read.
- Ctrl+J is unbound and free.
- `CLAUDE.md` in the vault remains what makes the vault agent-readable: it is the whole AI
  integration, and it costs nothing.

What the app is, restated: a markdown viewer and editor that parses certain files and builds a
GUI from them, while leaving the prose ordinary so an agent can read and edit it too. For that
to hold, the editor must carry everything a standard markdown editor carries; the batches
after this one are that work.

## Batch 9 (2026-09-08): the editor stops losing work, and the app runs from the keyboard

Implemented from the reviewed plan the same day the pane was removed (batch 8). Three modules
changed in parallel under strict file ownership; the interfaces they added are recorded here.

### Editor

**Conflicts (B1).** Before every write the editor reads the file back and compares it to
`baseline`, the text the page was opened from or last wrote. If it differs the user chooses:
`Cancel` (nothing written; autosave holds until an explicit save — Ctrl+S, leaving the page,
closing the window — asks again; status `unsaved · changed on disk`), `Reload from disk`
(buffer dropped, page reopened in place) or `Keep mine` (overwrite). An external change to a
dirty page toasts once per distinct disk text; a clean page still reloads silently. The editor
builds the three-way dialog on the shell's `openOverlay` with the `.dlg` classes
(`editor/deps.js choose({title, body?, options:[{label, value, kind?}], cancel?})`).

**Gone or moved files (C18).** `fs` `rename` with `to` re-routes the open page to `to`
(navigate replace; a dirty buffer is flushed to the new path first). `delete`, a rename the
watcher could not pair, or a read-back that fails on a path that no longer exists, turns the
page read-only: no write ever recreates a deleted file from a stale buffer. `create`/`modify`
on the same path lifts it. The dev bridge cannot pair renames (Node `fs.watch`), so in the
browser an external rename shows as delete → read-only; the host pairs them.

**Closing (B2).** `bridge.on` handlers' return values are collected. On `window {closing:true}`
the Tauri adapter awaits the returned promises (`Promise.allSettled`), waits at least 400ms and
at most 3000ms, then destroys the window. A handler that resolves `false` vetoes the close (the
editor does this when the last save needs an answer; the dialog is on screen and closing
again retries). `saveNow(opts)` returns `false` in that case; `opts.explicit` lifts a hold,
`opts.closing` refuses to await a dialog. Any `closing` subscriber may return a promise.

**Dev bridge (B8).** `rename` refuses when the target exists (`already exists: <to>`), like the host.

**Commands added.** `page.duplicate` "Duplicate page" (copy of the saved file to `Name 2.md`
beside it, then open it), `page.copy-markdown` "Copy as markdown" (the exact text a save would
write, toast `copied`), `page.print` "Print page" (`window.print()`, light palette for the
dialog, `@media print` hides the chrome). File export is deliberately absent (needs a native
save dialog, a new Tauri plugin).

**Slash menu.** Heading 3 to Heading 6 follow Heading 2 (aliases h3…h6); `Duplicate` follows
`Rename` in the page group. Everything else as batch 3.

**Markdown.** `~~text~~` is strikethrough (typing rule and toolbar); a single `~` is never one.
GFM footnotes `[^1]` / `[^1]: text` render and round-trip. Obsidian callouts `> [!word] …`
render as a box with the marker in mono; the text is not rewritten. Heading sizes are ratios of
`--fs-body`. The properties strip edits a plain `key: value` frontmatter line in place; anything
multi-line, duplicated or block-scalar stays read-only; the block is never parsed as YAML.

**Title names the file (C12).** While a file is still `Untitled*.md`, leaving an edited title
renames the file to the sanitised title (toast `warn` when taken). Files with a real name are
only renamed by `page.rename`. A link to a missing `.md` page navigates to it and the router's
"page not found · Create it" screen takes over (C8). Pasting a single URL over a non-empty
selection wraps the selection in a link (C10).

### Shell

**Focus lands (B3).** `router.js focusMain()` runs after every mount: `.ProseMirror`, then the
title, then `.view-root`, then the start surface. `navigate(route, {replace, force, focus})`
and `clearRoute({focus})`: `focus:false` leaves keyboard focus where it is (boot, trash from
the tree). The sidebar keeps the focused row across its own rebuilds (B4), including the one
autosave triggers; `dialog.js focusOrigin()` / `retargetFocusOrigin(el)` let a rebuild under an
open dialog retarget where the dialog hands focus back.

**Keyboard map additions.**

```
Ctrl+Shift+E  focus sidebar (opens it if closed)      Esc (in the tree)  focus page
In the tree: Up/Down move, Right expand or first child, Left collapse or parent, Home/End,
Enter open (page) / toggle (folder), Space toggle folder, F2 rename, Delete move to trash,
letters type-ahead (700ms). Esc with no overlay also dismisses the newest toast.
In a context menu: Up/Down wrap, Home/End, first letter jumps, Enter/Space run, Esc closes.
On the sidebar resizer (a focusable separator): Left/Right 8px, Shift+Left/Right 32px,
Home/End min/max, Enter reset.
```

**Commands.**

```
groups: 'navigate' | 'page' | 'format' | 'block' | 'table' | 'editor' | 'image' | 'tree'
      | 'view' | 'app'   (that order; shell/palette.js GROUP_ORDER is the list)
commands.register({ id, title, group, hint?, shortcut?, icon?, when?, run(...args) })
  icon: a name from shell/icons.js; the sidebar's context menu draws it.
  commands.run(id, ...args) passes args to run; tree.* take an optional {path, kind} target.
app.focus-sidebar  Focus sidebar   Ctrl+Shift+E     app.focus-page  Focus page (no chord)
app.focus-enter    Focus folder (target must be a folder not already the focus)
tree.new-page  tree.new-folder  tree.pin  tree.unpin  tree.rename  tree.move
tree.copy-path  tree.copy-link  tree.reveal  tree.trash
  target = the focused tree row (the one focus returns to when a palette/menu closes),
  else the open page; `when` is false with no target. The sidebar context menu is built
  from these commands (title, icon, shortcutFor) and cannot drift from the palette.
```

A mapped chord whose command's `when` is false says so in a toast (D5); chords typed inside a
dialog input that are not overlay-safe fall through to the input. The tree has one tab stop
(roving tabindex). Window buttons are in the tab order in the host. Toasts are `role=status`,
pause on hover, and Esc dismisses the newest. The empty surface shows `recent` (the last eight
existing pages) and the three chords — still no startup route (D7). Scroll position is
remembered per route, 50 entries (C16). A source whose `stat` throws shows as missing with the
error (B5).

### Views

```
Period navigation (day, month; any future view with a cursor):
  ‹ today › group from views/common.js navHtml(); keys ArrowLeft / ArrowRight / t bound on
  the view root by bindNav(); ignored with any modifier or when focus is in a text field;
  the hint "← → · t" is printed beside the buttons in mono --fg-3. Torn down in unmount.
Focus: every view root has tabindex="-1" and is focused on mount, before its reads.
Path links in .page-meta are <button class="v-link">, in the tab order, focus ring --focus.
Loading: a region filled asynchronously shows one `.empty` line "loading…" only if its reads
  outlast 150 ms (lib/loading.js loadingLine, re-exported by views/common.js); a faster load
  keeps the previous content until the new render replaces it. Empty, missing-source,
  read-error and loading messages all use `.empty`; the only padding override is
  `.dy-box .empty { padding: var(--sp-4) }`.
Errors: a source that exists but cannot be read prints "could not read <path>: <error>"
  and logs console.error; a missing one prints "no <kind> at <path> · set it in settings".
Task rows navigate with { type:'page', path, line } (1-based line).
```

### Visual system

`tokens.css` carries a spacing scale (`--sp-half` 2, `--sp-1` 4 … `--sp-7` 48), `--barhead-h`
(44px, the palette's input row and a dialog's foot), `--tree-inset` (48px, where a depth-0
row's name starts) and `--fs-content` (15px). DESIGN.md: a bare pixel value in a module
stylesheet is a bug; boxes, not rules. The day column is one box component (`.dy-box`,
`.dy-box-head`); `.label` and `.section-label` are one component with and without the
horizontal inset; the week and day event blocks are one rule set.

### Editor, second phase (C1 C2 C7 C13)

```
openPage(el, path, opts?)   opts.line: 1-based line of the file (as the search overlay counts
                            them). After mount the caret goes to the block holding that line
                            and it is scrolled near the top. A line above the body scrolls to
                            the top; the title's line puts the caret in the title. The router
                            asks the editor to scroll in place when the page is already open.
scrollToLine(line) -> bool  the same jump on the open page; false when no page is open.

Line mapping is a heuristic: each top-level block is serialised alone (the save path) and its
first line matched against the file's body (stringify.js lineKey); lists, quotes and tables
refine to the item/row. A block that cannot be matched claims no lines: the caret lands on
the block before it — early, never late.

Commands (group 'page', when: a page is open):
  page.find      Ctrl+F. "Find in page". A sticky bar at the top of the page column: one mono
                 field, an `n / m` count. Case-insensitive substring over the body (not the
                 title). Every hit is a `find-hit` decoration, the current one `find-hit
                 current`; the selection is a caret at the current hit. Enter next,
                 Shift+Enter previous, Escape closes and leaves the caret on the hit. Hits
                 inside code blocks are counted and reachable but painted by CodeMirror.
                 Nothing is written; the bar does not count as touching the page.
  page.outline   Ctrl+Shift+O. "Go to heading". A `.pal.pick` picker of the H1 title then
                 every body heading indented by level, fuzzy-filtered like Ctrl+P; the
                 heading under the caret is preselected. Enter/click scrolls it to the top
                 and puts the caret at its start. No sidebar panel.
The vault search is Ctrl+Shift+F only.

Rename (page.rename and the C12 title rename) then calls lib/links.js
rewriteInbound(oldPath, newPath) and toasts "renamed · N links in M pages updated" when N > 0.
resolveHref decodes with decodeURIComponent, matching relativeHref's encodeURIComponent.
```

### Routes, links, selection (shell second phase)

- Route: `{type:'page', path, line?}` — `line` is a 1-based line, kept by `normalize` only when
  a positive integer, not part of `routeKey`; navigating to the open page with a `line`
  scrolls it in place without a history entry.
- Loading: a region that outlasts `LOADING_DELAY` (150 ms) shows one `.empty` "loading…"
  (`lib/loading.js`); the router lays it over the page column while a page mounts.
- Links: every move in the tree (rename, move-to, drag), file or folder, rewrites confirmed
  `](href)` links into what moved (`lib/links.js`); only href bytes change; the result is
  toasted, never confirmed beforehand.
- Selection: Ctrl+click, Shift+click and Shift+Up/Down select tree rows; with two or more,
  `tree.pin/unpin/move/trash` and drag act on all; Esc clears before leaving the tree.

## Batch 10 (2026-09-09): Obsidian is the reference

Restated by the owner: the app is "Obsidian plus custom GUIs from files". Any folder is a
vault; no marker file is required; per-vault state lives in `.ose/` the way Obsidian's lives
in `.obsidian/`. Behaviour questions (a key, a drop, a rename) default to what Obsidian does.
There will never be a plugin system: a new GUI is a new view. The app stays a portable
executable that normally lives inside its vault.

### Vault resolution

A vault is any folder. The host looks for one in this order, and the first hit wins:

1. `--root <dir>`, if it is a directory.
2. The executable's own folder, then each ancestor, for a folder holding `.ose/` (our state
   folder) or `CLAUDE.md`; a folder that also holds `src-tauri` is the source repo and never
   counts. On macOS the walk climbs out of `os.app/Contents/MacOS`.
3. `OSE_ROOT`, if it is a directory.
4. The remembered root: one line in `<app config dir>/vault` (per user, outside every vault),
   ignored when it no longer names a directory.
5. Nothing. The host starts anyway and `rootInfo()` answers `{root: null, name: null}`; the UI
   mounts the choose-vault surface (shell/vault.js) instead of the shell, and the page
   reloads once a folder is chosen. `--selftest` is the one start that still refuses
   without a root.

```
bridge.rootInfo()     -> {root, name}                  both null while no vault is open
bridge.vaultInfo()    -> {root, name, remembered, source}
                         source: 'arg'|'exe'|'env'|'remembered'|'picked'|null ('dev' in the
                         browser); remembered: a remembered-root file exists on this machine
bridge.pickVault()    -> {root, name} | null            native folder picker, opened in the
                         executable's folder; a choice is validated, remembered, watched, and
                         becomes the root at once (the vault protocol follows)
bridge.forgetVault()  -> null                          deletes the remembered-root file;
                         nothing to delete is not an error
bridge.platformInfo() -> {os, version, exe, exeDir, root}   exeDir: the chooser's suggestion
```

Commands needing a vault reject with `no vault is open` while there is none.
Command `app.vault-change` "Change vault…" (group app, hint: the current root) — settings'
info block and the palette; saves the page, flushes state, reloads into the new root.
Dev: `?novault=1` on the page URL makes the dev bridge answer as a host with no vault.

### Drop onto the page (editor/drop.js)

- Files from outside: every non-image is copied to `<page folder>/attachments/<yyyy-mm-dd>-<slug>.<ext>`
  (numbered -2, -3… when taken; the name an image gets) and linked as `[original name](relative href)`.
  Images alone go to Milkdown's uploader (an image block); mixed drops are handled together.
- Rows from the sidebar (`application/x-os-path`, a JSON list): a page links by its title
  (first H1, else the stem), a folder as `[name](relative/)`, any other vault file by its name.
  Nothing is copied. The `text/plain` fallback is never inserted.
- Placement: one link dropped in a paragraph goes inline at the pointer; further items, and
  anything dropped on a code block, an image, between blocks, or on the title, become one
  paragraph per item after the block at the drop point (the title: top of the body).
- Links are the link mark the Link command writes, hrefs through `relativeHref`, so
  lib/links.js follows them on rename. One toast per file that could not be copied.
- A read-only page takes no drops. Text drags are ProseMirror's own.

### Month view (replaces the earlier paragraph)

Title "<Month YYYY>", previous/next month. Three sections, each a bare `.label` (`goals`,
`systems`, `review`) with nothing to its right and everything underneath. Goals as before.
Systems: the activity matrix across the full page column — a fixed name column (ellipsis), one
square per day sharing the rest, the day-number header with the `today` mark. Cell states:
`on` = due and checked (accent), `skip` = due and missed (ring), `off` = not due, before the
system's first logged day (its floor), or still to come (`--bg-3`); today unchecked draws as
`skip` but counts as open. Each row ends in a loss column: `−N%` in `--err` mono, N = days due
and missed so far ÷ all days the system is due in the whole month, empty when nothing is lost;
hover gives `D done · L lost · O open`. Under the grid one line, mono `--fg-3`, right-aligned
under the loss column: `D% done · L% lost · O% open`, pooled over every system with the month
as the only denominator; `done` and `lost` round on their own and `open` takes the drift (when
nothing is open, `lost` does), so the line always sums to 100. A day before a system's floor
counts as neither done, lost nor open, so a system added on the 10th has a 21-day month. No
systems → no line. Review: the file's prose under `# Monthly Review` or `# Review`, read-only,
`not written yet` when absent. No per-system counts, no streaks, no overall rate. Cells are not
clickable. Nothing is ever written to a plan file.

## Batch 11 (2026-09-09): self-update, portable

No installer, ever. Every push to `main` publishes the rolling `latest` release; a build is
newer when it was built from a different commit than the running one. This is the app's one
network call, and the settings switch turns it off.

```
bridge.updateCheck()    -> {current:{sha,short,date}|null, latest:{sha,short,publishedAt}|null,
                            behind, commits:[{short,subject,date}] (newest first, ≤20),
                            asset:{name,size,url,digest|null}|null, error:string|null}
                           never rejects; a dev build (current null) makes no request;
                           404 = latest null, error null (CI recreating the release)
bridge.updateDownload() -> {path, bytes, verified}   Err while one runs ("already downloading");
                           size must match, sha256 must match when a digest is published; a
                           failed download is deleted
bridge.updateApply()    -> never resolves on success: swap, relaunch with the original argv,
                           exit. Err with nothing verified, while downloading, or when the swap
                           fails (the previous build is restored). The UI saves the page and
                           flushes state first.
bridge.on('update', {phase:'download', received, total} | {phase:'apply'})
platform.build          {sha, short, date} | null (dev build)
settings.updates        boolean, default true: with it off no automatic request is ever made;
                        `app.update-check` still works and says so
store 'update'          {current, latest, behind, commits, asset, error, checkedAt}
commands                app.update-check "Check for updates"; app.update "Update now…" (when behind)
status bar              right side, `update · N commits` (a button, --accent, mono) while behind
schedule                10 s after boot with a vault open, then every 6 h; silent unless behind
dev bridge              updateCheck → dev shape; updateDownload/Apply → Err('not in the dev bridge')
```

Hidden names gain `os.exe.new`, `os.exe.old`, `os.app`, `os.app.old`, `os-update.zip`,
`os-update-tmp`. `os --version` prints the stamp; `os --update` runs check → download → swap → relaunch
with no window (exit 0 when up to date or swapped, 1 on failure); `--hold <secs>` exists in
debug builds for the swap test. See docs/TAURI.md "Self-update" for the swap on each platform.

## Batch 12 (2026-09-10): the rough edges

The third plan (`work/research/plan.html` during the batch; the artifact "os editor: the rough
edges"): 90 items from 201 findings by five research agents, everything a complete markdown
editor has that this one did not. Eight packages ran at once, one agent each, one module each
under `src/editor/` aggregated by `extensions.js`; every package wrote its own section below.
The decisions taken for the whole batch:

- The keymap is Obsidian's (see "Keyboard map, batch 12"): Ctrl+P commands, Ctrl+O quick open,
  Ctrl+K link, Ctrl+E source, Ctrl+H replace, Ctrl+Enter checkbox, Alt+Enter follow link.
- Tab in a paragraph does nothing; it only ever nests (lists) or moves (tables).
- `[[` opens the page picker and writes a markdown link. Wiki-link syntax is never written.
- Previous versions live under `.ose/versions` (one per five minutes per file, 20 per file,
  50 MB per vault). Nothing else keeps a copy of anything.
- Two dependencies join: `@codemirror/language-data` (code-block highlighting) and
  `tauri-plugin-single-instance` (one window per vault).
- Shift+Enter writes a bare newline inside a paragraph; `<br>` typed stays `<br>`.
- The context menu in the body is the app's; the WebView's browser menu and its accelerator
  keys (F5, Ctrl+R) are off.

### The extension seam (extensions.js)

`src/editor/extensions.js` imports one module per package (`table`, `code`, `commands`, `menu`,
`image`, `source`, `versions`, `backlinks`, `wikitrigger`, `linkstate`). A module may export
`plugins(ctx, o) -> Plugin[]` (ProseMirror plugins, asked before Milkdown's keymap and before
blocks.js, in list order: tables first), `featureConfig(o) -> {[CrepeFeature]: options}` (merged
one level deep over crepe.js's own), and `registerCommands(api)` (called once at boot from
index.js). `api` is `editorApi` in index.js: `hasPage, getPage, getView, getCrepe, getPath,
getDoc, focusTitle, focusBody, markDirty, saveNow, reopenInPlace, attachFile, openFind` —
accessors, never the page object, and modules never import index.js. index.js calls
`keepVersion(path, previous, next)` from versions.js before every write.

### Keyboard map, batch 12

The map is Obsidian's. `Mod` is **Ctrl** on Windows and Linux and **Cmd** on macOS: one switch in
`shell/keys.js` reads `document.documentElement.dataset.os === 'mac'` (falling back to a
user-agent test until the shell sets the attribute) and matches `metaKey` on mac, `ctrlKey`
elsewhere. On mac the app therefore never claims Ctrl+P/N/K/F/A/E/H (Emacs caret motion) and
never claims Option+Left/Right (word jump); the two chords that would collide are remapped, and
those are the only two differences in the table.

#### Shell chords (`shell/keys.js`, window capture; no module may shadow them)

```
Mod+P         command palette            app.palette
Mod+O         quick open                 app.quickopen
Mod+N         new page                   page.new
Mod+S         save now                   page.save
Mod+W         close the page             page.close        save, then the start surface
Mod+Q         quit                       app.quit
Mod+\         toggle sidebar             app.sidebar
Mod+Shift+E   focus sidebar              app.focus-sidebar
Mod+Shift+N   new folder                 tree.new-folder
Mod+F         find in page               page.find
Mod+H         find and replace           page.replace      mac: Cmd+Alt+F
Mod+Shift+F   search the vault           app.search
Mod+Shift+O   go to heading              page.outline
Mod+E         toggle source mode         page.source-toggle
Mod+K         link                       format.link
Alt+Enter     follow the link at caret   page.follow-link  (Option+Enter on mac, as Obsidian)
Mod+Shift+T   reopen the last closed     app.reopen-closed
Mod+=  Mod+-  Mod+0   zoom               app.zoom-in / app.zoom-out / app.zoom-reset
Alt+Left  Alt+Right   back / forward     app.back / app.forward   mac: Cmd+[ and Cmd+]
Mod+,         settings                   app.settings
Mod+Shift+L   toggle theme               app.theme
Esc           close the newest overlay, else dismiss the newest toast (and falls through)
F2            rename (in the tree; the sidebar owns it)
```

Chords whose character moves with the keyboard layout (`0`…`9`, `=`, `-`) are matched on
`event.code` as well as `event.key`, so an AZERTY digit row reaches them (E26).

Three rules make the map hold in the two places that have their own keymaps:

- **Inside a code block** (`.cm-editor`) the six chords CodeMirror owns are let through instead
  of fired — Alt+Left/Right, Alt+Up/Down, Mod+D, Mod+Shift+K (`CODE_KEYS` in `keys.js`) — and
  the body keymap stands down there entirely. Every other shell chord still fires.
- **Mod+0 inside the editor body** is not zoom: it falls through to the body keymap, where it is
  `block.paragraph`, so the block group Mod+0…Mod+6 is one gesture. Anywhere else Mod+0 resets
  the zoom, and `app.zoom-reset` is always in the palette.
- A chord typed into a dialog's input that is not overlay-safe belongs to the input. A mapped
  chord whose command is not registered toasts `<id> is not available yet`; one whose `when` is
  false says why (batch 9, D5).

#### Body chords (`editor/commands.js`, a ProseMirror keymap; never inside a code block)

```
Mod+B   bold          Mod+I   italic        Mod+Shift+X  strikethrough
Mod+`   inline code   Mod+Shift+M  clear formatting
Mod+0   paragraph     Mod+1 … Mod+6  heading 1 … 6      (matched on event.code Digit0…Digit6)
Mod+Shift+8  bullet list      Mod+Shift+7  numbered list     Mod+Shift+9  task list
Mod+Shift+.  quote            Mod+Shift+C  code block
Mod+Enter    toggle the checkbox of the task the caret is in
Alt+Up / Alt+Down     move the block up / down     (Mod+Shift+Up/Down still do the same)
Mod+D        duplicate the block      Mod+Shift+K  delete the block
Mod+A        from a block selection, the whole body (the press after that is the title, P5)
Esc          select the block         (batch 5; Esc again is a caret)
Tab          nothing in a paragraph; sinks a list item that has one above it; the next cell in
             a table; never a space, and never a focus that leaves the page
Shift+Tab    lifts a list item, the previous cell in a table; nothing anywhere else
Alt+Shift+Up / Down / Left / Right   add a row above or below, a column left or right —
             only with the caret inside a table (`table.*`, P2's commands)
```

A body chord whose command's `when` is false is not swallowed: the key falls through to
whatever else wants it, which is what lets `Mod+Enter` mean "exit the table" inside a table and
"toggle the checkbox" everywhere else without either side knowing about the other.

Milkdown's own `Mod-Alt-…` chords stay as aliases. `plugin-indent` is removed before
`create()`: Tab never inserts spaces, so prose can no longer turn itself into an indented code
block on the next reload (E1, E2, L2).

**Block selection (D2/L21).** While a block is selected, only Backspace, Delete, Enter, the
arrows and the block chords act. Typing a printable character first collapses the selection to a
caret at the end of the block and then inserts the character, so Esc followed by a letter can no
longer eat a paragraph. Text that arrives without a keystroke — an autocorrect replacement, a
soft keyboard, an `insertText` — is caught in `beforeinput` and lands the same way; a composing
IME is left alone, as it is everywhere else (E44).

`Esc` on a block that is already selected — including a whole table, which `table.js` hands over
as a `NodeSelection` and then stops answering for — goes back to a caret, so the third press on a
table ends the way the second press on a paragraph does.

Delete, duplicate and move dispatch their transaction with no metadata on it, because the
preset's own list plugin stands down on a transaction that carries any: with metadata, deleting
`2.` of three items left the labels reading `1. 3.` until the page was reopened. The block
selection ends anyway — any change to the document ends it.

**IME.** Every keydown handler in the editor returns early while `event.isComposing` is true
(E44).


### Editor commands

Every action inside the body is a registered command, so the palette lists it, the context menu
draws it and the chord is only a shortcut to it. Groups: `format` (marks and inline),
`block` (whole blocks), `table` (the caret inside a table), `editor` (the code block's own two,
`code.language` and `code.copy`) and `image` (the caret or the click on an image). All five are
in `shell/palette.js GROUP_ORDER`, in that order, between `page` and `tree`: a group the palette
does not know sorts under a heading nothing declares. `when` is "a page is open and the caret is
in the body".

```
format.bold          Bold                     Mod+B
format.italic        Italic                   Mod+I
format.strike        Strikethrough            Mod+Shift+X
format.code          Inline code              Mod+`
format.link          Link…                    Mod+K
format.link-remove   Remove link
format.clear         Clear formatting         Mod+Shift+M
format.copy-markdown Copy selection as markdown
format.paste-plain   Paste as plain text      Mod+Shift+V
block.paragraph      Paragraph                Mod+0
block.h1 … block.h6  Heading 1 … Heading 6    Mod+1 … Mod+6
block.bullet         Bullet list              Mod+Shift+8
block.numbered       Numbered list            Mod+Shift+7
block.task           Task list                Mod+Shift+9
block.quote          Quote                    Mod+Shift+.
block.code           Code block               Mod+Shift+C
block.divider        Divider
block.table          Table                    (runs table.insert when P2's command is there)
block.toggle-task    Toggle checkbox          Mod+Enter
block.move-up        Move block up            Alt+Up
block.move-down      Move block down          Alt+Down
block.duplicate      Duplicate block          Mod+D
block.delete         Delete block             Mod+Shift+K
block.select         Select block             Esc
block.turn-into      Turn into…               (a picker of the block types)
page.close           Close page               Mod+W
page.replace         Find and replace         Mod+H
```

**Link (E20/E21/L9).** `format.link` opens one dialog: a single field that takes either a URL or
a page name. The list under it is the quick-open matcher over `allPages()`; a row that is a page
links to it by its title with an href relative to the open page; a field that parses as a URL (a
scheme, or `www.`/`host/path`) offers a `link to <url>` row; a name that matches no page offers
`create <name>`, which creates the page beside the open one and links to it. Enter takes the
selected row. With the caret inside an existing link the dialog opens prefilled with that link's
href and its foot carries `Remove link`. With a selection, the selection stays as the link text;
with none, the page's title (or the URL) becomes the text.

**Wrap a selection (E25).** Typing one of `*`, `_`, `` ` ``, `[`, `(`, `"` over a non-empty
selection wraps it instead of replacing it. In a WYSIWYG the three markdown ones mean their
mark, not their character — writing `*` into the document would put a literal asterisk in the
file and the serialiser would escape it — so `*` and `_` toggle emphasis, `` ` `` toggles inline
code, and `[` opens the link dialog, as it does in Obsidian. `(` and `"` are ordinary
punctuation and are written as they are, around the selection. Not in code blocks, not in
inline code.

**Copy as markdown (S8).** A `clipboardTextSerializer` puts the selection's markdown, through the
same `postProcess` a save uses, on `text/plain`; `format.copy-markdown` does the same from the
palette. `page.copy-markdown` still copies the whole file.

**Heading Backspace (E31).** Backspace at the start of a heading turns it into a paragraph in one
press; Milkdown's level-by-level downgrade is replaced.

**`[] ` and `[x] ` at the start of a paragraph** make a task item (E12/L22). `- [ ] ` keeps working.

**The selection toolbar (E41)** is real buttons (Crepe's own `<button>`s), so Tab from the body
lands on the first one; a `:focus-visible` ring is drawn inside the button, because the bar
clips its overflow; Enter and Space act (the component listens for `pointerdown`, so the key
handler says it that way); Esc puts the caret back. The link preview tooltip's icons get a tab
stop and a role the same way, and Tab with the caret inside a link moves into the tooltip while
it is on screen. The keyboard route that does not depend on the tooltip being visible is Mod+K,
whose dialog carries both Edit and Remove.

**Find and replace (S22/L15).** `page.find` (Mod+F) opens the bar; `page.replace` (Mod+H) opens
it with its second row: replace field, `Replace`, `Replace all`, and the two switches `Aa`
(match case) and `ab|` (whole word). Previous, next and close are buttons on the first row.
Mod+H puts the caret in the replacement field, as source mode's panel does. The bar is two
columns — the fields, then what acts on them — so it reads as two rows and tabs as query,
replacement, buttons; the replacement field is one Tab from the query, not six.
Enter next, Shift+Enter previous, Enter in the replace field replaces, Esc closes. Whole word
is a look-around on letters, digits and underscore with the `u` flag, not `\b`, so it means the
same thing on a French word as on an English one. Every replacement is one ProseMirror
transaction, so undo works and the page goes dirty through the normal path; `Replace all` is one
transaction for the whole document and one undo takes all of it back. A replacement says the
edit was the user's (`createFind`'s third argument), because the bar's own keys and clicks are
deliberately not "touching the page" and a replacement on a page nobody had typed in would
otherwise never reach the disk. `find.js` also exports
`currentFind()` — the bar of the open page — and `open({ query, replace })`, so the vault search
can hand its own term over (N36) without going through `index.js`.


### The editor's context menu

The WebView's own menu is off (P8). `editor/menu.js` answers `contextmenu`, Shift+F10 and the
`ContextMenu` key inside the body and draws `shell/dialog.js` `contextMenu(x, y, items)` — the
same component the tree uses, so arrows, Home/End, letter jumps, Enter and Esc come for free.
**Shift+right-click** is not claimed, so the WebView's own menu answers it where the host still
allows one: no browser tells a page which word it has underlined, and the only signal that does
exist ("this element is spellchecked") is true of the whole body, so the fall-through has to be
a gesture rather than a detection. With the host's menu switched off entirely, that gesture
answers with nothing and spelling suggestions are not reachable anywhere in the app.

Items, in order, each hidden when its command's `when` is false:

```
Cut · Copy · Paste · Paste as plain text
Copy as markdown                       (only with a selection)
—
Turn into…                             (a second menu: Paragraph, Heading 1…6, Bullet list,
                                        Numbered list, Task list, Quote, Code block)
Link…  ·  Remove link  ·  Clear formatting   (Remove only inside a link)
—
table.* when the caret is inside a table (Add row above/below, Add column left/right,
        Delete row, Delete column, Delete table, Align left/center/right)
image.* when the click is on an image (Open, Copy path, Caption)
—
Select block · Duplicate block · Delete block
```

Every row carries its chord from `shortcutFor(id)`, so the menu, the palette and the keymap
cannot drift. `Cut` and `Copy` go through `document.execCommand`, which runs ProseMirror's own
copy handler, so what leaves the app is the same slice Mod+C sends. `Paste` cannot: no browser
lets a script run the paste command, so the row reads the clipboard and hands the result to the
view's own paste path, and says which key to press when the read is refused.

`plugin-indent` is removed from the editor before `create()` — only its shortcut, since Crepe's
builder configures `indentConfig` at create time and removing the whole plugin takes the ctx
slice with it.


### Tables

`src/editor/table.js` (+ `table.css`), registered through `editor/extensions.js` as the **first**
module in the list, so its ProseMirror keymap is asked before Milkdown's own (`preset-gfm`'s
`tableKeymap`, `plugin-indent`'s bare `Tab`, the base keymap) and before `blocks.js`.

**Keys, when the caret is inside a table cell.** Nothing below ever inserts a space or a tab.

```
Enter                the cell below, same column; on the last row, add a row after and go into it
Ctrl+Enter           leave the table: a paragraph after it (what plain Enter used to do)
Shift+Enter          a hard break inside the cell (a `hardbreak` node; P6 writes it as `<br>`)
Tab / Shift+Tab      next / previous cell, wrapping by row; on the last cell Tab adds a row
                     after and goes into it. Shift+Tab in the first cell does nothing.
Backspace / Delete   with a CellSelection: empty the selected cells and nothing else
Esc                  caret in a cell -> select that cell (a CellSelection of one cell)
Esc again            select the whole table as a block (a NodeSelection on the `table` node,
                     which is what blocks.js acts on: Backspace removes it, Ctrl+Shift+Up /
                     Ctrl+Shift+Down move it, Esc again drops back to a caret)
Ctrl+A               first the cell's own text, then the whole table (a CellSelection over
                     every cell); a third press falls through to the document
```

`table.js` returns `true` only while the selection is inside a table, so every one of these keys
keeps its normal meaning everywhere else.

**Commands** (group `'table'`, registered in `registerCommands(api)` from `extensions.js`; every
one but `table.insert` has `when: caret is inside a table`, so they are invisible in the palette
elsewhere). They act on the caret's cell, or on the whole CellSelection when there is one.

```
table.insert        Insert table          3 columns, a header row and two body rows, at the caret
table.row-above     Add row above
table.row-below     Add row below
table.col-left      Add column left
table.col-right     Add column right
table.delete-row    Delete row            the row the caret is in, or every selected row
table.delete-col    Delete column         the column the caret is in, or every selected column
table.delete        Delete table
table.align-left    Align column left     sets the `alignment` attr of every cell in the column
table.align-center  Align column center
table.align-right   Align column right
```

The three alignment commands toggle: run on a column that already has that alignment, they clear
it. Markdown tells `| --- |` from `| :--- |`, and without the toggle a table Hassan wrote
unaligned could never be put back the way he wrote it.

Chords are P3's (`shell/keys.js`); the ids above are fixed so they can be bound and put in the
context menu without touching `table.js`.

**What is written.** A new table is three columns wide: one `table_header_row` and two
`table_row`s, all cells empty, no alignment set. Alignment is the `alignment` attribute of the
cells in a column (`left` | `center` | `right`, `null` for none), which `preset-gfm` already
round-trips through the delimiter row; the delimiter row's own shape is P6's (`| --- |`).
Shift+Enter inserts a `hardbreak` node inside the cell's paragraph.

**The popover** (Milkdown's `table-block` node view, which `table.js` cannot rewrite) is made
keyboard-usable from outside: while the caret is in a table the row and column handles for that
cell are shown and positioned, every handle and button gets `type="button"`, an `aria-label` and
a `:focus-visible` ring from `tokens.css`, the add-row / add-column buttons are shown when the
handle is hovered **or** focused, and Enter or Space on any of them runs the matching `table.*`
command (Milkdown binds those buttons to `pointerdown` only). `table.css` is the only stylesheet
involved and uses tokens and the `--sp-*` scale only.


### Code blocks

`src/editor/code.js` (+ `code.css`) owns everything inside a fence. It exports the three
extension-seam functions and nothing else; nobody imports it but `extensions.js`.

**Languages.** `@codemirror/language-data` (the one dependency this package adds) is passed to
Crepe's code-mirror feature as `languages`, so `LanguageLoader` finally has a pack to load from:
~40 languages, each a dynamic `import()` fetched the first time a fence asks for it. A fence's
language lives where it always did, in `node.attrs.language`, and is written back byte for byte:
` ```js `, ` ```javascript ` and ` ```Rust ` all survive a round trip, and the loader matches
them case-insensitively against the pack's names and aliases. A name the pack does not know
(` ```mermaid `) is kept and simply not highlighted.

**Colours.** `syntaxHighlighting(style)` with a non-fallback highlighter replaces
`defaultHighlightStyle` outright (`getHighlighters` prefers any real highlighter over a
`fallback: true` one), so not one of CodeMirror's hard-coded hexes reaches the screen. The style
is declared with `class:` names, not inline styles: every token gets an `os-t-*` class and
`code.css` colours it from tokens — `--code-key`, `--code-str`, `--code-num`, `--code-fn`,
`--code-type`, `--code-var` (added to `tokens.css` by P8), with comments on `--code-com`,
punctuation and operators on `--fg-2`, and an existing token as the fallback of every
`var(--code-*, …)` so the file is legible in both themes even before the tokens land.

**Chrome.** `basicSetup` still comes from Crepe and cannot be taken out of the array, so the
chrome it brings is switched off from the outside: the gutters (line numbers, fold, active line)
are `display: none` in `code.css` at a higher specificity than `editor.css`, the active-line and
selection-match backgrounds are neutralised, and `autocompletion({ activateOnTyping: false,
override: [] })` is appended — `combineConfig` takes the first value for a field, and Crepe's own
`autocompletion()` passes none, so ours wins and no completion popup ever opens inside a note.
Bracket closing, `indentOnInput` and Tab indentation stay. So do CodeMirror's own editing chords:
Alt+Left/Right (by syntax node), Alt+Up/Down (move line), Shift+Alt+Up/Down (copy line),
Ctrl+D (select next occurrence) and Ctrl+Shift+K (delete line) are all in `defaultKeymap` and
`searchKeymap` already — they only needed the shell to stop intercepting them (see below).

**The picker.** Crepe's picker cannot do the job: its list is whatever `languages` holds, it has
no free-text entry, no arrow keys, and it is drawn inside a block that clips it (L5). The trigger
button stays — it is the block's language label — but a capture-phase click listener on the
editor's own DOM takes the click before Vue sees it and opens ours instead: a popover appended to
`document.body` (so no ancestor can clip it), positioned under the trigger, `--shadow-menu`, one
input and a list of `--row-h` rows. Type to filter by name or alias; the first row is always
"as typed", so any name at all can be set, known or not; Arrow Up/Down move, Enter applies, Esc
closes and puts the caret back where it was. Picking a pack row writes the language in lower case
(`javascript`, `rust`); typing writes exactly what was typed (`js`, `Rust`, `mermaid`). The first
row when the box is empty is "Plain text", which clears the language.

**Fences and the way out.** A ProseMirror plugin (asked before Milkdown's keymap) adds two Enter
rules: ` ``` ` alone in a paragraph, or ` ```lang `, becomes an empty code block with that
language and the caret inside it (input rules never see Enter, which is why three backticks and
Enter used to do nothing); and Enter on a selected code block puts the caret back at the end of
its text. Esc inside CodeMirror is bound at `Prec.highest` and does the reverse: it dispatches a
`NodeSelection` on the code block and focuses the ProseMirror view, so the block is selected as
any other block is and Delete, Ctrl+Shift+Up/Down and the rest of `blocks.js` apply to it.

**Commands.** `code.language` ("Set code block language…") opens the picker on the block holding
the caret; `code.copy` ("Copy code block") copies its text. Both are in the palette and both are
guarded by `when`, so they only appear with a code block under the caret. Setting a language
marks the page dirty and saves like any other edit: the picker is portalled to `document.body`,
so none of its keys reach the page's own listeners, and it says so itself through
`editorApi.touch()`.

**What the shell must not take.** The shell binds its chords on `window` in the capture phase, so
they fire before CodeMirror ever sees the key. Inside `.cm-editor` the shell keymap and
`guardShellKeys` (`editor/index.js`) skip a small exempt list — `alt+arrowleft`,
`alt+arrowright`, `alt+arrowup`, `alt+arrowdown`, `ctrl+d`, `ctrl+shift+k` — and let CodeMirror
have them.


### Source mode (editor/source.js)

`page.source-toggle` "Toggle source mode" (Ctrl+E, bound by P3) swaps the body of the open
page between the block editor and the whole file as plain text in CodeMirror 6. The title
strip, the properties strip and the meta line do not change; only the body host is replaced.

- The text shown is the **whole file** — frontmatter, title line, body — as a save would write
  it: `composeDoc(doc, {title, body})` over the current buffer, so unsaved edits carry across.
  Leaving source mode parses it back with `parseDoc` and remounts the block editor; the title
  strip is rebuilt from the parsed title, and the undo history of the block editor is not kept
  across a toggle (say so once, in the status bar).
- Everything about saving is unchanged: the dirty flag, the 600 ms debounce, blur, Ctrl+S, the
  close veto, the changed-on-disk dialog, `keepVersion`. In source mode `compose()` is the
  CodeMirror text verbatim; in block mode it is `composeDoc` as before.
- An external change to a clean page reloads the source buffer in place, as it does in block
  mode. A read-only page (the file is gone) makes CodeMirror read-only too.
- Ctrl+F in source mode opens CodeMirror's own search panel (`@codemirror/search`), styled from
  `tokens.css`; `page.find` routes to it. Esc closes it. The panel takes the same
  `open({query, replace})` the block editor's bar takes: `query` seeds the field (a vault-search
  hit hands its term over), and `replace` — Ctrl+H, `page.replace` — puts the caret in
  CodeMirror's own replacement field. `page.replace` asks index.js for the open page's bar, so
  it reaches whichever kind the page has.
- **Non-markdown text files** — the list is P7's `paths.js TEXT_EXTS` (`txt csv jsonl py log
  tex json yaml toml`), and anything that is not `.md` opens this way — open directly in source
  mode with **no title strip**: the meta line shows the file name. They are never parsed as
  markdown and `composeDoc` is never applied to them, so what is written back is byte for byte
  what CodeMirror holds. `page.source-toggle` on one of them says so and changes nothing.
  `openPage` takes them like any other page; the router may route any of them to it, and a
  rename of one seen by the watcher is followed like any other page's, not read as a deletion.
  `page.source-toggle` is guarded on `hasPage` alone so that sentence is the one the user gets.
  `page.copy-markdown` works in source mode (`compose()` is the text verbatim);
  `page.outline` is the block editor's alone and is not offered in source mode.
- The mode is remembered per page in `.ose/state.json` under `sourcePages: [path, …]` (P5's
  key, capped at 200 entries, written through `patchState`). A page in that list opens in
  source mode.

The CodeMirror packages (`@codemirror/view`, `@codemirror/state`, `@codemirror/commands`,
`@codemirror/search`, `@codemirror/language`, `@codemirror/lang-markdown`) are already in the
tree as dependencies of `@milkdown/kit`'s code-mirror feature. No package was added.

### Versions (editor/versions.js, src-tauri/src/versions.rs)

Every write keeps the text it replaces. Versions live at
`.ose/versions/<vault-relative path of the file>/<yyyy-mm-dd-hhmmss>.md` — the file's own name
is a folder, so `7-scratchpad/note.md` keeps its versions under
`.ose/versions/7-scratchpad/note.md/`. `.ose` is hidden from the tree and gitignored.

Four rpc commands (host: `versions.rs`; dev bridge: `dev/bridge-plugin.mjs`, same semantics):

```
versionKeep(path, text, force?)  -> {kept: bool, id: string|null}
versionList(path)                -> [{id, at, bytes}]   newest first
versionRead(path, id)            -> string
versionRestore(path, id)         -> {kept: bool, id: string|null}
```

- `versionKeep` writes `text` as a new version of `path`. **At most one version per five
  minutes per file**: when the newest version of that file is younger than five minutes,
  nothing is written and `{kept:false}` comes back, so the state the file had before the
  editing session is the one that survives. `force: true` bypasses that rule; the editor
  passes it before "Keep mine" overwrites a file that changed on disk, which is the one moment
  a version is never optional. A version identical to the newest one is never written twice.
- Caps: **20 versions per file** and **50 MB per vault**, oldest pruned first (the per-vault
  sweep never removes the newest version of a file).
- `versionRestore` fails and writes nothing when the current file exists but cannot be read (a
  lock, a permission, bytes that are not UTF-8); only a missing file counts as nothing to keep.
- `versionRestore` keeps the file's current text as a version first (forced), then writes the
  chosen version over the file.
- Every write under `.ose/versions` and the restore itself is atomic: a temp file beside the
  target, then a rename.
- `at` is epoch milliseconds, `bytes` the version's size on disk, `id` the timestamp stem.

`keepVersion(path, previous, next)` in `versions.js` is called by the editor's write path
before every `writeText`. It does nothing when `previous === next` or `previous` is empty, it
never throws, and it never blocks a save for longer than the rpc.

`page.versions` "Versions…" opens a dialog over `openOverlay`: one row per version with the
time, the size and a one-line diff summary — `+N −M`, **what restoring that version would add
to and remove from the file as it is now**, counted per line without an LCS. Arrow keys move,
Enter or Restore restores, Esc closes. The page is flushed before a restore (a page whose save
is waiting on the user is not restored, and says so), and afterwards it reloads in place with
the undo history gone and a toast saying so.

### Images (editor/image.js)

- **Alt text survives.** The `image-block` node schema is extended with an `alt` and a `width`
  attribute; the markdown alt slot is written as `alt`, or `alt|300` when a width is set, and
  read back the same way — Obsidian's syntax. Milkdown's own use of that slot for the aspect
  ratio (`![1.00](x.png)`) is only accepted on read, as a legacy value, and never written.
  A file whose line reads `![Wiring diagram|420](x.png "caption")` round-trips byte for byte.
  P6's `postProcess` must therefore no longer strip `![1.00](` → `![](`.
- **Resizing writes a width.** Crepe's own handle drags the image's *height* and stores the
  result as that aspect ratio, which markdown cannot say and which distorts the picture, since
  a block image is always the column's width. The pointerdown is taken before Crepe sees it and
  the drag sets the **width** instead: it is clamped to 60px and the column, written to the
  `width` attribute on pointer-up, and cleared when the drag reaches the full column again. The
  pixel width is what reaches the file and what a reload renders from.
- **A missing image names itself.** When an image fails to load the block shows the file name,
  the alt text, and two buttons: `open folder` (`bridge.reveal`) and `edit path` (a prompt that
  rewrites the src). Never an empty grey box.
- Commands: `image.open` "Open image" (`bridge.openPath` when the host has it, else
  `bridge.reveal`), `image.copy-path` "Copy image path", `image.caption` "Toggle image caption".
  All three act on the selected image block, or the one nearest the caret.
- An image pasted from a web page (a clipboard carrying `text/html` whose only content is one
  `<img src=http…>`) is fetched from the page and written into the attachment folder like any
  other paste; a WebView that refuses the cross-origin read keeps the URL and toasts
  `kept as a link`. Milkdown's own uploader refuses every such paste, which is why this handler
  exists at all.

### The page lifecycle (editor/index.js)

- **Title to body (L11).** Enter, Tab or ArrowDown in the title puts the caret at the **start
  of the first body block**, not wherever it last was.
- **Body to title (L10).** Backspace or ArrowUp at the first position the caret can hold puts
  the caret at the end of the title. That position is `Selection.atStart(doc)`, so it is inside
  the first list item, the first table cell or the first quoted paragraph when the page opens
  with one of those, and the block itself (where a gap cursor sits) when the first block is an
  atom — ArrowUp leaves from any of them. Backspace only when the selection is empty and the
  first block is not a list item or a code block, so it never eats a block.
- **Ctrl+A widens (L19).** P3's Ctrl+A goes block → body; a further press extends the selection
  to the title as well, so the next Ctrl+C copies the whole note (title line included).
- **Word count (S32).** The meta line counts words from the ProseMirror document
  (`doc.textBetween`), not by serialising the file on every keystroke, and the count is
  debounced with the save.
- **Spellcheck (L12/E43).** `settings.spellcheck` (P8, `true|false`, default `true`) decides.
  When it is on, the editable root gets `spellcheck="true"` and `lang` = `navigator.language`;
  when off, `spellcheck="false"`. The language of the document is no longer guessed.

### What the implementation settled that the brief left open

- **The five-minute rule skips, it does not replace.** The brief's parenthesis ("a newer save
  inside five minutes replaces the newest version") and its reason ("so the last state before
  the session is always kept") point opposite ways: replacing the newest version is exactly
  what loses the pre-session state. The reason won. Inside the window nothing is written, so
  the version a file keeps through an editing session is the state it had when the session
  began. `force` is the escape hatch and the conflict dialog is its one caller.
- **`versionKeep` takes a third argument**, `force`, additively.
- **Source mode makes the title strip a label.** The title line is inside the text in source
  mode; a strip that could still edit it would be a second source of truth for the same bytes.
  It stays visible, dimmed and not editable, and follows the text on every save.
- **The meta line** follows P8's format (`N words · N characters · modified …`) with three
  additions: the file name in front for a page with no title, `source` when the mode is on, and
  P7's `N linked`.


### Links

- **One link shape.** Everything that writes an href writes `relativeHref(fromPage, target)`
  (`editor/paths.js`): page-relative, `encodeURIComponent` per segment. The tree's `Copy link`
  writes the same href relative to the open page; with no page open it writes the
  vault-root-relative form with a leading `/`, which `resolveHref` resolves against the root.
  A folder gets a trailing `/`. `Chapter #3.md` round-trips as `Chapter%20%233.md`.
- **Anchors.** `paths.js linkTarget(fromFile, href) -> {path, heading} | null`: the path
  resolved as before plus the `#fragment`, decoded; a bare `#heading` resolves to `fromFile`.
  `lines.js headingLine(body, heading) -> number|0` matches, in order: the GitHub slug
  (lowercased, spaces → `-`, punctuation dropped), the raw heading text, and the `%20`-decoded
  form (Obsidian's). Route: `{type:'page', path, line?, col?, heading?}`; `heading` is not part
  of `routeKey`; the router turns it into a line before the page mounts, and a heading on the
  page already open scrolls in place with no history entry.
- **Following a link** is one function, `editor/linkstate.js followHref(href, fromPath)`:
  external → `bridge.openExternal`, and a refused scheme is toasted rather than swallowed;
  `.md` → `navigate({type:'page', path, heading})` (a missing page still reaches the router's
  "Create it" screen); every other vault file → `bridge.openPath`, except the text extensions
  (`.txt .csv .jsonl .py .log .tex .json .yaml .toml`), which navigate so the editor opens
  them in source mode. Command `page.follow-link` "Follow link under cursor" (Alt+Enter)
  follows the link mark at the caret through the same function.
- **Broken links.** `linkstate.js` decorates every internal link whose target does not exist
  with the class `link-missing` (dashed underline in `--err-ink`). Existence is cached per
  page open and the cache is dropped on any `fs` event. Following one still offers "create".
- **`[[`.** Typing `[[` in a text block opens the page picker inline, anchored like the slash
  menu. It filters as you type, Enter inserts a **markdown** link with the page's title, `]]`
  or Esc closes and leaves the typed text. A name with no match offers `Create <name>`, which
  creates the page in the current page's folder and links it. Wiki-link syntax is never
  written and never rendered.
- **Backlinks.** `editor/backlinks.js` renders a `linked from` box under the page body,
  collapsed, fed by `lib/links.js findInbound`; the meta line gains `· N linked`. Each row is
  a page title with the matching line's text and opens that page at that line. Recomputed on
  open and on `fs`. Command `page.backlinks` "Show linked mentions" expands and focuses it.
- **Rewriting.** `lib/links.js rewriteInboundMany(pairs)` now rewrites, in a moved file, the
  hrefs that point **outside** the move set as well, so a page moved to another folder keeps
  its own links and its `attachments/` images working. It also rewrites `[ref]: path`
  definitions. Neither scan reads inside a fenced code block: a path in a code sample is
  documentation, not a link. Every file it is about to rewrite has its current text kept as a
  version first (`bridge.versionKeep(path, text, false)`, swallowed and logged) — this is the
  one write in the app with no undo, no dirty flag and no baseline check, and one gesture can
  touch hundreds of files. The candidate search runs uncapped (`bridge.search(q, {limit: 0})`)
  so a rename finds every inbound link, and the toast reports the exact count; a file whose
  write failed is named in a toast of its own, from the editor's rename as well as the tree's.
- **A rename seen by the watcher** (`fs` event with `to`) that the app did not make offers a
  toast `update N links` that runs the same rewriter.

### Files

- Tree menu: `Duplicate` (files only), `Move to…` on a lone folder as well, `Open with default
  app` on every row, folders included (`bridge.openPath`; a folder lands in the file manager),
  and `Search in folder` on a folder (opens the search overlay prefilled with `path:<folder>/`).
- Commands `tree.collapse-all` / `tree.expand-all`, `tree.duplicate`, `tree.open-external`,
  `tree.search-here`.
- A non-markdown row carries its extension as a mono `--fg-3` badge. A breadcrumb folder click
  focuses the folder in the tree and opens nothing.
- Keys: Backspace trashes as Delete does (macOS), Shift+F10 and the Menu key open the row's
  context menu at the row.

### Search

- `bridge.search(query, {limit})` semantics, identical in the host and the dev bridge:
  - The query is split into terms on whitespace; `"a phrase"` is one term; `path:<prefix>` and
    `file:<substring>` are filters, not terms. Every term must appear somewhere in the file
    (AND); a line is a hit when it contains any term.
  - File and folder **names** match: a name hit is reported with `line: 0`.
  - Text files are searched, not only `.md`: `md txt csv jsonl py log tex json yaml toml`.
  - A hit carries `col` (1-based column of the first term in the line).
  - The cap counts **files**, not lines: `limit` files (default 100), at most 20 lines each.
    The answer is an object `{hits, files, total, capped}`; an array is still accepted by the
    UI for older hosts. `limit: 0` means no cap at all (the rename pass uses it).
  - Results are ordered by score: a name match first, then the number of hits.
  - The host carries a search generation counter: a newer query cancels the older one.
- The overlay says `showing N of M files` when the answer was cut, ArrowUp recalls the last 20
  queries of the session, and a hit navigates with `{path, line, col}`.

### Routes and navigation

- `{type:'page', path, line?, col?, heading?}`. `col` is a 1-based column; the editor lands the
  caret on the match and opens find with the query so the hit is highlighted. A line, a column
  and a heading say where *this* open lands and are spent once: the history entry forgets them
  as soon as the route has been shown, so back and forward keep restoring the caret the page was
  left with instead of pinning it for ever to a heading a link once jumped to.
- Quick open (Ctrl+O) matches the H1 title and the path, split on spaces (every word must
  match one of the two); a row shows the title with the path under it in mono `--fg-3`.
  `Shift+Enter` creates a page named after what was typed, where `page.new` (Ctrl+N) would put
  it: the focused folder, else what the "new page in" setting says, else beside the open page,
  and finally the scratch folder — never the vault root by accident.
- `app.reopen-closed` "Reopen closed page" (Ctrl+Shift+T) reopens the last route `clearRoute`
  dropped; the router keeps a stack of the last 20.
- Back and forward restore the caret: the router stores `{line, col}` with the scroll position
  per route key and hands it to the editor on the way back.
- The title bar carries back and forward arrows (icon buttons, disabled when the stack ends,
  `aria-label` and a `title` with the chord), and mouse buttons 4 and 5 navigate.
- Every route change sets the window title through `bridge.setTitle`: `<Note> · <vault>`,
  `<View> · <vault>`, or the vault name alone on the start surface. `<Note>` is the page's own
  H1, the name quick open, the sidebar and the palette all show — the editor publishes it on the
  store key `pageTitle` (`{path, title}`) when it has parsed the file and again on every
  keystroke in the title strip, and the router follows it. The file's stem stands in while the
  page is still mounting and for a file with no H1.

### rpc additions

```
bridge.openPath(relPath)   -> null    opens a vault file — or folder, which lands in the file
                                      manager — in the platform's default application
                                      (host: `opener`, on the resolved path; dev bridge:
                                      start / open / xdg-open). Never a scheme, never outside
                                      the vault, and an error when the file is not there. An
                                      executable or script (exe bat cmd ps1 sh py jar lnk …)
                                      is revealed in the file manager instead, never run.
bridge.search(q, {limit})  -> {hits:[{path,line,col,text}], files, total, capped}
                                      limit counts files; 0 means no cap.
```

### Host safety

`vault.rs write_text` and `write_binary` write a temp file beside the target and rename over
it, the way `state.rs write_locked` does, so a crash mid-write never truncates a vault file.
`rename` performs a case-only rename (Windows) through a temporary name.


### Settings

`shell/settings.js` owns `state.settings` and applies it to `<html>`. Every row shows one
sentence under it. Defaults, and who reads each:

```
fontSize       14 | 15 | 16 | 17          --fs-body, in rem                    (16)
lineHeight     1.5 | 1.65 | 1.8           --lh-body                            (1.65)
readableWidth  boolean                    <html class="full-width"> when off   (true)
zoom           90 | 100 | 110 | 125 | 150 --zoom, the root font size            (100)
newPages       focus | scratch | page     focus.js defaultNewFolder()          ('focus')
attachments    'beside' | <vault folder>  settings.attachmentFolder(pagePath)  ('beside')
trash          system | vault             bridge.trash(path, {mode})           ('system')
spellcheck     boolean                    the editor's spellcheck attribute    (true)
updates        boolean                    the one network call (batch 11)      (true)
```

Exports other modules read, all re-exported from `shell/index.js`:

```js
settings()                     the whole object, defaults merged
attachmentFolder(pagePath)     -> vault-relative folder ('' is the root). 'beside' answers
                                  `<page folder>/attachments`, which is what was hard-coded.
spellcheckOn()                 -> boolean
trashMode()                    -> 'system' | 'vault'
trashDestination()             -> 'the system recycle bin' | '.trash in the vault',
                                  the words the trash confirmation uses
zoom() / zoomLabel() / setZoom(pct)
newPageMode()                  -> 'focus' | 'scratch' | 'page'
```

Bus event `settings`: emitted with the whole settings object after any change. A module that
caches a setting (the editor's spellcheck attribute, the status bar's zoom item) re-reads here
instead of asking on every keystroke.

`defaultNewFolder()` (focus.js) answers the focus folder when one is set — focus mode always
wins — and otherwise follows `newPages`: `focus` answers `''` (so `page.new` falls through to
the open page's folder and then the scratch source, as before), `scratch` answers the scratch
source, `page` answers the folder of the open page.

### Zoom

Five steps, 90 / 100 / 110 / 125 / 150 %, remembered per vault under `settings.zoom`. The
factor is `--zoom` on `<html>` and the only thing it does is scale the root font size
(`:root { font-size: calc(var(--zoom) * 100%) }` in tokens.css). Every size token is therefore
written in rem, and at 100 % each is exactly the pixel value it replaced. What stays in px:
hairlines and `--radius`, the sidebar width (window geometry the shell measures against
`window.innerWidth`), the frameless window's grab zones, and the macOS traffic-light inset.

```
app.zoom-in  app.zoom-out  app.zoom-reset      group app, with `when` guards at the ends
status bar   `110%` while not 100 %, a button that resets
```

The web view's own zoom hotkeys are off in both window configs (`zoomHotkeysEnabled: false`),
so Ctrl+= / Ctrl+- / Ctrl+0 reach the page on every platform.

### Window

- **Title (S13).** `bridge.setTitle(text)`: `getCurrentWindow().setTitle` in the host (and
  `document.title` with it), `document.title` alone in the dev and WebView2 adapters. Called by
  the router on every route change.
- **Closing (S28).** The adapter still turns the first close attempt into a `closing` notice and
  still waits at least 400 ms, but there is no ceiling any more: the window is destroyed when
  every handler has settled, however long the save takes. After 3 s a toast says `still saving…`
  and stays until it settles. A handler resolving `false` vetoes the close, as before.
- **Quitting (S16).** `bridge.quit()` → rpc `quit` → `window.close()`, so a quit takes the same
  path as the close button and waits for the same save. `RunEvent::ExitRequested` with no exit
  code does the same thing whenever the main window still exists; once it is gone, the same
  event means "nothing left to save" and the app exits. `RunEvent::Exit` still writes the window
  geometry. Command `app.quit` (group app, hidden in the browser).
  **macOS:** the system's own Quit (`terminate:` from a predefined menu item, the Apple menu,
  the Dock) reaches tao as `applicationWillTerminate`, which is past the point of no return and
  arrives as `RunEvent::Exit`, never `ExitRequested`. The host therefore builds its own menu bar
  (`main.rs build_menu()`): the app submenu's Quit is a plain item with the `Cmd+Q` accelerator
  and the id `app.quit`, which runs the close path, never `PredefinedMenuItem::quit()`. An Edit
  submenu carries the standard editing accelerators, without which a Mac window with a menu of
  its own loses Cmd+C/V/X/A inside the web view. The menu is built on every platform so it
  type-checks everywhere, and installed on macOS alone.
- **The browser underneath (S27).** Tauri exposes neither of wry's
  `with_browser_accelerator_keys` / `with_default_context_menus`, so the page refuses them
  itself: `guardBrowserKeys()` swallows F5, Ctrl+F5, Shift+F5, Ctrl+R, Ctrl+Shift+R,
  Ctrl+U and F7 in the capture phase, and `guardContextMenu()` calls `preventDefault()` on any
  `contextmenu` event that reached the window unhandled, so the web view's own menu (with
  Reload in it) never appears. Shift+right-click is the one deliberate exception: it is the only
  route to a spelling suggestion, because no browser tells a page which word is underlined. A
  key the guard swallows must be one nothing in the app wants — Ctrl+O is quick open and is
  therefore not in the set.
- **The two window configs (S49).** `tauri.macos.conf.json` is merged into `tauri.conf.json`
  with RFC 7396, which replaces arrays wholesale: a key added to the base window object and not
  repeated in the macOS one disappears on macOS. That is how `dragDropEnabled: false` was lost,
  and with it every drop and drag-to-move on a Mac (S17). Tauri parses both as strict JSON, so
  the rule cannot be a comment: it is a test (`lib.rs the_macos_window_mirrors_every_key_of_the_base_window`)
  that fails the build when a key is not mirrored.
- **The sidebar on a narrow window (L25).** Never more than 40 % of the window, and under 640 px
  it hides itself and comes back when the window is wide again. `sidebar.open` — the
  preference — is never written by the window; an explicit toggle overrules the automatic hide.

### The vault

```
bridge.recentVaults()   -> [{path, name, exists, current}]   newest first, at most 10
bridge.openVault(path)  -> {root, name}       adopts a folder with no dialog, like pickVault
bridge.forgetVault(path)-> null               drops one line of the recent list
bridge.forgetVault()    -> null               unchanged: forgets the remembered root
```

The list is `<app config dir>/vaults`, one absolute path per line, beside the `vault` file that
holds the remembered root: that file answers "which vault opens by itself", this one answers
"which vaults has this person had open" (S46). It is written when a vault is adopted — the
picker, `openVault`, a second launch — and once at startup for whatever the app opened by
itself. The first-run chooser lists it under `recent`, and `Change vault…` opens the same list
with `Choose folder…` beside it; Delete forgets the focused row; a folder that no longer exists
is dimmed and marked `missing` rather than hidden.

**One instance per vault (S14).** `tauri-plugin-single-instance`: a second launch hands its
argv over and exits. Same root (or no `--root` at all) brings the running window forward;
another root is adopted and announced on the event `vault` `{changed:true}`, and the page
reloads into it — one window, the vault it was told to open.

**The vault going away (S29).** The watcher's restart loop reports it once, as `fs` with
`{changes: [], lost: true}`, and again with `lost: false` when the folder comes back. The shell
puts up one dialog — "The vault is gone", `Retry` and `Change vault…` — instead of a toast per
failed call; the folder coming back closes it and reloads. Anything else that reads the root
and is told it does not exist calls `vaultLost()`, which is idempotent.

### Access and look

- `openOverlay({..., title})` sets `aria-modal="true"` on any dimmed overlay and `aria-label`
  from `title`; every `.dlg` head carries an id the box points `aria-labelledby` at. A menu
  (`dim:false`) is not modal and does not claim to be (S40).
- `--fg-3` moved in both themes so small chrome text clears 4.5:1 on `--bg`, `--bg-2` **and**
  `--bg-3`: light `#6B6759` (5.37 / 5.01 / 4.53), dark `#959182` (5.56 / 5.28 / 4.61) (L28).
  Not on `--bg-4` (4.05 / 4.00), and it cannot be: the value that would clear it lands on top of
  `--fg-2`. The two grounds made of `--bg-4` — a multi-selected tree row, an active row — put
  their dim text on `--fg-2` instead (5.00 / 5.07).
- `--accent` is for bars, borders and fills; accent-coloured **text** takes `--accent-ink`
  (`#A2492B`, 5.66 / 5.27), because `--accent` itself is 2.96:1 on `--bg` in the light theme.
  The fuzzy-match characters in quick open and in the search results, and the status bar's
  `update` button, are text. Dark aliases `--accent-ink` back to `--accent`.
- Eight code-highlight tokens, both themes, each measured on `--bg-2`: `--code-key`,
  `--code-str`, `--code-num`, `--code-fn`, `--code-type`, `--code-var`, `--code-punc`,
  `--code-com`.
- A symlinked folder is shown in the tree, greyed, `title="link, not followed"`, from a tree
  node whose `kind` is `link` (S31). CSS `.sb-row.link`.

### Fidelity

The rule from CLAUDE.md — the editor never rewrites a file it did not edit, and a user edit
never reformats the rest of the file — is now a measured guarantee, not an intention. Every
sentence below is a sentence the round-trip harness tests.

**The unit is the block, not the line.** `stringify.js blocks(text)` cuts a markdown text at its
blank lines (fenced code kept whole); that is where every top-level block ends. `reconcile(out,
original, {canon})` asks, for each block of the file on disk, what the editor would write for
that block *on its own* (`canon` is `crepe.js canonicalise`, memoised per editor). A block whose
answer is the block the editor is writing now is a block the user did not touch: it keeps its
original bytes, exactly, however differently it is spelled — a four-space nested list, a setext
heading, a padded table, a hand-written escape. The blocks that do not match are the ones the
user edited; they are paired with their originals by position between the matched blocks on
either side, written from the canonical text with a line-level pass inside them, and verified on
their own. Nothing that happens to one block can reach another: there is no whole-file fallback
any more, and the 80-line resynchronisation window is gone with it.

**Verification, unchanged in kind.** A block is only restored when re-serialising it gives back
exactly what the editor was going to write. The assembled file is checked once more the same
way before it is handed to the caller; if that check ever fails the canonical text is written.
Measured over the vault, it never fails.

One difference is allowed at the block level and nowhere else: the blank lines between the items
of one list. Whether a list is loose is a property of the whole list, not of the four items that
happen to sit in one block — a list with a blank line and one more bullet further down is *one*
loose list, so the canonical text puts a blank line between every item while the file has none.
A block written tight is accepted when it re-serialises to the canonical block with only those
blank lines missing, the candidate itself has none left, and every blank line of the canonical
block sits between two items of a list. Two paragraphs are never joined by it, and the whole-file
check is what proves the result: the blank line further down is still in the file, so the list is
still loose when it is read back.

**Tables.** An edited table is restored row by row: a row whose cells did not change keeps its
own padding, so a one-cell edit rewrites one row. The delimiter row is markup, not content, and
is kept byte for byte whenever the column count and the alignments are unchanged. A delimiter
row the editor writes is `| --- |`, with alignment colons kept (`:---`, `---:`, `:---:`), never
mdast's minimal `| - |`. The table does not have to be the first line of its block: Hassan writes
the heading and the table under it with no blank line between them, which is one block in the
file, and the table is found wherever inside the block it starts. Whatever sits above or below it
in the same block goes through the ordinary line pass.

**Backslashes.** An edited line never gains a backslash the file did not have. mdast escapes any
character that *could* open a construct at that position, and `postProcess` undoes the handful it
can prove unnecessary from the line alone; the reconcile pass has more to go on — the block as
the file wrote it. A backslash in front of a character the original block never escaped is
dropped, and only where dropping it leaves the block saying the same thing, which is the same
re-serialisation test every other restoration has to pass. So `**Rate: 70%**` with a letter typed
after it stays `**Rate: 70%**x` rather than becoming `\*\*Rate: 70%\*\*x`, and a `\_` or `\*` the
file wrote itself is content and is kept.

**Links the file spelled out.** `[a@b.com](mailto:a@b.com)`, `<a@b.com>` and `a@b.com` all parse
to the same link, and `resourceLink: false` writes the shortest of the three. On an untouched line
the line pass puts the file's own spelling back (`lineKey` ignores the difference); on the line
the user was on the spelling is looked up in the block instead, so a `[text](mailto:…)` stays
`[text](mailto:…)` when the label is the address as well as when it is not.

**The file's own bytes.** `doc.js parseDoc` reads and `composeDoc` writes back:

- a UTF-8 BOM, stripped before the title regex and the editor and restored on write;
- the final newline exactly as the file had it — 96 of the vault's 172 files have none, and the
  editor no longer adds one;
- each line's own ending, recorded per line, so a file with 99 CRLF lines and 8 LF ones keeps
  all 107 (`doc.eol`, the majority ending, is only what a line the editor *adds* gets);
- trailing spaces on any line the user did not edit.

`---` on line 1 opens frontmatter only when the block closes within 64 lines and every line in
it is blank, a `#` comment, a `key: value`, an indented continuation or a `- item`; otherwise it
is a thematic break and the prose under it reaches the editor. A closing `#` sequence on the H1
(`# Title #`) is markup: the title is `Title`.

The gap between the title line and the body is the file's own bytes and is written back
unchanged. What the *editor* puts in front of the body is not: an empty paragraph at the top of
the page is written as nothing at all, but it still leaves a blank line, and that blank line
meets the one the gap already ends with. So the body's leading blank lines are trimmed to what
the gap leaves room for — never more than one blank line at the seam, which is CLAUDE.md's rule
against runs of blank lines. They can only ever come from the editor: `parseDoc` puts every
newline after the title line into `gap`. An empty list item the editor makes is written `-`, a
marker with nothing after it: it reads back as the same empty item and leaves no trailing space
on the line. An empty item the file wrote as `- ` keeps its bytes like any other untouched line.

**What the parse used to destroy.** Two of Milkdown's remark plugins are left out of the editor,
because both deleted markdown before anything downstream could see it. `remark-preserve-empty-line`
spliced out every `<br>`, so `line one<br>line two` came back as `line oneline two`; without it
`<br>` is an ordinary inline html node and survives — inline, alone on a line, and inside a table
cell. Its other effect goes too: an empty paragraph is no longer written as `<br />`, it is
simply not written, which is what Obsidian does. `remark-inline-links` rewrote `[text][ref]` into
`[text](url)` and deleted the definition; without it a `definition` is a node of its own (an atom
that renders as the line it came from and writes back what it read) and the link mark carries
`identifier`, `label` and `referenceType`, so full, collapsed and shortcut references all survive
a save. A reference resolves to its definition's url at parse time, so the link is clickable and
the tooltip works; change the target and the link is written inline instead, so the edit lands in
the file. An image reference has no node and is inlined, as before.

**A hard break** is a bare newline inside a paragraph — what the vault contains and what
`remarkLineBreak` reads back as a break — and a literal `<br>` where a newline is not allowed,
which is inside a table row. mdast wrote a visible trailing backslash in the first case and a
space in the second, losing the break. So a `hardbreak` inside a `table_cell` or `table_header`
is written `<br>` and parses back to a `hardbreak`.

**A fenced code block** keeps the whole of its info string: ```` ```js title="a.js" {1,3} ````
comes back with everything past the language (`meta`, an attribute on the node).

**postProcess.** A literal `[text](url)` loses both halves of mdast's escape, not just the
first, so nothing is ever saved as `[text]\(url)`. `\_` between two word characters, `\#` in
front of a `#tag`, `\&` where no character reference follows and `\|` outside a table row are
all undone — every one of them a backslash mdast adds that the file never had. A table's
delimiter row is written `| --- |`, with alignment colons kept.

**Interfaces.**

```js
// stringify.js
blocks(text) -> { list: [{start, end, lines, text}], gaps: number[] }   // gaps.length = list.length + 1
reconcile(out, original, { canon })     canon: (md) => string, the editor's parse-and-serialise
lineKey(line)                           unchanged; lines.js still keys on it

// crepe.js
roundTrip(crepe, markdown, original = markdown)
   what a save would write for `markdown` against the file `original`. The two are the same
   text for open-and-save; the harness passes them apart to ask what one edit writes.

// doc.js
parseDoc(text) -> { ..., bom, eol, eols: string[], lines: string[] }
```

**Measured** (`work/vault`, batch 12): every file comes back byte for byte on open and save with
no edit — 178 of 178, against 65 of 171 before — and every one of the 50 fixtures passes, none of
them flagged `todo`. Of 4,416 one-character edits, one to each non-blank body line in the vault,
**10** changed any other line, and all ten are a fence or a `---` marker whose block stops being
that block when a character is typed into it. Nothing spreads out of a table, a list or a line of
prose any more, and no edited line gains a backslash: 0 of 4,416, against 189. Before the block
engine: 1,064 of 4,387, and 23,531 collateral lines against 133. The file counts move between
runs because scratch pages come and go.

**The harness** (`/src/editor/harness.html`, `npm run dev`) has two columns and three runs.
`run all` opens and saves every file in the vault with no edit: **bytes** compares the file byte
for byte and is the column that fails; **lenient** is the batch-9 comparison through `norm()`,
kept only so the two numbers together say what the old column was hiding. `run edits` appends
one character to every non-blank body line in the vault, one at a time, and counts the lines
that changed other than that one; it compares whole *files*, through `composeDoc`, so the BOM,
the final newline and every line's own ending are part of the measurement and the vault's ten
CRLF files are swept with their endings intact. `run edits (batch 9)` is the same sweep through
the previous engine, which is how the two columns above were measured by one instrument.
Fixtures cover each numbered finding of the batch-12 markdown research by name; a fixture for a
finding that is not fixed yet is marked `todo` and counted apart, and none carries the flag
today — a fixture that passes belongs in the column that fails.

## Round five (2026-09-16): tabs, dashboard, Informatique

Kernel 0.4.0 → 0.5.0. The plan is the artifact "Tabs, dashboard, Informatique". Packages R1 (rice), E (editor), MJ (judge), MU (module interface), P (media pages), A (adversarial), QA-5.

### The NSI judge, round five: one kind

The judge had three kinds of problem — `code`, `written`, `qcm` — and a checker registry to
dispatch on them. There is one kind now. Every problem is a folder with a statement, a Python
answer, a correction and, when there is something to run, `tests.py`; `has_tests` is the only
fork left. With a non-empty `TESTS` the judge runs the cases and the verdict is its own. With
an empty or missing one, `submit` hands back the correction and the user grades themselves,
which is what `written` used to mean; `selfgrade` is now valid for every problem, because a
suite that passes is not the same thing as an answer you are happy with. `qcm` is gone with no
replacement: a folder whose `meta.kind` is `qcm` is skipped at load with one line on stderr.

The loader reads a meta whose `kind` is missing, `code`, or still `written` as the same thing.
`convert` is the one-off that ends the ambiguity: `reponse.md` becomes a comment block in
`solution.py`, `meta.kind` becomes `code`, `correction.md` stays, state and log are untouched.
It is idempotent, `--dry` says what it would do, and it refuses a `qcm` with a reason.

Output, for a module written against it: a `list` row drops `kind`, `difficulty` and
`concepts` and gains `has_tests`. `detail` drops `kind` and `difficulty` and gains
`has_tests`, `folder`, `enonce_path`, `tests_path`, `correction_path` and `correction_format`
next to `answer_path`, all relative to the data root and all given whether or not the file
exists yet. `meta` is still handed over whole: `difficulty` and `concepts` in an old meta are
read and ignored, never rejected, and `create` never writes `difficulty` again. The `create`
spec is `{ title, chapter, source, function, params }` with `function` and `params` optional —
a problem is often written down before anyone knows what the function will be called — and it
always writes the five files, `tests.py` among them with an empty `TESTS`.

`submit --selections` is gone with the QCM. `--data-dir`, `migrate`, the scheduler and the
ASCII-safe one-object-on-stdout protocol are unchanged.

### The rice: tabs, a home, a sidebar that folds (R1)

The stock rice grew a tab strip, a dashboard and a fold control, and lost its views section and
its empty-surface command. None of it is in the kernel: the kernel gained exactly two additive
fields and one additive option, both above, and still knows no view, no module and no file name
of the rice.

The app no longer opens on the kernel's empty surface. It opens on the dashboard — the home
tab, one card per module — which is a view of the rice like any other. This is not a startup
*route* returning (batch 2): nothing the user was last looking at is restored, tabs included.
It is a home with nothing in it but what is installed, and the user still picks.

Ctrl+W is `tab.close` rather than `page.close`; the editor's `page.close` is still registered
and ends at `route.close()`, which is the event the strip acts on, so from the palette it too
lands on the next tab, never on the empty surface (QA-5 measured it). Ctrl+Shift+T is `tab.reopen`, which prefers the strip's own closed list and falls
back to the kernel's. `app.start` is gone; `app.home` replaces it.

### The code editor (E)

`codeEditor` was round four's, and round five found it in three states no one had looked at
outside a page.

**Colour.** `code.js` names a token class on every span (`os-t-key`, `os-t-str`, …) and
`code.css` painted them — under `.ed .milkdown .milkdown-code-block`, and nowhere else. Inside
a page a fence was in the full palette; a `codeEditor` in a module's panel was one colour of
grey, classes and all. The seventeen rules now carry both grounds, grouped selector by
selector rather than copied, so the two can never drift: `.ed-code` gets exactly what the
page's code block gets, both themes, every class, measured. Source mode's own markdown
highlighter is registered as a fallback and stands down while `HIGHLIGHT` is present, so there
was never a fight over the colour of a token — only the absence of one.

**Shape.** A `codeEditor` filled its box and scrolled inside it. That is right for a pane
whose height the caller owns, and wrong for a script sitting in a column of other things,
where it means a scrollbar inside a scrollbar and a guess at how tall the file is. `grow: true`
is the other shape: the editor is as tall as its text, the column scrolls, and there is a
floor of five lines so an empty file is still something to aim at. `fill` stays the default,
so nothing that already called this changes meaning by standing still.

**Comforts.** Writing a program is not writing a page, and the standalone editor had exactly
the extensions source mode has, which is the set that suits prose. It gains `closeBrackets`,
`indentOnInput` and `highlightActiveLine`, and `closeBracketsKeymap` is raised with
`Prec.high` so Backspace between an empty pair deletes both halves — `appendConfig` puts an
extension *after* the configuration it is added to, and at equal precedence the default
keymap's Backspace would have won and left the closing bracket behind. The stripe under the
caret is `--bg-3`, not CodeMirror's own `#cceeff44` and `#99eeff33`: no hex reaches the screen,
and `--bg-3` rather than `--bg-2` because in dark `--bg-2` is a point of luminance away from
`--bg` and a module's panel may be `--bg-2` already. None of this is added to source mode
inside a page.

**Enter and Tab in a dialog.** Asked and answered: a `codeEditor` inside an overlay keeps
both. `keys.js` matches no bare Enter, and every Enter handler in `dialog.js` is bound on the
element that owns it — an input, an OK button — never on the box. `openOverlay`'s focus trap
only acts when focus is on the first or last tabbable thing in the box, and CodeMirror's
`.cm-content` carries no `tabindex`, so it is never either. Ctrl+S and Ctrl+F were a different
story: the shell's capture listener took them before any editor saw them, which is what
`OWN_EDITOR_KEYS` in `keys.js` now stands down for, over `.ed-code` and not `.cm-editor` so a
fence inside a page still saves the page. The editor catches the last case itself — CodeMirror
binds its keymap on `.cm-content` and the Find panel is a sibling of it, so a Ctrl+S typed in
the search field reached nothing at all.

**What `save()` and `close()` promise.** The adversarial pass found five ways for this editor
to lose text, and four of them were one sentence: `save()` used to resolve true meaning "the
caller may move on", and answered true from a conflict the user had cancelled, from a
read-only editor holding changes, from an editor whose file never loaded, and from a write
that finished after the user had typed again. It now resolves true to one question only —
**is there anything left unwritten** — and `close()` is built on that answer: it saves once,
and when it could not, it asks its own question ("Not saved", Cancel or lose them) rather than
putting the changed-on-disk question back up, and resolves false when the user kept editing.
The rest were the same bug wearing different clothes: the file load was undo step one, so two
Ctrl+Z emptied the buffer and the next save wrote nothing to disk; `setText()` marked nothing
dirty, so the save after it wrote nothing; a file deleted underneath froze the editor
read-only with the only copy of the text inside it; and a CRLF file was rewritten to LF whole
on the first keystroke. All five are regression-tested in `work/e/regress.js`.

### The drills fix (K): what the kernel owes a page that keeps a clock

Six reviews of the two drill modules found the same shape of bug over and over — a page goes
on running after the user has left it — and half of the cause was the kernel's. A view's or an
owned route's `unmount` now carries three promises, written out in docs/KERNEL.md. **It is
awaited**: the router waits for it the way it has always waited for the editor's `close()`, so
a last write finishes before the next page mounts; a throw is caught and logged and the next
mount still proceeds. **It runs on the unload of its module**: `ose.modules.unload(id)`
unmounts the page before `deactivate` — until now the page stayed on screen with its interval
firing on a module the settings list already called disabled, and its teardown then threw on a
facade that was already empty, losing the unsaved buffer behind the throw — and leaves the
column on nothing, which the rice turns into its own home. **It runs when the window closes or
reloads**: the `closing` notice and `pagehide` (the host's Ctrl+R and the update's relaunch
both navigate the web view; a browser reloads the document) unmount what is on screen and then
flush the state file. The editor is left to its own `closing` subscriber, which saves and may
veto; running its close twice would ask the changed-on-disk question against its own write. On
the unload path nothing can be awaited, so only the synchronous half of an `unmount` is
certain to be written — which is why the drills contract has a page bank its clock every ten
seconds as well as on the way out.

A fourth rule, from the same reviews: **a module's `shortcut` never takes a chord the kernel's
own keymap holds.** Installing Informatique used to move Ctrl+Shift+N from `tree.new-folder`
to `nsi.next`, app-wide and silently, and the sidebar then printed no chord for the command it
had lost. The kernel keeps the chord, the module's command keeps none, and the console says so
once, naming both. The rice is not a module: `keys.json` wins as it always did, and a rice
command may still replace a default, which is what `tab.close` does to `page.close` on Ctrl+W.

And three smaller repairs behind the same door. The dialogs focus with a task instead of a
frame: a window that is not compositing never runs a `requestAnimationFrame` callback, so a
rename prompt opened while Ose was in the background came up with the focus still on the row
behind it and everything typed into it went nowhere. Escape in the standalone code editor
leaves the text and puts the keyboard on the page around it (with the search panel open it
still closes the panel first), because the only way out of a module's editor was a command.
And two colours: `meta` — Python's decorator, a shebang, a doctype — is no longer painted with
the comments, and the caret is `--fg` rather than the accent, which was 2.94:1 on the light
ground under a 3:1 floor.
