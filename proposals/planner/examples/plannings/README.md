# plannings: the year, the months and the todo list

> **Superseded.** This describes an earlier draft (a timed week, a Days table, Week and Day pages). The format as built is in `docs/FORMATS.md`, "The planner": a month is Goals, Execution, Log and Review; Planner is Year and Month; Today is the heatmap, the day's list and the todos.

This folder is the whole planning system: one file per year, one file per month, one todo list.
Ose's Today and Planner pages are these files, typeset. Hassan and an agent read and edit the
same files. Their shape is a contract: a file that follows it is drawn as goals, a week, days
and a review, and a file that does not is still a page of text.

Hassan's format rule applies: H1 and body text, `-` bullets, no H2. The shape below is the only
structure on top of it.

## Files

```
YYYY.md       a year: what it is for, its goals, its review once it is over
YYYY-MM.md    a month: its goals, the week it intends, a row per day, its review
todo.md       the todo list
```

The date in the name is what counts. The files sit flat in this folder, or a finished year's
files in a folder named for it (`2026/2026-10.md`); both are found. Months written before
September 2026 keep their older shape (goals, then a review). They are read as they are and
never converted.

## A month

Five H1 sections, in this order. `2026-10.md` beside this file is a whole one.

```
# October 2026

Why this month matters, in a paragraph. Optional.

# Goals

Educational

- [ ] Maths: 17 or more at the DS
- [ ] Fewer than 10 hours of absence

Personal

- [ ] In bed by 23h00, six nights out of seven

# Week

- 22h00 à 22h45 Lecture [lecture]
- Bed by 23h00 [bed]

Lundi

- 08h00 à 17h00 School [cours]
- 17h20 à 19h00 Maths · BU Sciences [maths]

Mardi, Jeudi

- 08h00 à 16h00 School [cours]
- 16h30 à 18h00 Maths · BU Sciences [maths]

# Days

| Day    | cours | maths | lecture | bed | Note                 |
|--------|-------|-------|---------|-----|----------------------|
| 01 jeu | x     | x     | x       | .   |                      |
| 02 ven | x     | .     | x       | x   | DS de maths le matin |
| 03 sam |       |       |         |     |                      |

# Review

_gap: written at the end of the month_
```

**The title.** The first H1. Its text is free; the month comes from the file name. Prose under
it is the intro.

**`# Goals`.** What the month is for.

- A line holding one word is an area: `Educational`, `Financial`, `Personal`.
- `- [ ] text` is a goal, and `- [x]` once it is met. A plain `-` bullet is a goal nobody ticks.

**`# Week`.** How the days are meant to be spent. This is the one list of what gets confirmed.

- A line is a name and, in brackets, its system: `- Maths [maths]`, `- Bed by 23h00 [bed]`.
- The word in brackets is the line's **system**: its column in the days table, its row on the
  pages, its run. Lines that share a system on one day are one thing to confirm. A line with no
  brackets is shown in the day and never confirmed.
- A time and a place may be written around the name: `- 17h20 à 19h00 Maths · BU Sciences
  [maths]`. They are yours to keep or to leave out. The pages do not show them: a time only
  puts the day in order.
- Lines above the first weekday label are for every day. A label is a line of weekday names:
  `Lundi`, `Mardi, Jeudi`, `Lundi à Vendredi`, in French or English. Lines under a label are for
  its days, and a day may sit under several labels.
- A line with no time may carry its days itself: `(lun-ven)`, `(sam dim)`.
- `(Q1)` or `(Q2)` at the end of a line means every other week.
- Any other prose is ignored, so a sentence about the week can sit there.
- `# Week from 2026-10-19` is a week that takes over on that day: a holiday week, or a week
  rewritten mid-month. It is a whole week, not a patch. The days before it keep the old one.

**`# Days`.** What was done, one table row per day. The rows are made when the month is
started, all of them, empty.

- The header names the columns: `Day`, one per system, `Note`.
- The first cell is the day of the month, then its weekday for the reader: `03 sam`. Only the
  number is read.
- A cell under a system holds one mark:

  | Mark | Meaning |
  |---|---|
  | `x` | done |
  | `.` | due that day, not done |
  | `-` | dropped on purpose that day (ill, a holiday, a class cancelled): it counts for nothing |
  | empty | nothing recorded |

- `Note` is a few free words on the day, written here by hand or by an agent and shown on that
  day's page. No `|` in it.
- A system added during the month gets a new column at the right end. A column is never
  removed or renamed during the month.

