# Ose

Ose is like Obsidian, but made for myself, around my own taste and my aversion to extra features.

## The problem

I want my notes, my plans and my journal to be plain files in a folder on my own machine. That is what an AI agent works best with: Claude Code can read and edit markdown directly, with no API, no export and no plugin in between. But plain files alone are not enough for me. I also want an app over them, like Obsidian, that draws my files as documents and builds a few views of my own from them.

The usual way to get that app is a desktop program, and I tried it. It meant a build for Windows and another for the Mac, signing, releases to download and drop over the old one, and a Mac build that broke on its own while I was in class. The app was supposed to sit quietly next to my files, and I kept maintaining the app instead.

So Ose is a website that works like a local app. It opens a folder on my machine in Chrome, reads and writes the files in place, and after the first visit it works offline. There is one build for every computer, and an update is just a new deploy that the app picks up by itself. The files never leave my machine: the website only serves the app's own code.

## The editor

A markdown page looks like a printed document rather than a web page: Cambria, a ruled title box, compact justified text and square corners. Formulas written between dollar signs render as real maths, and a code file gets syntax colours like a small IDE. A page can be read as one scrolling column or as the A4 sheets it prints on, and it exports to PDF. It is a file manager too: one tree of the whole folder, every file under its real name, nothing hidden from me.

## The views

Ose reads some of my files and draws views over them: my day with its timetable and tasks, the week, the month's goals and review, and a journal. They are built into the app, not plugins. They read ordinary files whose paths I choose once in the settings, and they write back one line at a time, so the files stay mine and stay readable.

## The folder is the database

Everything lives in the folder as plain files. Ose keeps no database, no index and no second copy of anything. What belongs to the folder is in `.ose/`, inside it, and what belongs to this computer stays in the browser. The folder therefore syncs with Google Drive, OneDrive or anything else that syncs a folder. Any AI agent can work in it while Ose is open, and Ose picks up the changes as they happen, because they are ordinary markdown and JSON.

Ose runs in Chrome, and it can be installed from Chrome as an app with its own window. How it is built, and how each part works, is in `docs/`.
