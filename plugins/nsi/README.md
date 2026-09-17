# Code

An Ose plugin (docs/PLUGINS.md): the vault's coding drills as a list and a page, with a Python
judge it runs through `ose.run`. No server, no port, no browser tab.

The plugin shows the drills and records the attempts. It decides nothing: what the next drill
should be is worked out by an agent (Claude Code, run on the vault) reading `.nsi/log.jsonl`
and written into the folder as files. There is no scheduler here, no review date and no state
file.

The id stays `nsi` — the folder, the route prefix `nsi/` and the command ids are all `nsi`, so
state and links survive the rename. "Code" is what a person reads.

## What it registers

| kind     | id / name    | what it does |
|----------|--------------|--------------|
| command  | `nsi.index`  | open the drills |
| command  | `nsi.run`    | save and run `solution.py` (`Mod+Shift+R`) |
| command  | `nsi.submit` | judge the open drill (`Mod+Shift+Enter`) |
| view     | `nsi`        | the drills, one table |
| route    | `nsi/*`      | one drill: statement, `solution.py`, verdict, clock |

One path, declared as `drills`: a folder named `nsi`, one folder per drill. The plugin never
spells it. Ose finds it by name and asks where it is when it cannot, on the page the view or
the drill would have drawn. Python is resolved once a session by asking it: `python`, then
`python3`, the first that answers `--version`.

## What it shows

**The index** is one line of counts and then the shared drills table (`../_lib/table.js`, the
one the Maths index draws with): `#`, `Title`, `Category`, `Date`, `Status`. It is read off the
folder and the log, and starts no process.

- `#` is the number the folder name begins with, `Title` the meta's, `Category` the first tag.
- `Date` is the meta's `date` when it has one, failing that the day of the drill's first log
  line, failing that nothing.
- `Status` is the log: `not done` while there is no line, `3 attempts` while no submission has
  passed, `done` once one has.

One tab stop: Up, Down, Home and End walk the rows, Enter opens. Nothing on this page creates,
renames or deletes a drill: the folder is the sidebar's, and the files are an agent's.

**A drill** is one column: the title with a clock at its right, one line of meta (the tags,
then one fact: `7 tests`, `self-graded` or `nothing to judge`), the statement, then
`solution.py` in the editor, large, and **one control band**: `submit · run · show the
correction`, the chord printed beside the first two. `run` becomes `stop` in that same button
while a program is running. `show the correction` is a toggle, and on a drill that has never
passed it writes a failure to the log — the band says so. The verdict, the tests table and the
run output land in one place directly under the band.

Two shapes, and the folder decides. With `tests.py` the drill is judged: a table of the cases
that failed and a verdict. With a correction and no tests it is self-graded: `submit` shows the
correction and you answer pass / partial / fail, and nothing is logged until you have graded.
With neither it is not judgeable: a statement and a code area, no clock and no `submit`.

**The clock** is passive: no countdown, no budget, no button. It starts when the page draws
(reading the statement is work), stops when the window is hidden, drops any gap longer than a
minute, banks every ten seconds into `.nsi/clocks.json` so a reload costs ten seconds and not
the visit, and stops for good on a pass. A drill that is done shows `best 1:34`, static, and a
second go runs a fresh clock from zero. The duration a submission logs is that clock and
nothing measured anywhere else.

## The data

One drill is one folder, directly under the drills folder, and the id is the folder's name:

```
drills/nsi/
  1-inversion-dictionnaire/
    meta.json              the four keys below
    enonce.md              the statement, H1 = title
    solution.py            yours; the only file in here the app writes
    tests.py               the cases; `TESTS = []` means "no tests yet"
    correction.py          the reference, or correction.md
  2-liste-chainee-recursive/
  .nsi/
    log.jsonl              one line per submission, append only, never edited
    clocks.json            seconds banked per drill that is not done yet
```

`N` is a plain integer, not zero-padded, and it is the drill's number. The slug is in the
language of the content.

### `meta.json`

```json
{
  "title": "Inversion d'un dictionnaire",
  "date": "2026-09-16",
  "tags": ["dictionnaires", "parcours"],
  "code": {
    "function": "inverse_dico",
    "params": ["dico"],
    "return_type": "dict",
    "constraints": { "forbidden": ["max"], "required": ["for"] }
  }
}
```

