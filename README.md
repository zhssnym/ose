# Ose

Ose is a markdown editor in the spirit of Obsidian, built around a small, opinionated set of features. It runs in Chrome over a folder on your own machine, works offline, and keeps everything as plain files.

## Why

AI agents like Claude Code work best with plain local files: they can read and edit markdown directly, with no API, export or plugin in between. Plain files alone are not enough for daily use, though. You still want an app over them that renders pages as documents and builds views from them, the way Obsidian does.

That app is usually a desktop program, which brings its own maintenance: a build per operating system, code signing, releases to download and install, and platform-specific bugs. Ose avoids all of that by being a website that behaves like a local app. It opens a folder on your machine through Chrome's File System Access API, reads and writes the files in place, and works offline after the first visit. There is one build for every computer, and an update is simply a new deploy, picked up automatically. Your files never leave your machine: the site only serves the app's own code.

## Features

**The editor.** Markdown pages look like printed documents rather than web pages: Cambria, a ruled title box, compact justified text and square corners. Formulas between dollar signs render as real maths, and code files get syntax highlighting. A page can be read as one scrolling column or as the A4 sheets it prints on, and exported to PDF. Each page can be edited in Rich, Live or Source mode, and line endings and formatting are always preserved.

**The file manager.** One tree for the whole folder, a view for every folder, and every file listed under its real name. Nothing is hidden by name.

**Built-in views.** Day (timetable and tasks), Week, Month (goals and review) and Journal read ordinary files whose paths are chosen once in the settings. They write back one line at a time, so the files stay readable and editable by anything else.

## The folder is the database

Everything lives in the folder as plain files. Ose keeps no database, no index and no second copy of anything. Vault settings, pins and file versions go in `.ose/` inside the folder; per-machine state (open tabs, recent files, unsaved drafts) stays in the browser. The folder can be synced with Google Drive, OneDrive or anything else that syncs a folder, and an AI agent can work in it while Ose is open: changes made on disk show up as they happen.

## Getting started

Open the site in Chrome, choose a folder, and pick "Allow on every visit" so it opens again without asking. From Chrome's menu, Ose can be installed as an app with its own window.

To run it from source:

```
npm install
npm run dev      # http://localhost:5173
npm test
```

How it is built and how each part works is documented in `docs/`.
