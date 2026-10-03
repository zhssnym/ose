# Views

A view is a page of its own in the sidebar's **Views** section: Today, Planner and
Journal are the three that ship. A view is not a file: it reads ordinary files of the vault and draws them
its own way, the way the Journal turns a folder of `YYYY-MM-DD.md` files into one record. This
is how Ose is extended. There is no plugin system; you fork Ose and add a folder.

## Where they live

```
src/views/
  index.ts      registers every view (the VIEWS list) and Settings › Views
  views.css     the views' styles, tokens only
  planner/      Today and Planner: Year · Month, and Today, over the planner folder
                (index.ts reads and writes, render.ts draws the pages; Today is
                the day: the log as a heatmap, its list, the todos)
  journal/      the fullest one: the example to copy
  shared/       what views share: dates, tasks and todo files, the planner's files
                (plan.ts: a year, a month, how a day counts; plans.ts: where they are),
                prose, the settings store (where each folder is), path detection
```

## Adding one

1. Make `src/views/<name>/index.ts` exporting `create<Name>View(ose, store)`. It answers the
   view's definition:

   ```ts
   export function createKanbanView(ose: any, store: any) {
     return {
       title: 'Kanban',
       order: 50,              // where it sits among the Views rows
       icon: 'journal',        // an icon name from src/ui/icons.ts
       section: 'planner',     // the sidebar lists views of this section
       mount(el: HTMLElement, route) {
         // draw into el; route.arg is whatever was asked for, if anything
         return {
           unmount() { /* stop timers and listeners */ },
           refresh() { /* a file changed: read again and redraw */ },
         };
       },
     };
   }
   ```

2. Add it to `VIEWS` in `src/views/index.ts`. It then has a route (`{ type: 'view', name }`),
   a command in the palette (`view.<name>`), and a row in the sidebar.

3. Styles go in `views.css`, with a prefix of your own (`.kb-…`), and tokens only.

`npm run app:dev` shows it as you write it.

## What a view gets

`ose` is handed in; a view never imports the core or the shell. The parts the built-in views use:

| | |
|---|---|
| `ose.files.read(path)`, `list(folder)`, `stat(path)`, `exists(path)`, `tree()` | read the vault |
| `ose.files.appendLine(path, line)` | add one line at the end of a file |
| `ose.files.replaceLine(path, index, expected, next)` | change one line, only if it still reads `expected` |
| `ose.fileops.create(folder, name)` | make a new file, never over an existing one |
| `ose.watch(folders, fn)` | hear about changes on disk, by Claude Code or anything else |
| `ose.route.navigate(route)`, `ose.tabs.open(route)` | open a page or another view |
| `ose.state(key)` | a small setting kept for this vault, outside it |
| `ose.pickers.folder()`, `ose.pickers.file()` | let the user choose a folder or a file |
| `ose.commands.register({ id, title, run })` | a command in the palette |

The bricks to draw with come from `src/ui` (`esc`, `toast`, `loadingLine`, `confirm`, `icon`…).
`date-fns` is there for dates. The editor's markdown renderer can be loaded with a dynamic
import of `src/editor/lib.ts`, as the Journal does.

## The rules

- **Write a line, never a file.** A view appends a line or replaces one line it has just read,
  or creates a new file. It never rewrites a whole file it did not create: the user, Claude Code
  and Google Drive may all be writing to it too.
- **Never spell a vault path.** Where a view's files are is a setting (Settings › Views,
  `shared/settings.ts`), found by name the first time (`shared/detect.ts`) and confirmed by the
  user.
- **Read again on a change.** A file can change under the view at any time; `refresh()` and
  `ose.watch` are how it keeps up.
- **Tokens only.** No colour, font or size of its own: both themes come for free.

Month takes `route.arg` = 'YYYY-MM' and Year takes 'YYYY': `ose.route.navigate({ type: 'view',
name: 'year', arg: '2026' })` opens that year, which is how the two link to each other.

The formats the five built-in views read and exactly what they write are in `docs/FORMATS.md`.
