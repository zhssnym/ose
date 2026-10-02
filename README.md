# Ose

Ose is a small desktop markdown editor for a folder of plain files on your own machine. It is built for working alongside AI agents like Claude Code: your notes stay ordinary markdown files that an agent can read and edit directly, and Ose shows the changes as they happen.

## Why

Agents work best with plain local files, with no API, export or plugin in between. Plain files alone are not enough for daily use, though: you still want an app that shows pages as documents and lets you move through folders comfortably. Ose is that app, and nothing more. It is deliberately minimal, with no plugins, no sync and no accounts.

## Features

**The editor.** Pages look like printed documents rather than web pages. Each page is edited in one of two modes: **Rich**, where you write as in a word processor, or **Source**, the raw markdown as in a code editor. Formulas between dollar signs render as real maths, tables and code blocks are drawn properly, and a page can be laid out as A4 sheets and exported to PDF. Line endings and formatting are always preserved: Ose never rewrites a part of a file you did not edit.

**The file manager.** Every folder is a page of its own, listing what is in it, like Explorer or Finder. Folders come first, then everything by name. Tabs, back and forward, Go to file (Ctrl+P), the command palette (Ctrl+Shift+P) and full-text search get you anywhere quickly.

**Nothing typed is lost.** Unsaved text is kept as a draft until it reaches the file. When an agent or another program changes a file you have open, Ose merges the change into your page line by line, and asks only when you both changed the same lines.

**Journal, systems and monthly view.** Built-in views over ordinary files whose paths you choose once in the settings. They write back one line at a time, so the files stay readable and editable by anything else.

## Your folder stays yours

Ose writes nothing into your folder except your own pages. Its settings, the history of your files and any unsaved drafts live in the app's own folder on your machine. A deleted file goes to the Recycle Bin or Trash. The folder can be synced with Google Drive, OneDrive or anything else, and opened from several computers.

## Install

Download the latest release from the [releases page](https://github.com/zhssnym/ose/releases/latest): `Ose_<version>_x64-setup.exe` for Windows, `Ose_<version>_aarch64.dmg` for a Mac with Apple silicon. The builds are not signed with a paid certificate, so the first launch asks once: on Windows click **More info › Run anyway**, on a Mac open **System Settings › Privacy & Security › Open Anyway**. After that, Ose updates itself: when a new version is out, it downloads it and offers to restart.

## From source

```
npm install
npm run app          # the app, from its sources (needs Rust)
npm test             # the unit tests
```

How it is built and how each part works is documented in `docs/`.
