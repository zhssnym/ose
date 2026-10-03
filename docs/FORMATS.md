# File formats

Ose keeps no database. Every note is a plain file, and the views (Execution, Planner and Journal)
are built out of a handful of ordinary markdown files. This document
is the contract for those files. An agent such as Claude Code, run on the vault from outside,
reads it to know how to write a file that the app will read, and what the app writes back.

The code is in `src/views/`: `planner/` (Execution and Planner: `render.ts` draws the Year, Month
and Execution pages, `index.ts` reads and writes), `journal/`, and `shared/` for the readers
they share, named for what they hold: `plan.ts` (a year, a month, and how a day counts),
`plans.ts` (where the year and month files are), `tasks.ts` and `todo.ts` (todo lines),
`settings.ts` and `detect.ts` (where the folders are). The journal's format is read in
`journal/index.ts`.

## Where the files are

Settings › Views holds two paths. They are stored under `planner` in the vault's state, which
the app keeps on this machine (`<app data>/vaults/<vaultKey>/state.json`, see docs/HOST.md), not
in the vault. A vault that still has a `.ose/state.json` from an older Ose is read from there
until the app first writes its state:

| Setting | Stored as | Kind | Read by |
|---|---|---|---|
| Planner folder | `reports` | a folder | Execution, Planner |
| Journal folder | `journal` | a folder | Journal |

The planner folder holds everything about planning: the year and month files and `todo.md`
(the one todo list). It is stored under its old key, `reports`, so a vault's stored choice
keeps working. There is no calendar file and no log: a month carries its week and its days.

The first time the app opens a vault, it looks for these by name and shows what it found:

- names are compared without case and without a leading number, so `4-journal` is a journal
  folder and `1-general-todo.md` is a todo file;
- the planner folder is the folder that holds `execution.jsonl` (or `systems.jsonl`), or else one named `planner`,
  `plannings`, `planning`, `plans`, `reports`, `report`, `monthly plans` (or `monthly-plans`)
  or `execution`;
- the journal folder is one named `journal`, `journals`, `journaling` or `diary`;
- when several match, the shallowest wins.

The views use what was found straight away, and say in one quiet line that the paths were
found automatically. Until "These look right" confirms them, each start fills in any path that
is still empty; "Detect again" does the same on demand. A path that is set, found or chosen by
hand, is never replaced by detection. When a planner file is renamed or moved, in the app or
outside it, the setting follows it.

A vault that used the old day, week, month and journal plugins keeps its choices: the first
time, the paths saved under `plugins.<id>.paths` and the journal mode are copied into
`planner`, and left where they were.

The journal mode (full or compact) is kept in the same place.

## Todo lines

The Obsidian Tasks syntax. One task per line, anywhere in the file, nested with a tab or two
spaces per level:

```markdown
- [ ] Renew the passport 📅 2026-10-01 ⏫
  - [ ] Photos
- [x] Pay the rent ✅ 2026-09-25
```

| Marker | Meaning |
|---|---|
| `📅 YYYY-MM-DD` | due |
| `⏳ YYYY-MM-DD` | scheduled (used when there is no due date) |
| `🛫 YYYY-MM-DD` | start |
| `✅ YYYY-MM-DD` | done on |
| `➕ YYYY-MM-DD` | created |
| `🔁 text` | repeats |
| `🔺` `⏫` `🔼` `🔽` `⏬` | priority, highest to lowest |

A marker followed by something that is not a date carries no date. For example, `(due _gap:
not set_)` written as plain words is just part of the task's text.

**What Day shows**, for the day on screen, file by file:

- the open tasks that are late;
- the tasks due that day;
- the tasks with no date.

**What Day writes.** Each write is one line, and nothing else in the file changes.

- **Ticking a task** replaces exactly that line with `ose.files.replaceLine(path, index,
  expected, next)`. The host replaces it only if the line still reads what was on screen.
  Otherwise nothing is written, the view re-reads, and it says "The todo file changed;
  reloaded."
  - Done turns `[ ]` into `[x]` and adds `✅ <today>` when the line has no done marker.
  - Undone reverses both.
  - The file's line endings are kept.
- **A new task** from the Execution page's foot line is appended to `<planner>/todo.md` (made with `# Todo` the
  first time) as
  `- [ ] <text>`, exactly as typed, markers included. It is written with
  `ose.files.appendLine`, and the host adds the line break the file needs.

## The planner

