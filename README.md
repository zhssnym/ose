# Ose

Ose is like Obsidian, but made for myself, around my own taste and my aversion to extra features.

Ose has two main parts.

## The editor

`ose.exe` is the whole app: one file, no installer, sitting at the root of the folder it opens. It edits markdown and code files in place. A markdown page looks like a printed document rather than a web page: Cambria, a ruled title box, compact justified text and square corners. Formulas written between dollar signs render as real maths, and a code file gets syntax colours like a small IDE. A page can be read as one scrolling column or as the A4 sheets it prints on, and it exports to PDF. The editor works without a single plugin.

## The plugins

A plugin is a folder of plain JavaScript in `.ose/plugins/`, inside the vault. It reads the vault's files and draws a view over them. Mine show my day with its timetable and tasks, the week, the month's goals and review, a journal, and my maths and coding drills. A plugin has no manifest and needs no build: I edit its file, press Ctrl+R, and it reloads. It never spells a path either. It asks for a file or a folder by name, and when it cannot find one, it shows a button to choose it. `docs/PLUGINS.md` is the whole contract.

## The vault is the database

Everything lives in the vault as plain files. Ose keeps no database, no index and no second copy of anything, and its only state is `.ose/state.json`. The vault therefore syncs with Google Drive, OneDrive or anything else that syncs a folder. Any AI agent, Claude Code for example, can work directly in the files, because they are ordinary markdown and JSON. The same agent can write a new plugin in a few minutes for a workflow over files I already have, since a plugin is one folder written against one short document.

The latest build is `ose.exe` on the Releases page. How to build it, and how each part works, is in `docs/`.
