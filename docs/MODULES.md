# Ose modules

A module is a folder under `.ose/app/modules/<id>/` with a manifest and an entry. It adds a
workflow to Ose by registering commands, a view, tiles, routes and a settings section through
the hoses (docs/KERNEL.md), and it operates on data that stays where it is in the vault. Native
only: no server, no port, no frame. A module keeps no data anywhere but the vault folders its
manifest names.

This file is written for whoever writes the next module, human or AI. The vault's CLAUDE.md
points here.

## Manifest: `module.json`

```json
{
  "id": "nsi",
  "name": "NSI trainer",
  "requires": 1,
  "entry": "index.js",
  "data": ["2-learning/1-school/2-nsi"],
  "run": ["python"],
  "routes": ["nsi/*"],
  "view": { "name": "nsi", "title": "NSI", "order": 40 },
  "description": "Problems as folders, a judge, spaced review."
}
```

- `id`: folder name, lowercase, `[a-z0-9-]`. `requires`: the `ose.api` it was written for.
- `data`: vault-relative folders the module may read and write (its own state files included,
  beside the data). Anything else rejects. Empty means read-only access to the whole vault and
  no writes.
- `run`: program names the module may start through `ose.run`. Empty means none.
- `routes`: patterns the module owns (`ose.route.own`); pages under them get history, the
  window title and quick open.
- `view`: optional; the module registers it in `activate` anyway, this is for the sidebar order.

## Entry: `index.js`

```js
import { markdownPage, codeEditor } from 'ose:editor'
import { toast } from 'ose:ui'

export async function activate(ose) {
  // ose is the facade scoped by module.json. Register, subscribe, return.
  ose.commands.register({ id: 'nsi.next', title: 'NSI: next problem', group: 'nsi',
    shortcut: 'Mod+Shift+J', run: () => ose.route.navigate({ type: 'own', path: 'nsi/' + pickNext() }) })
  ose.views.register('nsi', { title: 'NSI', mount: mountIndex })
  ose.route.own('nsi/*', mountProblem)
  ose.tiles.register({ id: 'nsi.due', title: 'NSI', render: renderTile })
  ose.watch(['2-learning/1-school/2-nsi'], () => ose.tiles.refresh('nsi.due'))
}

export function deactivate() { /* processes and subscriptions are released by the kernel */ }
```

`activate` runs at boot after the shell exists. It must be cheap: registration and
subscriptions only; no process, no network, no heavy read. A module that throws in `activate`
is disabled for the session, named in a toast and in settings, and the rest of Ose is
unaffected. Everything registered through the facade is removed automatically on
`deactivate`, on vault change and on quit; processes a module started are killed.

## Lifecycle

- Boot: `ose.modules.load()` reads every `modules/*/module.json`, checks `requires`, imports
  the entry from `app.localhost/modules/<id>/<entry>`, calls `activate`.
- On demand: a process runs when a command asks and exits when done
  (`ose.run('python', ['-m', 'judge.cli', 'submit', id], { cwd, timeout: 60000 })`). A long
  command reports lines through `onLine` and the command shows progress in the status bar.
- Events: `ose.watch(folders, fn)` for changes under the module's data; `ose.bus` to talk to
  other modules; `ose.route.on` to react to navigation.
- Schedules: `ose.schedule(id, { every: 'day', at: '07:00' }, fn)` runs while the app is open
  and catches up once at boot when a run was missed. Nothing runs when Ose is closed.

## Rules

1. Import only `ose:*` and files inside the module's own folder. Never the rice, never another
   module. Modules talk through `ose.bus` and commands.
2. Read and write only under `data`. Keep module state (a `state.json`, a `log.jsonl`) beside
   the data it describes, in a dotfolder if it should stay out of the tree (`2-nsi/.nsi/`).
3. Draw only into the elements the kernel hands you (`mount(el)`, `render(el)`), with tokens
   from `ui.css`; a module stylesheet is imported from its own folder. Never touch the sidebar,
   the palette or the DOM outside your root.
4. Every action is a command with a title in plain words; chords through `shortcut`, the
   palette lists them, the menu draws them. Nothing needs the mouse.
5. Both themes. Keyboard reachable. English UI; file content in whatever language it is.
6. No dependency at runtime: a module ships its own code. Scripts the kernel runs (Python,
   Node) live inside the module folder and are called by name from `run`.
7. Data formats are prose and JSONL a person and an agent can read: markdown for content,
   `meta.json`/`state.json` for machine fields, `log.jsonl` append-only for history.

## Template

`cockpit/modules/_template/` in the repository: a manifest, an `activate` that registers one
command, one view with a `render` of a markdown file, one tile that counts files under `data`,
one settings section with one switch, and a `README.md` that says what to change. Copy it,
rename the id, and the module runs.
