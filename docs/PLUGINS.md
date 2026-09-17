# Ose plugins

Ose is one file, `ose.exe`: an editor for the markdown and code of a vault, with a sidebar, tabs,
search and settings. Nothing about it lives in the vault.

A plugin is local code inside the vault, under `.ose/plugins/`, that performs one operation over
the vault's files and draws it as a view inside Ose. With no plugins Ose is still a complete
editor. The moment a plugin is in the folder it is loaded, listed in the sidebar under
**Plugins**, given a card on the home page, and listed in **Settings › Plugins** with its state,
its error if it has one, and the paths it needs.

This file is the whole contract (`ose.api = 2`). It is written for whoever writes the next
plugin, human or agent. `docs/KERNEL.md` lists every call on `ose`; `docs/DESIGN.md` is the look.

## Where a plugin lives

```
<vault>/.ose/
  plugins/
    week.js              a single-file plugin: the id is `week`
    maths/               a folder plugin: the id is `maths`
      index.js           required: the entry
      style.css          optional: linked automatically while the plugin is active
      ...                anything else the plugin ships: more .js, a Python judge, a README
    _lib/                not a plugin: plain files several plugins share
  state.json             window, theme, and under `plugins.<id>` each plugin's state and paths
```

- The id is the folder name, or the file name without `.js`: `[a-z0-9-]+`.
- An entry whose name starts with `_` or `.` is never loaded. `_lib/` is where shared files go;
  a plugin imports one as `../_lib/<file>.js`.
- There is no manifest, no list of plugins anywhere, and no version number on a plugin. What is
  in the folder is what is loaded. Plugins are not shipped inside the app.

## The entry

```js
// .ose/plugins/hello/index.js
export const name = 'Hello'                                  // optional; the id when absent
export const description = 'Counts my journal entries.'     // optional; one line, shown on the card

export const paths = {                                       // optional; what it needs from the vault
  journal: { folder: 'journal', hint: 'One file per day, named YYYY-MM-DD.md.' },
}

export function activate(ose) {                              // required; may be async
  ose.views.register('hello', {
    title: 'Hello', order: 70,
    async mount(el) {
      const dir = await ose.paths.get('journal', { el })     // the path, or null with Choose drawn in el
      if (!dir) return
      const rows = await ose.files.list(dir)
      el.textContent = `${rows.length} entries in ${dir}`
    },
  })
}

export function deactivate() {}                              // optional
```

`activate` runs at boot, after the shell exists, and must be cheap: registrations and
subscriptions only. Everything registered through the `ose` it was handed is taken back by the
kernel when the plugin is unloaded, and processes it started are killed; `deactivate` only has to
undo what the plugin put in the document by itself.

## What `activate` receives

The full `ose` object, the same one the shell uses (docs/KERNEL.md): `files`, `watch`, `run`,
`schedule`, `route`, `commands`, `views`, `tiles`, `status`, `keys`, `settings`, `bus`, `store`,
`search`, `links`, `theme`, `pages`, `focus`, `window`, `toast` and the rest. There is no
permission wall: a plugin reads and writes anywhere in the vault and may run any program. It is
the vault owner's own code.

Four things on it are the plugin's own:

| | |
|---|---|
| `ose.plugin` | `{ id, name, folder }`. `folder` is the plugin's folder as a vault path (`.ose/plugins/maths`; `.ose/plugins` for a single-file plugin), a legal `cwd` for `ose.run`. |
| `ose.state(key)` | `{ get, set, flush }` over `plugins.<id>.<key>` in `.ose/state.json`. The key `paths` is reserved. |
| `ose.paths` | the plugin's own paths, below. |
| registrations | `commands.register`, `views.register`, `tiles.register`, `settings.section`, `keys.bind`, `bus.on`, `route.own`, `route.index`, `route.on`, `watch`, `schedule` are tagged with the plugin id so unload takes them back. Use the `ose` you were handed, never `import { ose } from 'ose:kernel'`. |

A view carries its place: `ose.views.register(name, { title, order, icon, mount, unmount })`. The
sidebar and the home page sort plugins by `order`, then by title. The stock six use 10 to 60.

## `ose.paths`: a plugin never spells a vault path

Folders get renamed and files get moved. A plugin says what it needs by name, and Ose finds it.

Declared in the `paths` export, one key per thing:

```js
export const paths = {
  calendar: { file: 'calendar', hint: 'One H1 per weekday, one line per block.' },   // calendar.md
  reports:  { folder: 'reports', hint: 'One folder per year, one file per month.' },
  log:      { file: 'systems', ext: 'jsonl', hint: 'Append-only check log.' },        // systems.jsonl
}
```