**`# Review`.** Prose, written when the month is over. Until then it holds
`_gap: written at the end of the month_`. An area label as in Goals opens that area's
paragraphs, `Grade: 7/10` under them grades it, and `Overall: 6/10` grades the month. The
grades are the only parts read; the rest is free.

## A year

Three H1 sections. `2026.md` beside this file is one.

```
# 2026

What this year is for, in a paragraph.

# Goals

Educational

- [x] Pass the bac de français, oral and written
- [ ] Read 4 books outside the curriculum

# Review

_gap: written at the end of the year_
```

Goals and Review read exactly as a month's. Nothing about the months is written here: the Year
page reads the twelve month files.

## How a day counts

These five rules give every number on the pages. An agent that reports a number uses them.

1. A system is **planned** on a day when the week in force that day has a line for it on that
   weekday. The week in force is the last `# Week from` that has begun, else `# Week`.
2. It is **due** when its cell is `x` or `.`, or when it is planned and the cell is empty. It is
   never due when the cell is `-`.
3. It is **done** when its cell is `x`. An `x` under a system that was not planned counts too.
4. A month counts from its first marked day. From there every past day counts in full, a past
   day with no mark included. Today counts only what is done. Days to come count nothing.
5. The **rate** is done over due, for a day, a week, a month, a year or one system. A system's
   **run** is its due days done in a row, back from today. A day it is not due, a `-` and today
   still open do not break it. A missed day does. It carries on into the month before.

## Who writes what

Everyone changes one line at a time and nobody rewrites a file. The folder syncs between
machines and three hands may be in it at once.

| Who | What | How |
|---|---|---|
| Ose | a mark of a day | replaces that day's row, only if it still reads what was on screen |
| Ose | a goal met | replaces that goal's line the same way |
| Ose | a task ticked, a task added | replaces its line, or appends one, in `todo.md` |
| Ose | a new month or year | creates the file, never over one |
| An agent | any of the above, and the prose | edits the lines concerned, nothing around them |
| Hassan | anything | in the editor |

The first mark of a day writes `.` under everything planned that day, then the `x`. From then
on the row says by itself what was due, whatever the week becomes later.

An agent never reorders or deletes rows, never changes a past row unless asked, never touches
the months before September 2026, and keeps the table's padding as it finds it.

## Starting a month

Ose's "Start November 2026" does steps 2 and 3 mechanically. An agent does all four.

1. Read the last month's file and the year's.
2. Create `YYYY-MM.md`, never over a file:
   - the title, `# November 2026`, and one paragraph on what the month is for when Hassan has
     said it, else nothing;
   - `# Goals`: the same areas. Carry the goals that still stand, unticked, in his words. Leave
     out the ones that were met and are finished;
   - `# Week`: the week in force on the last day of the month before, copied as `# Week`;
   - `# Days`: the header, the delimiter row, and one empty row per day of the month. Columns:
     the systems in the order the week meets them, Monday first, lines with no time last;
   - `# Review`: the gap line.
3. Change nothing in the month before.
4. Say in one message what was carried and what was left out, and ask what changes.

## Recording a day

Change that day's row and nothing else. `x` for what was done. When the day is over, `.` for
what was due and was not done. `-` only when he says it was dropped on purpose. A few words in
`Note` when he gives them.

## Reviewing a month

1. Read the month. Count each system (done of due), the month's rate, the runs, the days with
   no mark. Read the notes.
2. Ask once for what the file cannot say: the result of each goal that has no system (a mark at
   a DS, a balance), what he keeps and what he changes next month, and the grades, or propose
   them for him to correct.
3. Write `# Review` in place of the gap line. One block per area, in the order of Goals: the
   facts first with their numbers, then his words, then `Grade: N/10`. Last, `Overall`: what to
   keep, what to change, `Overall: N/10`.
4. Tick the goals that were met.
5. Touch nothing else. Offer to start the next month.

## Starting and reviewing a year

A new year is `YYYY.md`: the title, a paragraph, `# Goals` with the same areas and the goals
that still stand, `# Review` with `_gap: written at the end of the year_`. Ose's "Start 2027"
writes it with the areas alone.

A year's review reads the twelve months and the year file: the rate of each month and of each
system, the months' grades, the goals met. Ask once, then write `# Review` the way a month's is
written.

## The todo list

`todo.md`, one task per line anywhere in the file, nested with two spaces:

```
- [ ] Renew the passport 📅 2026-10-01
  - [ ] Photos
- [x] Pay the rent ✅ 2026-09-25
```

`📅` is the due date and `✅` the day it was done. Today shows the tasks that are late, due that
day or undated. Ticking one replaces its line; a new one is appended.
