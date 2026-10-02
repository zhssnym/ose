# File formats

Ose keeps no database. Every note is a plain file, and the planner (Day, Week, Month and
Journal) builds its views out of a handful of ordinary markdown and JSONL files. This document
is the contract for those files. An agent such as Claude Code, run on the vault from outside,
reads it to know how to write a file that the app will read, and what the app writes back.

The code is in `src/views/`: one folder per view (`day/`, `week/`, `month/`, `journal/`) and
`shared/` for the readers they share, named for what they hold: `timetable.ts` (the calendar),
`tasks.ts` and `todo.ts` (todo lines), `plans.ts` (monthly plans and `systems.jsonl`),
`settings.ts` and `detect.ts` (where the files are). The journal's format is read in
`journal/index.ts`.

## Where the files are

Settings › Views holds four paths. They are stored under `planner` in the vault's state, which
the app keeps on this machine (`<app data>/vaults/<vaultKey>/state.json`, see docs/HOST.md), not
in the vault. A vault that still has a `.ose/state.json` from an older Ose is read from there
until the app first writes its state:

| Setting | Kind | Read by |
|---|---|---|
| Calendar | a markdown file | Day, Week |
| Todo files | one or more markdown files | Day |
| Reports folder | a folder | Day, Month |
| Journal folder | a folder | Journal |

The first time the app opens a vault, it looks for these by name and shows what it found:

- names are compared without case and without a leading number, so `4-journal` is a journal
  folder and `1-general-todo.md` is a todo file;
- the calendar is a markdown file named `calendar`, `calendrier`, `timetable`, `schedule`,
  `emploi du temps` (or `emploi-du-temps`) or `edt`;
- a markdown file with `todo` or `todos` as a word of its name is a todo file (`todo.md`,
  `1-general-todo.md`, `School TODO.md`); inside a word it does not count, so `Mastodon.md`
  is not one;
- the reports folder is the folder that holds `systems.jsonl`, or else one named `reports`,
  `report`, `plans`, `monthly plans` (or `monthly-plans`) or `execution`;
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

Which weeks are Q1 weeks and the journal mode (full or compact) are in the same place. Q1 is
stored as `q1Anchor`, the Monday of a week that is a Q1 week, written by "This week is Q1 / Q2"
in Settings › Views; the weeks alternate from it. A vault that had the older `q1Parity` (odd
or even ISO weeks) has it turned into an anchor once, on the week the app first reads it.

## Calendar

One H1 per weekday, then one line per block.

```markdown
# Lundi

- 08h20 à 09h15 Maths · salle 333 [maths]
- 09h15 à 10h10 Ens. scientifique · salle 333 [cours] (Q2)
- 23h00 à 07h00 Sommeil [sommeil]
```

**The weekday headings**

- A weekday heading is `# Lundi` … `# Dimanche`, or `# Monday` … `# Sunday`, with or without
  accents.
- Words after the weekday are allowed: `# Jeudi · semaine A`.
- Any other H1, such as `# Hours per week`, closes the day. Nothing under it is read.
- Prose anywhere is ignored, so notes can sit between the blocks.

**A block line** has these parts, in order:

1. A bullet (`-`, `*` or `+`).
2. The start and end times: `08h20`, `8h`, `8:20`.
3. `à` between the two times, or `a`, `to`, or a dash.
4. The name.
5. An optional room or note after ` · `.
6. An optional type in square brackets.
7. An optional `(Q1)` or `(Q2)`, before or after the type.

**What the parts mean**

- **The type** picks the colour family. These words are known: `cours`, `maths`, `nsi`,
  `philo`, `hg`, `bilan`, `dejeuner`, `travail`, `off`, `sommeil` and their variants. Any other
  word still draws, in the rest colour. `maths`, `nsi`, `philo`, `hg` and `bilan` count as
  personal work in Week's totals.