`file` or `folder` is the name to look for. `ext` defaults to `md`. `hint` is one sentence on what
the thing must contain; it is shown when the thing is missing and in Settings. `label` is
optional and defaults to the key.

Resolved in this order, the first that answers wins:

1. the path chosen before (saved under `plugins.<id>.paths.<key>`), if it still exists;
2. the one file or folder in the vault whose name is exactly the name asked for;
3. the one whose name contains it;
4. nothing: the path is `missing`, or `ambiguous` when step 2 or 3 found several.

Matching ignores case. Hidden entries (dotfolders, what the tree hides) are never candidates.
"The one" means exactly one: two candidates are never guessed between.

| call | answers |
|---|---|
| `await ose.paths.get(key, { el })` | the vault-relative path, or `null`. With `el`, a `null` also draws the standard box into `el`: what is missing, the hint, the candidates as buttons when the match was ambiguous, and **Choose…**, which opens the vault picker. A choice is saved and the route on screen is mounted again. |
| `ose.paths.peek(key)` | the last resolved value, synchronously, or `null`. |
| `await ose.paths.choose(key)` | opens the picker; the new path, or `null` on cancel. |
| `ose.paths.reset(key)` | forgets the saved choice. |
| `ose.paths.list()` | `[{ owner, key, kind, name, ext, label, hint, path, saved, status }]`, `status` one of `ok`, `missing`, `ambiguous`; `kind` is `file` or `folder`. |
| `ose.paths.on(fn)` | `fn({ owner, key, path })` when a choice is made or reset; answers an unsubscribe. |

A thing that lives inside a resolved folder is derived from it, not declared again: the systems
log is `<reports>/systems.jsonl`, a plugin's own dotfolder is `<data>/.math/`.

The content format is the contract that stays. A parser needs `# Lundi` or `- [ ]` to be there;
the format is documented where the file is (the top of the calendar, the reports README), and
the location is a setting.

## Loading, errors, reload

- Boot: the shell calls `ose.plugins.load()` once. The loader lists `.ose/plugins`, imports each
  entry from the app origin (`/plugins/<id>/index.js` or `/plugins/<id>.js`), declares its
  `paths`, links its `style.css` if there is one, and calls `activate`. Plugins load
  independently and concurrently.
- A plugin that throws on import or in `activate` is disabled for the session: whatever it
  registered is taken back, a toast names it, and Settings › Plugins shows the error. The rest of
  Ose is unaffected.
- Ctrl+R (`app.reload`) reloads the page and therefore every plugin from disk. Editing a plugin
  is: save the file, Ctrl+R.
- `ose.plugins.list()` answers `[{ id, name, description, state, error?, single, views }]`,
  `state` one of `active`, `disabled`; `views` is what the plugin registered, `[{ name, title,
  order }]`. `ose.plugins.unload(id)` takes one down.

## Rules

1. Import only `ose:ui`, `ose:editor`, `ose:md` (dates, `firstH1`, `naturalCompare`,
   frontmatter, JSONL: nothing about any particular file), files in the plugin's own folder, and
   `../_lib/`. Never another plugin's folder. Plugins talk through `ose.bus` and commands.
2. Never spell a vault path. Declare it in `paths`, ask `ose.paths.get`. State a plugin keeps
   beside its data goes in a dotfolder of the data folder (`drills/math/.math/`).
3. Draw only into the element you are handed (`mount(el)`, a tile's `render(el)`), with the
   tokens of `ui.css`: no hex value, no bare pixel padding. Prefix every selector of `style.css`
   with one class of your own; the stylesheet is global while it is linked.
4. Every action is a command with a title in plain words; a chord goes in `shortcut`. Nothing
   needs the mouse. Both themes, every time.
5. A page that counts time banks on a timer as well as in `unmount` (docs/KERNEL.md, the three
   guarantees).
6. No dependency at runtime. Scripts a plugin runs (Python, Node) live in its folder and are
   started with `ose.run(program, args, { cwd: ose.plugin.folder })`.
7. Data formats are ones a person and an agent can read: markdown for content, `.json` for
   machine state, `.jsonl` append-only for history. Never rewrite a file the user did not edit
   through you, and never reformat the part of a file you did not change.
8. English interface; file content in whatever language it is in.

## Starting a new one

Copy `plugins/_template/` from the Ose repository into `.ose/plugins/`, rename the folder, press
Ctrl+R. The template registers one command, one view that asks for one path, and one tile.