Four keys and nothing else is read. `title` names the drill. `date` is the day it was written,
optional, and the only thing that reads it is the index's Date column. `tags` is a list of
short strings, and the first one is the drill's category. `code` is optional: without
`code.function` a drill has no signature to test; `constraints.forbidden` and `.required` take
bare names (`max`, `sorted`), method calls (`.append`, the group `list-methods`) and node
classes (`for`, `while`, `loop`, `comprehension`, `slice`, `import`, `lambda`, `try`,
`recursion`). A mention counts, dead code included. A meta that still carries `kind`, `source`,
`difficulty` or `concepts` is read exactly as one that does not, and they are left on disk:
a field the judge does not read is not a field it deletes.

### `tests.py`

```python
TESTS = [
    {"name": "cas simple", "args": ({"a": 4, "b": 5},), "expect": 5},
    {"name": "négatifs", "args": ({"a": -4},), "expect": -4},
]
```

`args` is a tuple, `kwargs` optional, and either `expect` (deep equality; a bool is never an
int) or `check` (a callable). Each case runs in an isolated subprocess with a 5 s budget, the
whole suite with 40 s. `TESTS = []` is a legitimate state: the drill is self-graded against its
correction until the cases are written.

### `log.jsonl`

Append only, and the only state there is: status, the attempt count and the best time are
computed from it every time, by the judge and by the page alike.

A submission — `submit` on a drill with tests, or the self-grade on one without — writes:

```json
{"problem": "2-liste-chainee-recursive", "verdict": "fail", "attempt": 2,
 "failed_tests": [], "constraint_violations": ["loop"], "duration_s": 42,
 "correction_viewed": false, "tags": ["listes-chainees"],
 "code": "def longueur(liste):\n    ...\n", "ts": "2026-09-17T23:32:00"}
```

`verdict` is `pass`, `partial` or `fail`. `attempt` is the number of lines this drill already
had, plus one. `code` is the exact source that was judged, so an agent can see how an attempt
failed and not only that it failed. `duration_s` is the page's clock, 0 when it was not timed.

`show the correction` on a drill that has never passed writes the same line with `verdict`
`fail`, `correction_viewed` true and **no** `code`: nothing was judged. On a drill that has
passed it writes nothing. **`run` writes nothing at all**: a run is not an attempt, and a line
per run would bury the record an agent reads.

## The judge by hand

```
cd <vault>/.ose/plugins/nsi
python -B -m judge.cli --root <vault>/drills/nsi detail    2-liste-chainee-recursive
python -B -m judge.cli --root ... submit    2-liste-chainee-recursive --duration 137
python -B -m judge.cli --root ... selfgrade 1-inversion-dictionnaire pass --duration 60
python -B -m judge.cli --root ... reveal    1-inversion-dictionnaire --duration 12
```

Four verbs and no more: `detail` (what a drill is, its files and its two texts), `submit`,
`selfgrade`, `reveal`. The listing is not one of them: the plugin reads the folder and the log
itself. `--root` is global and comes before the command; `--duration` belongs to its command
and comes after it. `-B` because the judge lives in the vault, and a vault is plain files a
person edits: no `__pycache__` belongs there. This is exactly what the plugin runs: the working
directory is the plugin's own folder, and `--root` is the drills folder Ose resolved, absolute.

Every command prints **one JSON object** on stdout: `{"ok": true, "command": …, …}` or
`{"ok": false, "error": …, "error_kind": …}` with exit code 1. `error_kind` is `not_found`,
`bad_request`, `not_judgeable`, `timeout`, `run` or `internal`. Progress markers
(`@@STATUS {...}`) and anything the judge prints for a human go to stderr. The result line is
ASCII-safe JSON, so `é` crosses any console code page and comes back as `é` after `JSON.parse`;
every file is read and written UTF-8 with LF.

The tests are `python -B -m judge.test_cli` (stdlib, no pytest): they build a throwaway drill
tree in the temp dir and drive the CLI as a real subprocess.

## Rules this plugin keeps

- It writes nothing outside the drills folder, and nothing inside a drill folder except your
  answer file — and that only when you have changed it.
- Its numbers live beside the data, never in `.ose/state.json`.
- Python is stdlib only, no pip, no network. The interface is plain ES modules and one
  stylesheet built from the kernel's tokens, over the shared `../_lib/drills.js` and
  `../_lib/table.js`.
- `log.jsonl` is append only. A correction is a new line.
