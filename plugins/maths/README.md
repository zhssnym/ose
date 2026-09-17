# Maths

Calculation drills as files. An AI writes one markdown file per series into the vault; this
plugin is the viewer. It lists the series, shows one question at a time, takes the answer, and
appends one line to a log. That log is the only state it keeps: the status on the list, the
score and the question to come back to are all computed from it, every time.

Its furniture is shared with the nsi plugin: the table is `../_lib/table.js` and
`../_lib/table.css`, the error block and the fold that takes the shell away during a run are
`../_lib/drills.js` and `../_lib/drills.css`. What is here is this plugin's own: the grammar of
a series file, the maths, and the run.

## What it registers

| kind | id | what |
| --- | --- | --- |
| command | `maths.index` | Maths: open the series |
| command | `maths.next` | Maths: open the next series the log does not call done — `Ctrl+Shift+S` |
| view | `maths` | the list, order 50, icon `tasks` |
| route | `maths/*` | one series per file (`maths/serie-02`), and the page is the session |
| quick open | `maths/*` | one row per series, by its title |
| path | `series` | `{ folder: 'math' }`: one markdown file per series, named `serie-NN.md`. Nothing else is ever spelled |
| style | `style.css` | linked by the loader while the plugin is active; it imports Temml's own sheet |
| run | — | none |

The folder is resolved when the list or a series mounts, never at load. While the vault says
nothing about where the series are, the page draws the kernel's box — what is missing, the hint,
**Choose…** — and stops there.

## What it shows

**The list.** The title, one line of counts (`3 series · 1 done`), and a table: `#`, `Title`,
`Date`, `Status`. The title is the series' `titre:` when it has one and its H1's text otherwise.
Up, Down, Home and End walk the rows; Enter or a click opens one. The status is the log's
answer, in three shapes:

| status | when |
| --- | --- |
| `not done` | the log holds no line for this series |
| `12 / 70` | twelve of its question numbers have a line |
| `done 61 / 70` | every question number has a line; 61 of them are right |
| `does not parse` | the file deviates from the grammar; opening it names the lines |

A series is done when every question number has a line, and its score counts the **first** line
of each question. Nothing else is stored anywhere.

**A series.** Opening it shows the first question with no line in the log, immediately: no door,
no resume button, no summary. The shell folds away, the question stands large in the middle of
the column, and the only other thing on screen is the corner readout — which question this is,
and how long it has been there. You answer on paper.

| key | what |
| --- | --- |
| `Space` or the one button | opens the four options under the question |
| `1`–`4`, `A`–`D`, or a click | picks and locks at once; there is no confirm step |
| `Enter`, `Space` or `next` | the next question. A correct answer goes on by itself after a beat |
| `Esc` | back to the list, from anywhere. Nothing is lost: every pick is already in the log |

Once a pick is locked, the expected option is marked in the ok ink and a wrong pick in the error
ink. After the last question one quiet line gives the score and the way back. Nothing on the
page moves between the three states of a question: the options grow into air that was already
there.

## The data

Everything is inside the folder `ose.paths` answers for `series`:

```
<series>/
  README.md  erreurs.md    the owner's. Never listed as a series, never written to.
  serie-02.md              one series. The id is the stem, `serie-02`.
  .math/log.jsonl          append only, one JSON object per line. The only file this plugin writes.
```

A series is a file matching `serie-NN.md`; nothing else in the folder is listed.

**The grammar.** `# Série N`, then a header of `key: value` lines, then the questions. `date`
(`YYYY-MM-DD`) and `familles` (slugs, comma separated) are required; `titre` (the name the list
shows) and `duree` (which nothing reads, and which the older series carry) are optional. A
question is `## <n> · <famille>`, the statement, exactly four options `- A.` to `- D.`,
`<!-- reponse: X -->` and an optional `<!-- regle: … -->`. The numbers run from 1 with no gaps
and every family is one the header names. `$…$` is inline maths and `$$…$$` display maths, drawn
by Temml; everything else is text. The parser is strict: a file that deviates is refused with
the number of the line it went wrong on, and is never rewritten.

**The log line**, one per pick, written the moment it is true:

```json
{"t":"2026-09-17T18:04:12","serie":"serie-03","n":12,"famille":"suites",
 "reflexion_ms":8420,"reponse_ms":1980,"choix":"B","attendu":"B","juste":true}
```

`reflexion_ms` is the question appearing to the options opening, `reponse_ms` the options
opening to the pick. Both are passive: there is no countdown, no session clock and nothing to
start or stop. Leaving a question before the pick writes nothing, so it is simply timed again
from the top when it comes back. A line from an older version that is not an answer is ignored
where it lies; the log is append only and is never rewritten.

## Rules this plugin keeps

- It spells no vault path: it asks `ose.paths` for `series` and derives everything from it. It
  writes one line at a time to one file inside that folder, and it starts no process.
- It never rewrites a file it did not write. `erreurs.md` and `README.md` are Hassan's.
- French is the content's, not the chrome's: `Série 2` is the file's own heading, and every
  label around it is English.
- Every colour, size and space is a token. No hex, no bare pixel beyond a 1px or 2px border.