The planner folder holds one file per year, one per month, and `todo.md`. Everything is
markdown: there is no log and no calendar file. Months written before September 2026 keep their
older shape (goals, then a review); the pages show them as text and never convert them.

```
<planner>/
  YYYY.md       a year: what it is for, its goals, its review
  YYYY-MM.md    a month: its goals, its execution, its log (a row per day), its review
  todo.md       the todo list
```

H1 headings and body text only, `-` bullets; no H2.

**Where a file is found**

- Flat in the planner folder (`plannings/2026-10.md`), or in a year folder
  (`plannings/2026/2026-10.md`). Flat is looked at first and wins.
- A month is any `.md` name starting with the month (`2026-10 October.md`); a digit right after
  it is another date, so `2026-10-12.md` is not October. The exact `2026-10.md` wins.
- A year is `2026.md`, or a name starting with the year and a space, or with the year, a dash
  and `year`. A month is never the year file.

### A month: `YYYY-MM.md`

Four H1 sections after the title, in this order: Goals, Execution, Log, Review.

```markdown
# October 2026

Why this month matters, in a paragraph. Optional.

# Goals

Educational

- [ ] Maths: 17 or more at the DS

Personal

- [ ] In bed by 23h00, six nights out of seven

# Execution

Lundi

- School
- Maths
- NSI
- Lecture
- Sleep

Mardi

- School
- Maths
- Sleep

# Log

| Day    | School | Maths | NSI | Lecture | Sleep |
|--------|--------|-------|-----|---------|-------|
| 01 jeu | x      | x     | .   | x       | x     |
| 02 ven | x      | .     | x   | x       | x     |
| 03 sam |        |       |     |         |       |

# Review

_gap: written at the end of the month_
```

**The title** is the first H1; its text is free, the month comes from the file name. Prose under
it is the intro.

**`# Goals`**, what the month is for:

- A line holding one word is an area: `Educational`, `Financial`, `Personal`.
- `- [ ] text` is a goal, `- [x]` once it is met. A plain `-` bullet is a goal nobody ticks.
- The month's one figure is its goals ticked over its goals with a box.

**`# Execution`**, what each day holds, in the order it is done, and nothing about the hour:

- A weekday label (`Lundi` … `Dimanche`, or in English, with or without accents) and under it
  one bullet per thing, in doing order. Every day of the week is listed on its own.
- An item is its own column in `# Log`, by its words compared without case or accents:
  `- Maths` is the column `Maths`. Brackets at the end name another column when the words are
  long: `- Histoire-géo, composition [HG]`.
- A label may name several days (`Mardi, Jeudi`, `Lundi à Vendredi`), and bullets above the
  first label are for every day. An item may carry its own days: `(lun-ven)`, `(sam, dim)`.
- A time or a place written in a line (`17h20 à 19h00 Maths · BU Sciences`) is read and set
  aside; the pages never show it.
- Any other prose is ignored.
- `# Execution` runs from the 1st of the month. `# Execution from YYYY-MM-DD` is a whole
  execution that takes over on that day (the holidays) and runs until the next one, or to the
  end of the month. The days before it keep the one they had. There are no alternating weeks.
- The older name `# Week` reads the same.

**`# Log`**, what was done, a row per day, made empty when the month is started:

- The header names the columns: `Day`, then one per item of the execution.
- The first cell is the day of the month and its weekday for the reader, `03 sam`; only the
  number is read.
- A cell holds `x` done, `.` due and not done, `-` dropped on purpose that day (counts for
  nothing), or nothing.
- An older table may end with a `Note` column; it is kept as it is and is not an item. New
  months have none.
- An item added during the month gets a new column at the right end; a column is never removed
  or renamed during the month.
- The older name `# Days` reads the same.

**`# Review`** (or `# Monthly Review`) is a paragraph written at the end of the month; until then
`_gap: written at the end of the month_`. The app shows it and never writes it.

### A year: `YYYY.md`

```markdown
# 2026

What this year is for.

# Goals

Educational

- [x] Pass the bac de français

# Review

_gap: written at the end of the year_
```

Goals and Review read as a month's. The Year page is this file alone: its goals, its review, and
one figure, the goals ticked over the goals with a box (2 of 10 ticked is 20%). Nothing on it is
computed from the months.

### How a day counts

The log's figures on the Execution page come from these five rules (`src/views/shared/plan.ts`); the goals' figure
on Year and Month is only their boxes ticked.

1. An item is **planned** on a day when the execution in force that day lists it for that
   weekday.
2. It is **due** when its cell is `x` or `.`, or when it is planned and the cell is empty; never
   when the cell is `-`.
