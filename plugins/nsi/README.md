# Informatique

An Ose plugin (docs/PLUGINS.md). It turns the vault's drill folders into a list, a drill
page, a judge and a spaced review schedule, without a server, a port or a browser tab: the
interface is Ose, the judge is a Python CLI this plugin runs through `ose.run`.

The plugin is only for generated coding drills, LeetCode-like: one statement, one function in
`solution.py`, judged by `tests.py` when there is one and self-graded against the correction
when there is not. Nothing school-related lives here. The exercises a teacher set stay in the
vault as files and are simply not this plugin's business.

The id stays `nsi` — the folder, the route prefix `nsi/` and the command ids are all `nsi`, so
state and links survive the rename. "Informatique" is what a person reads.

The furniture is not this plugin's: the DOM helpers, the chips, the list row and its keyboard,
the clock, the title line, the meta line, the pane label, the control band, the verdict, the
error box and the path line come from the shared `../_lib/drills.js` and `../_lib/drills.css`,
which the Maths plugin draws from too. What is left here is the editor host, the run output,
the tests table and the statement.

## What it registers

| kind     | id / name    | what it does |
|----------|--------------|--------------|
| command  | `nsi.index`  | open the drills |
| command  | `nsi.next`   | the scheduler's next drill (`Mod+Shift+D`) |
| command  | `nsi.run`    | save and run `solution.py` (`Mod+Shift+R`) |
| command  | `nsi.submit` | judge the open drill (`Mod+Shift+Enter`) |
| view     | `nsi`        | the drills: one flat list in number order |
| route    | `nsi/*`      | one drill: statement, `solution.py`, verdict, clock |

Four commands and no settings section. There is no tile and no view of what is due: the
scheduler is `nsi.next` and nothing else pushes a review at you.

One path, declared as `drills`: a folder named `nsi`, one folder per drill, each with
`enonce.md`, `meta.json` and `solution.py`. The plugin never spells it. Ose finds it by name
and asks where it is when it cannot, on the page the view or the drill would have drawn; the
answer is remembered under `plugins.nsi.paths` and the page is mounted again. Python is
resolved once a session by asking it: `python`, then `python3`, the first that answers
`--version`.

## The interface

- **The list** is flat. One line of meta (`N drills · M done`), then one row per drill in
  number order: the number, the title, its tags, and at the right the best time the drill has
  ever been done in (`4 min 12`) — a time it keeps even after a review goes badly. The number
  is the folder's own, right-aligned in its column so nine and twelve line up. A row's state is
  its colour: a done drill sits on an opaque green ground with its name in the green ink, a
  failed one keeps a warm edge on the left, an unseen one is plain. The list is one tab stop;
  Up and Down walk the rows, Home and End jump, Enter opens.
- **Tags** are chips. The eight tones are assigned by sorted position across the whole listing,
  not by a hash, so a vault of five tags gets five different colours — and the drill page reads
  the same listing, so a tag is the same colour on the list and on its own page.
- **Every row has a menu** — right click, Shift+F10 or the Menu key: Open · Edit tags… · Open
  folder · Open statement · Open meta.json · Delete… (the folder goes to the trash, and the
  confirm names the files that are really in it). `Edit tags…` goes through the judge's
  `update`, which writes `meta.json` and nothing else. Renaming a drill is opening `enonce.md`
  and editing its H1.
- **A drill** is one column: the title with the clock at its right, one meta line (the tags,
  then one fact: `7 tests`, `self-graded`, or `nothing to judge`), the statement, then
  `solution.py` in the editor — thirty lines tall whatever the file holds, growing with it —
  then **one control band**: `submit · run · show the correction`, primary first, the chord
  printed beside the first two. There is no second band and no second size of button anywhere
  on the page. `run` becomes `stop` in that same button while a program is running, and that
  button is the only way to stop it. `show the correction` is a toggle: the correction opens
  below with its syntax colours and the same button closes it again. When the judge asks how
  it went (a self-graded drill), the three answers take the band over until one is given. The
  verdict, the tests table and the run output all land in one place directly under the band,
  and `submit` scrolls it into view; the run output holds three lines and scrolls past sixteen,
  so a chatty program never pushes the page around. At the foot, one quiet mono line: the
  drill's folder, and `copy`.
- **The clock.** A mono clock at the top right of the drill page, and only on a drill the judge
  can say something about. It starts when the page draws and not when the first character is
  typed: reading the statement is work, and a drill has no door to press. It is one stretch per
  visit, started from now: it stops when the
  window is hidden, drops any gap longer than a minute (a closed lid is not work), banks every
  ten seconds into `.nsi/clocks.json` so a reload costs ten seconds and not the visit, and
  stops for good on a pass. A solved drill shows `best 1:34`, static, and a review runs a fresh
  clock from zero — the pass a review earns logs the review's own duration, and the judge keeps
  `meilleure_s` as the minimum. A review that fails leaves the clock running, because the work
  is not over. The duration `submit` sends is that clock and nothing measured anywhere else.
- **Two shapes, and the folder decides.** With `tests.py` the drill is judged: `submit`, a
  table of the cases that failed, a verdict. With a correction and no tests it is self-graded:
  `submit` shows the correction and you answer pass / partial / fail — the correction is on
  screen from that moment, so the `pass` that follows earns the seven-day interval, not the
  fourteen a clean first solve earns, and nothing is logged until you have graded. With neither
  it is **not judgeable**: a statement and a code area, no clock, no `submit`, no verdict, and
  the judge refuses to grade it rather than handing out a pass against a placeholder. A blank
  answer to a judge is refused.