- **`(Q1)` / `(Q2)`** mark a block that is there every other week. With Q1 set in Settings, a
  (Q1) block is drawn in Q1 weeks and a (Q2) block in the others, counting whole weeks from the
  anchor, holidays and year ends included. The ISO week number is not used: a year of 53 ISO
  weeks (2020, 2026) ends on an odd week and the next one starts on one, which would swap Q1
  and Q2 every January after. If a break restarts the count at school, set "This week is" again.
  With Q1 unknown, both are drawn side by side.
- **An end before the start** runs overnight into the next morning. It is never read as a
  negative length.

A line under a weekday that looks like a block but cannot be read is not dropped silently.
Such a line is a bullet, or opens on a time. Week and Day say "N lines not understood", and
the tooltip gives the line numbers.

The app never writes to the calendar.

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
- **A new task** from the Day view's foot line is appended to the first todo file as
  `- [ ] <text>`, exactly as typed, markers included. It is written with
  `ose.files.appendLine`, and the host adds the line break the file needs.

## Monthly plan

One file per month in the reports folder: `<reports>/<year>/<YYYY-MM>.md`. Any name starting
with the month counts (`2026-09 Monthly Plan.md`), and the exact `2026-09.md` wins when there
are several.

```markdown
# 2026-09 Monthly Plan

Why this month matters, in a paragraph or two.

Educational
- Finish chapter 3 of the maths course

# Systems

- Maths session (lun-ven)
- Reading before bed (sam, dim)
- Bed by 23h00

# Monthly Review

Written at the end of the month.
```

**The title section**

- The title section is the first H1 and its body.
- A line holding a single word and no bullet is a goal label (`Educational`, `Financial`).
- The bullets under a label are that label's goals.
- Other prose is the intro.
- A bullet before any label goes under `Notes`.
- An optional `# Goals` section is read as more of the title section.

**`# Systems`**

- One bullet per system.
- A day list in parentheses at the end says when it is due: `(lun-ven)`, `(lun mer jeu)`,
  `(sam, dim)`. English three-letter days work too.
- With no day list, the system is due every day.
- A month with no `# Systems` section shows the systems that were checked that month.

**`# Monthly Review`** (or `# Review`) is prose. The app shows it and never writes it.

A `_gap: …_` line marks a hole that is known and not filled. It is shown as such.

The app never creates or edits a plan file.

## systems.jsonl

The check log: `<reports>/systems.jsonl`, one JSON object per line.

```json
{"date":"2026-09-26","system":"Maths session","done":true,"at":"2026-09-26T18:02:11.000Z"}
```

**The records**

- `date` is the day the check is for, `system` the name as it is written under `# Systems`,
  `done` true or false, and `at` when it was recorded.
- Older lines say `habit` instead of `system`, and mean the same.
- The last record for a (date, system) pair wins, so unticking is a new line and never an edit.
- A line that is not valid JSON is skipped.

**What the app writes.** Ticking or unticking a system in Day appends one record with
`ose.files.appendLine`. The host adds a line break before it when the file does not end with
one, so two records can never run together.

**How Month counts**

A due day counts as one of three things:

| A due day that is | Counts as |
|---|---|
| checked | done |
| past and not checked | lost |
| today, or still to come | open |

- A day before the system's first record in the log is not a loss.
- A system nobody has checked yet has not started, and has lost nothing.

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
| `<reports>/systems.jsonl` | `appendLine`: one record at the end | a system ticked or unticked in Day |
| a todo file | `replaceLine`: one line, only if it still reads what was shown | a task ticked or unticked in Day |
| the first todo file | `appendLine`: `- [ ] <text>` at the end | a task added in Day |
| `<journal>/YYYY-MM-DD.md` | exclusive create, never an overwrite | "Write today" when today has no file |
| today's journal file | `appendLine`, line by line: `---` and a blank line when the day has text, then the text | "Add to today's journal" on the old composer's unsaved text |
| the vault's state, `planner` (on this machine, not in the vault) | the app's own state | the first start (the old plugins' choices, then detection); each start until the paths are confirmed, when detection fills one; once, when an old `q1Parity` becomes `q1Anchor`; Settings › Views; a chosen file or folder renamed or moved |

Every other planner file is read and never written. The calendar, the plans and the journal
entries change only when you edit them, in the editor or anywhere else.