3. It is **done** when its cell is `x`, planned or not.
4. A month counts from its first marked day. From there every past day counts in full, a day
   with no mark included. Today counts only what is done; days to come count nothing.
5. The **rate** is done over due, for a day or a month of the log. At the end of each heatmap
   row, what the item has **lost** is its missed days over all its due days of the month (done,
   missed and still to come); under the heatmap the month is the same three, done, lost and
   open, as whole percentages that add up to 100. An item's
   **run** is its due days done in a row, back from today, across months; a day it is not due,
   a `-` and today still open do not break it.

### What the pages write

- **A mark** (Execution: a click on the day's list ticks and unticks, Shift+click or `s` drops
  for the day; the heatmap is only to look at) replaces that day's row with `ose.files.replaceLine`, only if the row still reads what
  was on screen; otherwise the file is read again and the write tried once more. The first mark
  of a day writes `.` under everything planned that day, then the mark, so the row says by
  itself what was due. Every cell is padded to its header's width.
- **A goal** ticked on the Month or Year page replaces its line the same way.
- **Start <month>** on a month with no file creates it (`ose.fileops.create`, never over a
  file), in the same layout as the last month that has one: its goals unticked, the execution
  in force on its last day as `# Execution`, `# Log` with an empty row per day and a column per
  item in the order the week meets them, and the review's gap line.
- **Start <year>** creates `YYYY.md`: the title, the previous year's areas, the gap line.

## Journal files

One file per day in the journal folder, named `YYYY-MM-DD.md`. Anything after the date is
allowed (`2026-09-26 - Journal.md`), and the date always comes from the name, never from the
heading.

```markdown
# 2026-09-26 - Journal

What happened today.

---

A second thought, later the same day.
```

- The first line, when it is `# … - Journal` or a bare date, is the file's own heading. The
  record drops it.
- A standalone `---` line separates two thoughts written the same day.

**What the app writes.** "Write today" (Ctrl+Shift+J, `journal.today`) opens today's file in the
editor.

- When the file is not there, it is created with an exclusive create
  (`ose.fileops.create`), holding `# YYYY-MM-DD - Journal` and a blank line. It never
  overwrites anything.
- When a file dated today already exists under another name, that file is opened instead.
- When the journal folder is not there (renamed or moved while the app was closed, say), it
  is not made again under the old name: a message says so and offers "Choose…" and
  "Create it", and only "Create it" makes the folder.

From then on it is an ordinary page: the editor saves it, keeps drafts and versions, and
refuses to lose it.

Text that the old Journal's composer left unsaved on this machine (the web view's
`localStorage` key `os.journal.draft`) is offered at each start until it is placed: "Add to
today's journal" appends it to today's file with `appendLine`, one line at a time: a blank line
first when the file does not already end in one, then `---` and a blank line when the day
already has something written, then the text. "Discard…" asks first.

## What the app writes, in one place

| File | How | When |
|---|---|---|
| a month, `<planner>/YYYY-MM.md` | `replaceLine`: one row of `# Log`, only if it still reads what was shown | a mark made, taken back or dropped on the Execution page |
| a month or a year | `replaceLine`: one goal line, the same way | a goal ticked in Month or Year |
| `<planner>/YYYY-MM.md` (or in `<planner>/YYYY/`) | exclusive create, never an overwrite | "Start it" on a month with no file |
| `<planner>/YYYY.md` (or in `<planner>/YYYY/`) | exclusive create, never an overwrite | "Start it" on a year with no file |
| `<planner>/todo.md` | `replaceLine`: one line, only if it still reads what was shown | a task ticked or unticked in Day |
| `<planner>/todo.md` | `appendLine`: `- [ ] <text>` at the end (the file made with `# Todo` the first time) | a task added in Day |
| `<journal>/YYYY-MM-DD.md` | exclusive create, never an overwrite | "Write today" when today has no file |
| today's journal file | `appendLine`, line by line: `---` and a blank line when the day has text, then the text | "Add to today's journal" on the old composer's unsaved text |
| the vault's state, `planner` (on this machine, not in the vault) | the app's own state | the first start (the old plugins' choices, then detection); each start until the paths are confirmed, when detection fills one; Settings › Views; a chosen file or folder renamed or moved |

Nothing else is written. The intro, the week, the notes and the reviews of the plans, and the
journal entries, change only when you edit them, in the editor or anywhere else. An older
folder's `systems.jsonl` is left where it is and no longer read.