## The data

One drill is one folder, directly under the drills folder, and the id is the folder's name:

```
drills/nsi/
  1-inversion-dictionnaire/
    meta.json              machine fields (below)
    enonce.md              the statement, H1 = title
    solution.py            yours; the only file the app writes
    tests.py               the cases; `TESTS = []` means "no tests yet"
    correction.py          the reference, hidden until solved or revealed
  2-liste-chainee-recursive/
  .nsi/
    state.json             per-drill state, owned by the plugin
    log.jsonl              one line per submission, append only, never edited
    clocks.json            seconds banked per unsolved drill
```

`N` is a plain integer, not zero-padded, and it is the drill's `number`. The slug is in the
language of the content. Every drill is the same kind: a statement, a Python answer, a
correction, and tests when there are tests. There is nothing here that creates a drill: drills
come from a generator, the way the Maths series do.

A drill with a non-empty `TESTS` is judged: submit runs the cases and the verdict is the
judge's. A drill whose `tests.py` is missing or whose `TESTS` is empty is self-graded against
its correction. The correction is `correction.py` when one exists, otherwise `correction.md`;
`correction_format` says `py` or `md`. A `correction.py` holding nothing but comments is a
promise, not a correction: the drill counts as not judgeable until something is written in it.

### `meta.json`

```json
{
  "id": "1-inversion-dictionnaire",
  "title": "Inversion d'un dictionnaire",
  "tags": ["dictionnaires", "parcours"],
  "code": {
    "function": "inverse_dico",
    "params": ["dico"],
    "return_type": "dict",
    "constraints": { "forbidden": ["max"], "required": ["for"] }
  }
}
```

Four keys, and the judge reads no others: `title`, `tags`, `code` and, when `code` is there,
what is inside it. `tags` is a list of short strings and it is the only field the app writes.
`code` is optional: without `code.function` a drill has no signature to test. There is no
chapter, no source, no difficulty, no kind and no `concepts`: the list is flat, every drill is
one of yours, and `tags` is the one name for what a drill is about. A meta that still carries
any of them is read exactly as one that does not, and they are left on disk where they are:
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
whole suite with 40 s.

`TESTS = []` is a legitimate state: the drill is self-graded against its correction until the
cases are written.

### Constraints

`forbidden` and `required` take bare names (`max`, `sorted`), method calls (`.append`, the
group `list-methods`) and node classes (`for`, `while`, `loop`, `comprehension`, `slice`,
`import`, `lambda`, `try`, `recursion`). A forbidden name is forbidden however it is spelled;
declaring any `forbidden` entry also forbids `eval`, `exec`, `__import__` and dynamic
`getattr`. A mention counts, dead code included.

### Scheduling

A pass on a first clean attempt schedules the review in 14 days, within two attempts 7, after
that 3; passing a review multiplies the interval by 2.5, capped at 90 days. A fail, a partial
or a reveal on an unsolved drill sets it to tomorrow. `status` is `unseen`, `failed` or
`solved`, and `due` is derived from the date, never stored. `duree_s` is the last duration,
`meilleure_s` the smallest of the passing ones, both in seconds and both from the page's clock.

Next up, in order: overdue reviews, then failed drills oldest first, then unseen drills, then
the unseen drill carrying your weakest tag.

## The judge by hand

```
cd <vault>/.ose/plugins/nsi
python -B -m judge.cli --root <vault>/drills/nsi list
python -B -m judge.cli --root ... next
python -B -m judge.cli --root ... detail    3-longueur-liste-chainee-recursive
python -B -m judge.cli --root ... submit    3-longueur-liste-chainee-recursive --duration 300
python -B -m judge.cli --root ... selfgrade 1-recherche-dictionnaire pass
python -B -m judge.cli --root ... reveal    1-recherche-dictionnaire
echo '{"tags":["revision"]}' | python -B -m judge.cli --root ... update 1-recherche-dictionnaire
```

Seven verbs and no more. `--root` is global and comes before the command; `--duration` belongs
to its command and comes after it. `-B` because the judge lives in the vault, and a vault is
plain files a person edits: no `__pycache__` belongs there. This is exactly what the plugin
runs: the working directory is the plugin's own folder, and `--root` is the drills folder Ose
resolved, absolute.

Every command prints **one JSON object** on stdout: `{"ok": true, "command": …, …}` or
`{"ok": false, "error": …, "error_kind": …}` with exit code 1. `error_kind` is `not_found`,
`bad_request`, `not_judgeable`, `timeout`, `run` or `internal`. Progress markers
(`@@STATUS {...}`) and anything the judge prints for a human go to stderr. The result line is
ASCII-safe JSON, so `é` crosses any console code page as `é` and comes back as `é` after
`JSON.parse`; every file is read and written UTF-8 with LF.

The tests are `python -B -m judge.test_cli` (stdlib, no pytest): they build a throwaway drill
tree in the temp dir and drive the CLI as a real subprocess.

## Rules this plugin keeps

- It writes nothing outside the drills folder, and nothing inside a drill folder except your
  answer file — and that only when you have changed it. `Delete…` sends a folder to the trash
  and nothing else ever removes a file.
- Its numbers live beside the data, never in `.ose/state.json`.
- Python is stdlib only, no pip, no network. The interface is plain ES modules and one
  stylesheet built from the kernel's tokens, over the shared `../_lib/drills.js`.
- `log.jsonl` is append only. A correction is a new line.
