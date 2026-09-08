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

```
Ctrl+K        command palette         Ctrl+P    open page (fuzzy file search)
Ctrl+N        new page                Ctrl+S    save now
Ctrl+\        toggle sidebar
Ctrl+Shift+F  search in vault         Alt+Left / Alt+Right   back / forward
Ctrl+,        settings                Ctrl+Shift+L  toggle theme
Esc           close palette/menu
```

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
groups: 'navigate' | 'page' | 'tree' | 'view' | 'app'
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
