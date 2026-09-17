#!/usr/bin/env python3
"""Informatique judge: the command line the Ose module drives.

    python -m judge.cli <command> --root <drills root> [--json]

`--root` is the drills folder: a flat directory of `N-slug/` folders.
`state.json`, `log.jsonl` and the module's `clocks.json` live in `<root>/.nsi`.

Seven verbs and no more: `list`, `next`, `detail`, `submit`, `selfgrade`,
`reveal`, `update`. The one-off chores this file used to carry — create,
convert, migrate, migrate-flat — are gone, with `stats` and `log`, which
nothing could reach.

Every command prints exactly **one JSON object** on stdout and nothing else:

    {"ok": true, "command": "list", ...}          success
    {"ok": false, "command": "detail", "error": "...", "error_kind": "not_found"}

Anything the judge prints for a human (index warnings, child output) goes to
stderr, as do progress markers (`@@STATUS {...}`) a caller can stream.

Encoding: the result line is ASCII-safe JSON (`\\u00e9` for `é`), so a French
statement survives any console code page on the way out and `JSON.parse`
restores it exactly. Files are read and written as UTF-8 throughout.

Stdlib only. Exit codes: 0 ok, 1 command failed, 2 usage error.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):  # `python judge/cli.py` as well as `-m judge.cli`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from judge import dispatch, problems as problems_mod, scheduler  # noqa: E402
from judge import store as store_mod  # noqa: E402

VERDICTS = dispatch.VERDICTS
DATA_DIRNAME = ".nsi"


class CliError(Exception):
    """A failure to report as one JSON object instead of a traceback."""

    def __init__(self, message: str, kind: str = "error"):
        super().__init__(message)
        self.message = message
        self.kind = kind


# ------------------------------------------------------------------ plumbing


def status(text: str) -> None:
    """One progress marker on stderr. The module streams these into the panel."""
    sys.stderr.write("@@STATUS " + json.dumps({"text": text}) + "\n")
    sys.stderr.flush()


def _read_stdin() -> str:
    """Everything on stdin, decoded as UTF-8 whatever the console code page."""
    buffer = getattr(sys.stdin, "buffer", None)
    if buffer is not None:
        return buffer.read().decode("utf-8", "replace")
    return sys.stdin.read()


def _utf8(stream):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace", newline="\n")
    except (AttributeError, ValueError):
        pass
    return stream


class App:
    """Index + store over one data root. No server, no threads of its own."""

    def __init__(self, root: Path, data_dir: Path):
        self.root = Path(root).resolve()
        self.data_dir = Path(data_dir).resolve()
        if not self.root.is_dir():
            raise CliError(f"no drills folder here: {self.root}", "not_found")
        self.store = store_mod.Store(self.data_dir)
        self.index = problems_mod.scan(self.root)

    def problem(self, pid: str):
        problem = self.index.get(pid)
        if problem is None:
            raise CliError(f"unknown drill: {pid}", "not_found")
        return problem

    def timings(self) -> dict:
        """Per drill, the last timed submission and the best passing one.

        Both come out of `log.jsonl`, which is the only place a duration is
        ever written. A `duration_s` of 0 means the submission was not timed —
        the flag was left off — and is not a personal best of zero seconds, so
        it counts for neither.
        """
        out = {}
        for entry in self.store.read_log():        # newest first
            pid = entry.get("problem")
            if not isinstance(pid, str):
                continue
            try:
                seconds = int(entry.get("duration_s") or 0)
            except (TypeError, ValueError):
                seconds = 0
            row = out.setdefault(pid, {"duree_s": None, "meilleure_s": None})
            if seconds <= 0:
                continue
            if row["duree_s"] is None:
                row["duree_s"] = seconds
            if entry.get("verdict") == "pass" and (
                    row["meilleure_s"] is None or seconds < row["meilleure_s"]):
                row["meilleure_s"] = seconds
        return out

    # ------------------------------------------------------------- listings

    NO_TIMING = {"duree_s": None, "meilleure_s": None}

    def row(self, problem, entry, timing=None, today=None) -> dict:
        """One line of `list`. `detail` is this plus the files and the text."""
        status_now = scheduler.display_status(entry, today)
        item = problem.summary()
        item.update(timing or dict(self.NO_TIMING))
        item.update({
            "status": status_now,
            "due": entry["due"],
            "attempts": entry["attempts"],
            "solved_at": entry["solved_at"],
            "interval_days": entry["interval_days"],
            "correction_viewed": entry["correction_viewed"],
            "overdue_days": max(0, scheduler.overdue_days(entry, today))
            if status_now == "due" else 0,
        })
        return item

    def listing(self, today=None) -> list:
        states = self.store.all_problem_states()
        timings = self.timings()
        out = [self.row(problem,
                        store_mod.normalise(states.get(problem.id)),
                        timings.get(problem.id), today)
               for problem in self.index.values()]
        out.sort(key=lambda it: problems_mod.number_key(it["number"], it["id"]))
        return out

    def next_up(self, today=None) -> dict:
        # Every row already carries its `tags`, which is what the scheduler's
        # last rule picks on: one name, and nothing lent and taken back.
        item, reason = scheduler.pick_next(self.listing(today),
                                           self.store.read_log(), today)
        if item is None:
            return {"empty": True, "reason": reason, "drill": None}
        return {"empty": False, "reason": reason, "drill": item}

    def detail(self, pid: str, today=None) -> dict:
        problem = self.problem(pid)
        entry = self.store.problem_state(pid)
        payload = self.row(problem, entry, self.timings().get(pid), today)
        payload.update({
            "meta": problem.public_meta(),
            "enonce": problem.enonce(),
            "answer": problem.read_answer(),
            "answer_file": problem.answer_filename,
            "answer_exists": problem.answer_path.exists(),
            # Every path is relative to the data root, and `answer_path`,
            # `enonce_path` and `tests_path` are given whether or not the file
            # is there: they are where it goes, not only where it is.
            "answer_path": self.relative(problem.answer_path),
            "enonce_path": self.relative(problem.enonce_path),
            "tests_path": self.relative(problem.tests_path),
            "correction_path": self.relative(problem.correction_path),
            "correction_format": problem.correction_format,
            "folder": self.relative(problem.path),
            "state": dispatch.state_view(entry, today),
        })
        return payload

    def relative(self, path) -> str:
        """A path the module can hand to `ose.files`, relative to the data root."""
        if path is None:
            return None
        try:
            return Path(path).resolve().relative_to(self.root).as_posix()
        except ValueError:
            return Path(path).as_posix()


# ------------------------------------------------------------------ commands


def cmd_list(app: App, args) -> dict:
    return {"drills": app.listing(),
            "data_dir": str(app.data_dir), "root": str(app.root)}


def cmd_next(app: App, args) -> dict:
    return app.next_up()


def cmd_detail(app: App, args) -> dict:
    return app.detail(args.id)


def cmd_submit(app: App, args) -> dict:
    problem = app.problem(args.id)
    payload = {"duration_s": args.duration}
    status(f"judging {problem.id}…" if problem.has_tests
           else f"reading {problem.id} back…")
    try:
        result = dispatch.submit(app.store, problem, payload)
    except dispatch.NotJudgeable as exc:
        raise CliError(str(exc), "not_judgeable")
    except ValueError as exc:
        raise CliError(str(exc), "bad_request")
    status("done")
    result["id"] = problem.id
    result["status"] = (result.get("state") or {}).get("status")
    return result


def cmd_selfgrade(app: App, args) -> dict:
    problem = app.problem(args.id)
    if args.verdict not in VERDICTS:
        raise CliError("`verdict` must be pass, partial or fail", "bad_request")
    try:
        result = dispatch.selfgrade(app.store, problem,
                                    {"verdict": args.verdict, "duration_s": args.duration})
    except dispatch.NotJudgeable as exc:
        raise CliError(str(exc), "not_judgeable")
    except ValueError as exc:
        raise CliError(str(exc), "bad_request")
    result["id"] = problem.id
    result["status"] = (result.get("state") or {}).get("status")
    return result


def cmd_reveal(app: App, args) -> dict:
    problem = app.problem(args.id)
    try:
        result = dispatch.reveal(app.store, problem)
    except dispatch.NotJudgeable as exc:
        raise CliError(str(exc), "not_judgeable")
    except ValueError as exc:
        raise CliError(str(exc), "bad_request")
    result["id"] = problem.id
    result["status"] = (result.get("state") or {}).get("status")
    return result


# -------------------------------------------------------------------- update


def _member_spans(raw: str) -> dict:
    """{key: (key_start, value_start, value_end)} for a JSON object's own keys.

    The decoder does the reading, so a key or a value containing a brace, a
    bracket or an escaped quote is measured correctly rather than guessed at
    with a regular expression. Used to change one member of `meta.json` and
    leave every other byte of the file exactly where it was.
    """
    decoder = json.JSONDecoder()
    spans = {}
    n = len(raw)
    i = 0
    while i < n and raw[i].isspace():
        i += 1
    if i >= n or raw[i] != "{":
        return spans
    i += 1
    while True:
        while i < n and (raw[i].isspace() or raw[i] == ","):
            i += 1
        if i >= n or raw[i] != '"':
            return spans
        try:
            key, after_key = decoder.raw_decode(raw, i)
            j = after_key
            while j < n and raw[j].isspace():
                j += 1
            if j >= n or raw[j] != ":":
                return spans
            j += 1
            while j < n and raw[j].isspace():
                j += 1
            _value, end = decoder.raw_decode(raw, j)
        except ValueError:
            return spans
        spans[key] = (i, j, end)
        i = end


def _render(value, indent: str) -> str:
    """`value` as JSON, laid out like the rest of an indent-2 document."""
    text = json.dumps(value, ensure_ascii=False, indent=2)
    lines = text.split("\n")
    return ("\n" + indent).join(lines) if len(lines) > 1 else text


def _line_indent(raw: str, pos: int) -> str:
    start = raw.rfind("\n", 0, pos) + 1
    return raw[start:pos] if not raw[start:pos].strip() else ""


def set_members(raw: str, changes: dict) -> str:
    """Rewrite only `changes` inside the JSON object `raw`. Everything else
    — key order, indentation, spacing, accents, the trailing newline — is
    copied through untouched: only the one member the caller named moves."""
    spans = _member_spans(raw)
    if not spans:
        raise CliError("meta.json is not a JSON object this can read", "error")
    edits = []
    additions = {}
    for key, value in changes.items():
        if key in spans:
            _key_start, value_start, value_end = spans[key]
            edits.append((value_start, value_end,
                          _render(value, _line_indent(raw, value_start) or "  ")))
        else:
            additions[key] = value
    for start, end, text in sorted(edits, key=lambda e: -e[0]):
        raw = raw[:start] + text + raw[end:]

    if additions:
        # A key the file has never had goes last, indented like the others.
        spans = _member_spans(raw)
        last = max(spans.values(), key=lambda s: s[2]) if spans else None
        indent = _line_indent(raw, last[0]) if last else "  "
        indent = indent or "  "
        at = last[2] if last else raw.index("{") + 1
        block = "".join(
            f',\n{indent}{json.dumps(key, ensure_ascii=False)}: '
            f'{_render(value, indent)}'
            for key, value in additions.items())
        raw = raw[:at] + block + raw[at:]
    return raw


def cmd_update(app: App, args) -> dict:
    """Change the `tags` of one drill, and nothing else.

    The title lives in two places — `meta.json` and the H1 of `enonce.md` — and
    a rename that kept them together was the module's only writer of a file the
    user wrote. Renaming is opening `enonce.md`, which the row menu already
    does; what is left here is the one field that has no other door.
    """
    problem = app.problem(args.id)
    try:
        spec = json.loads(_read_stdin() or "{}")
    except json.JSONDecodeError as exc:
        raise CliError(f"invalid JSON spec: {exc}", "bad_request")
    if not isinstance(spec, dict):
        raise CliError("the spec must be a JSON object", "bad_request")
    if "tags" not in spec:
        raise CliError("nothing to change: give `tags`", "bad_request")

    tags = spec.get("tags")
    if tags is None:
        tags = []
    if not isinstance(tags, list):
        raise CliError("`tags` must be a list", "bad_request")
    changes = {"tags": problems_mod.clean_tags(tags)}

    meta_path = problem.path / "meta.json"
    try:
        raw = meta_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise CliError(f"meta.json unreadable: {exc}", "error")

    # The file is being rewritten anyway, so an `id` left over from the nested
    # layout is straightened on the way past rather than left to rot. It was
    # never believed — the folder name is the id — and it is not reported as a
    # change the caller asked for. A `concepts` list is the old name of this
    # same field: it goes when `tags` lands, so the file says one thing.
    try:
        on_disk = json.loads(raw)
    except (json.JSONDecodeError, AttributeError):
        on_disk = {}
    if not isinstance(on_disk, dict):
        on_disk = {}
    if on_disk.get("id") is not None and on_disk["id"] != problem.id:
        changes["id"] = problem.id

    raw = set_members(raw, changes)
    if "concepts" in on_disk:
        raw = drop_member(raw, "concepts")
    meta_path.write_text(raw, encoding="utf-8", newline="")

    fresh = problems_mod.load_problem(meta_path)
    return {"id": problem.id, "folder": app.relative(problem.path),
            "updated": ["tags"],
            "title": fresh.title if fresh else problem.title,
            "tags": fresh.tags if fresh else changes["tags"]}


def drop_member(raw: str, key: str) -> str:
    """Take one member out of a JSON object's text, comma and all.

    The bytes around it do not move, the same way `set_members` leaves them.
    """
    spans = _member_spans(raw)
    if key not in spans:
        return raw
    key_start, _value_start, value_end = spans[key]
    # Swallow the separator: the comma before this member when there is one,
    # otherwise the comma after it.
    start = key_start
    before = raw.rfind(",", 0, key_start)
    if before >= 0 and not raw[before + 1:key_start].strip():
        start = before
    else:
        after = value_end
        while after < len(raw) and raw[after].isspace():
            after += 1
        if after < len(raw) and raw[after] == ",":
            value_end = after + 1
    return raw[:start] + raw[value_end:]


# --------------------------------------------------------------------- shell


COMMANDS = {
    "list": cmd_list,
    "next": cmd_next,
    "detail": cmd_detail,
    "submit": cmd_submit,
    "selfgrade": cmd_selfgrade,
    "reveal": cmd_reveal,
    "update": cmd_update,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="judge.cli",
        description="Informatique: the judge over the drill folders. "
                    "One JSON object per run.")
    parser.add_argument("--root", required=True, metavar="DIR",
                        help="the drills folder: a flat directory of N-slug/")
    parser.add_argument("--json", action="store_true",
                        help="print one JSON object (the default and only format)")
    sub = parser.add_subparsers(dest="command", metavar="command")

    def add(name, help_text):
        return sub.add_parser(name, help=help_text)

    add("list", "every drill with its state and its times")
    add("next", "the scheduler's next drill and why")
    add("detail", "one drill: meta, statement, answer, state").add_argument("id")
    submit = add("submit", "judge one drill, or hand over the correction when it "
                           "has no tests (the answer is read from disk)")
    submit.add_argument("id")
    submit.add_argument("--duration", type=float, default=0,
                        help="seconds spent, for the log line")
    grade = add("selfgrade", "record the self-grade (any judged drill)")
    grade.add_argument("id")
    grade.add_argument("verdict", choices=list(VERDICTS))
    grade.add_argument("--duration", type=float, default=0)
    add("reveal", "show the correction (counts as a failure if unsolved)").add_argument("id")
    add("update", "change the tags of one drill ({\"tags\": [...]} on stdin)"
        ).add_argument("id")
    return parser


def main(argv=None) -> int:
    _utf8(sys.stdout)
    _utf8(sys.stderr)
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help(sys.stderr)
        return 2

    # First thing on the wire: the caller now knows the process started and can
    # tell "still working" from "python could not even import the judge".
    sys.stderr.write("@@START " + json.dumps({"command": args.command}) + "\n")
    sys.stderr.flush()

    real_stdout = sys.stdout
    # The judge prints index warnings and child output with plain `print`. Send
    # all of it to stderr so the one JSON object on stdout stays parseable.
    sys.stdout = sys.stderr
    try:
        root = Path(args.root).expanduser()
        data_dir = root / DATA_DIRNAME
        payload = {}
        try:
            app = App(root, data_dir)
            payload = COMMANDS[args.command](app, args)
            body = {"ok": True, "command": args.command}
            body.update(payload if isinstance(payload, dict) else {"result": payload})
            code = 0
        except CliError as exc:
            body = {"ok": False, "command": args.command,
                    "error": exc.message, "error_kind": exc.kind}
            code = 1
        except Exception as exc:  # never a traceback on stdout
            body = {"ok": False, "command": args.command,
                    "error": f"{type(exc).__name__}: {exc}", "error_kind": "internal"}
            code = 1
    finally:
        sys.stdout = real_stdout

    # ASCII-safe: `é` leaves as é and arrives as `é` after JSON.parse,
    # whatever code page the pipe is decoded with.
    real_stdout.write(json.dumps(body, ensure_ascii=True, default=str) + "\n")
    real_stdout.flush()
    return code


if __name__ == "__main__":
    sys.exit(main())
