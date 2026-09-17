# Maths

Calculation drills as files: one series a day, seventy questions, twenty-five minutes, four
options behind one control. The measure that counts is not the score but the median thinking
time per question, between the question appearing and the key that reveals the options (the
README beside the series, Hassan's design note).

The plugin runs the series, times them, logs every answer the moment it is given, and writes
the three files the next generation reads. It starts no process, ever, and it writes nothing
outside the series folder.

Its furniture — the list row, the chips, the clock, the three bands, the control band, the
error block, the path line — is the shared `../_lib/drills.js` and `../_lib/drills.css`, which
the nsi plugin draws from too. What is here is what is this plugin's own: the grammar of a
series file, the maths, the session and the reports.

## What it registers

| kind | id | what |
| --- | --- | --- |
| command | `maths.index` | Maths: open the series |
| command | `maths.start` | Maths: start the next series — `Ctrl+Shift+S`. Never ends a session: inside a live one it focuses it, and on a page that is not the series in progress it draws that door and stops |
| view | `maths` | the list, order 50, icon `tasks` |
| route | `maths/*` | one series page per file (`maths/serie-02`) |
| quick open | `maths/*` | `Série 2`, one row per series |
| path | `series` | `{ folder: 'math' }`: one markdown file per series, named `serie-NN.md`. Nothing else is ever spelled |
| style | `style.css` | linked by the loader while the plugin is active; it imports Temml's own sheet |
| run | — | none |

Space, Enter, Escape and 1–4 / A–D are the session's own keys, bound on the session's element
and not on the window: they mean nothing anywhere else in the app, so they are not commands.

The folder is resolved when the list or a series page mounts, never at load. While the vault
says nothing about where the series are, the page draws the kernel's box — what is missing, the
hint, **Choose…** — and stops there.

## The interface

**The list.** One row per series in name order: the number, `Série N`, and at the right one
mono figure of one kind — how long the series took once it is done, the date it is for until
then. The score is not on the row; it is the verdict's figure on the series page. A done row is
the green ground; the series in progress carries the accent left edge. A file that does not
parse says `malformed` where its name would be. The counts line reads `3 series · 1 done`.
Nothing on this list creates a series. The row menu is Open · Open `serie-NN.md` · Show in the
file manager · Open the result (when there is one) · Delete… in the danger ink, which asks,
then trashes the series file; the log and the result file stay.

**The series page.** `Série N` with the clock at its right, running only while a session is;
one meta line of the family chips with their counts and then the facts; then the door, the
session or the result; and the file's path at the foot. The page is one skeleton and it never
changes shape.

- **The door** is one button — `start`, `resume` or `redo` — with `Ctrl+Shift+S` printed
  beside it and the hint after. When another series is half finished the door says so and
  offers `resume Série 2` (the chord) and a plain `start this one instead`, which asks before
  it gives the other one up.
- **The session** fills the same bands: the statement at one size for every question, the four
  options as list rows in a band whose height is held open before the reveal, and one control
  at a fixed y. Space reveals, Enter confirms, 1–4 or A–D choose, Escape pauses. One key, one
  job; an autorepeat is not a key, and a reveal under 250 ms after the statement was drawn is
  not one either; Tab is trapped inside the session; `12 / 70` is in the meta line. `confirm`
  is disabled until an option is chosen: it is in the band either way and at the same place.
- **The result** is the control band (`redo`, the chord, `back to the series`), the shared
  lib's verdict under it — `done · 58/70 · 24 min 50` — then the per-family table and the
  misses separated by air: number, family, what was chosen, what was expected, the rule. A
  finished series shows the same three things on its door.

Everything is reachable from the keyboard and nothing needs the mouse. Both themes.

## The data

Everything inside the folder `ose.paths` answers for `series`, the format of
`work/briefs/FORMAT-drills.md`. One series is one file, and everything the plugin writes is in
the dotfolder beside them:

```
<series>/
  README.md               Hassan's design note. The plugin never writes here.
  erreurs.md              his post-mortem. Never written either, and never listed as a series.
  serie-02.md             one series: the grammar below. The id is the stem, `serie-02`.
  .math/log.jsonl         append only, one JSON object per line
  .math/state.json        rewritten whole
  .math/bilan.md          rewritten after every session; what the generator reads
  .math/serie-02-resultat.md   written once, when the first attempt completes
```

A series is a file matching `serie-NN.md` and nothing else is listed, so the two files above
and anything else the owner keeps there are left alone.

`serie-NN.md` is `# Série N`, a header of `date` / `duree` / `familles`, then
`## <n> · <famille>`, the statement, exactly four options `- A.` to `- D.`,
`<!-- reponse: X -->` and an optional `<!-- regle: … -->`. The parser is strict: a file that
deviates is refused with the number of the line it went wrong on, has no start button, and is
never rewritten.

`log.jsonl` takes one line per answered question (`reflexion_ms`, `reponse_ms`, `choix`,
`attendu`, `juste`) and one line per session. `state.json` holds the per-series row — the
**first** attempt's numbers, which a redo never moves — and `en_cours`, which is the place to
come back to, rewritten every ten seconds while a session runs so a reload costs ten seconds
and not the visit. `en_cours` carries two fields beyond FORMAT-drills.md's sketch, both
additive: `pause_s`, so a resumed run can write a true `pause_s` on its session line, and `vu`,
the last moment the session was on the page — the run that picks the series back up counts the
wall time since as pause, so leaving the page is a pause and not a hole in the arithmetic.
`bilan.md` counts only complete attempts and counts each question once, so an abandoned run and
a redo do not double it.

## The generator

The series are not written by hand. `gen/generate.py` builds them from thirty-three templates
over the five families, and it is a desk tool: **the plugin never runs it** and does not know
it exists. Hassan, or an agent working on the vault from outside, runs it every few days, once
per series:

```
python gen/generate.py --out <the series folder> --serie 5 \
  --date 2026-09-19 --count 70 --seed 5 \
  --weights puissances=16,suites=18,signes-inegalites=14,developpement-factorisation=12,fractions=10
```

Every answer is computed, never typed, and the three wrong options are the real error patterns
of `erreurs.md` rather than random values. The same seed gives byte for byte the same file.
`python gen/generate.py --check <serie-NN.md>` parses the same grammar this plugin does and
names the line of any deviation, so a series is checked where it is written rather than argued
about here. After five series `.math/bilan.md` says where the median thinking time is still
high, and the next five are generated with the weights moved there; `gen/README.md` holds the
rule and the exact command.

## Rules this plugin keeps

- It spells no vault path: it asks `ose.paths` for `series` and derives everything from it. It
  writes only inside that folder and its `.math/`, and it starts no process.
- It never rewrites a file it did not write. `erreurs.md` and `README.md` are Hassan's.
- French is the content's, not the chrome's: `Série 2` is the file's own heading, and every
  label around it — family, questions, correct, median, missed, chosen, expected — is English.
- Every colour, size and space is a token. No hex, no bare pixel beyond a 1px or 2px border.
