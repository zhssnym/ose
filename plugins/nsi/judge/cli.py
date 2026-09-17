#!/usr/bin/env python3
"""Code judge: the command line the Ose plugin drives.

    python -m judge.cli <command> --root <drills root>

`--root` is the drills folder: a flat directory of `N-slug/` folders.
`log.jsonl` and the plugin's `clocks.json` live in `<root>/.nsi`.

Four verbs and no more: `detail`, `submit`, `selfgrade`, `reveal`. The judge
judges and writes one log line; it decides nothing about what comes next and
keeps no state of its own. The listing is the plugin's own work, read off the
folder and the log, so there is no `list` here and no `next`.

Every command prints exactly **one JSON object** on stdout and nothing else:

    {"ok": true, "command": "detail", ...}          success
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

from judge import dispatch, problems as problems_mod  # noqa: E402
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
    """One progress marker on stderr. The plugin streams these into the panel."""
    sys.stderr.write("@@STATUS " + json.dumps({"text": text}) + "\n")
    sys.stderr.flush()


def _utf8(stream):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace", newline="\n")
    except (AttributeError, ValueError):
        pass
    return stream


class App:
    """Index + log over one data root. No server, no threads of its own."""

    def __init__(self, root: Path, data_dir: Path):
        self.root = Path(root).resolve()
        self.data_dir = Path(data_dir).resolve()
        if not self.root.is_dir():
            raise CliError(f"no drills folder here: {self.root}", "not_found")
        self.store = store_mod.Store(self.data_dir)
        self.index = problems_mod.scan(self.root)

    def problem(self, pid: str):
        # The index is the root's direct children, so an id that is not one of
        # them is unknown, `../..` included.
        problem = self.index.get(pid)
        if problem is None:
            raise CliError(f"unknown drill: {pid}", "not_found")
        return problem

    def detail(self, pid: str) -> dict:
        """One drill: what it is, where its files are, and its two texts."""
        problem = self.problem(pid)
        payload = problem.summary()
        payload.update({
            "enonce": problem.enonce(),
            "answer": problem.read_answer(),
            "answer_exists": problem.answer_path.exists(),
            # Paths are relative to the data root, and `answer_path` is given
            # whether or not the file is there: it is where the answer goes,
            # not only where it is.
            "answer_path": self.relative(problem.answer_path),
            "correction_path": self.relative(problem.correction_path),
            "correction_format": problem.correction_format,
            "folder": self.relative(problem.path),
        })
        return payload

    def relative(self, path) -> str:
        """A path the plugin can hand to `ose.files`, relative to the drills folder."""
        if path is None:
            return None
        try:
            return Path(path).resolve().relative_to(self.root).as_posix()
        except ValueError:
            return Path(path).as_posix()


# ------------------------------------------------------------------ commands


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
    return result


def cmd_selfgrade(app: App, args) -> dict:
    problem = app.problem(args.id)
    if args.verdict not in VERDICTS:
        raise CliError("`verdict` must be pass, partial or fail", "bad_request")
    try:
        result = dispatch.selfgrade(app.store, problem,
                                    {"verdict": args.verdict,
                                     "duration_s": args.duration})
    except dispatch.NotJudgeable as exc:
        raise CliError(str(exc), "not_judgeable")
    except ValueError as exc:
        raise CliError(str(exc), "bad_request")
    result["id"] = problem.id
    return result


def cmd_reveal(app: App, args) -> dict:
    problem = app.problem(args.id)
    try:
        result = dispatch.reveal(app.store, problem, {"duration_s": args.duration})
    except dispatch.NotJudgeable as exc:
        raise CliError(str(exc), "not_judgeable")
    except ValueError as exc:
        raise CliError(str(exc), "bad_request")
    result["id"] = problem.id
    return result


# --------------------------------------------------------------------- shell


COMMANDS = {
    "detail": cmd_detail,
    "submit": cmd_submit,
    "selfgrade": cmd_selfgrade,
    "reveal": cmd_reveal,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="judge.cli",
        description="Code: the judge over the drill folders. "
                    "One JSON object per run.")
    parser.add_argument("--root", required=True, metavar="DIR",
                        help="the drills folder: a flat directory of N-slug/")
    sub = parser.add_subparsers(dest="command", metavar="command")

    def add(name, help_text):
        return sub.add_parser(name, help=help_text)

    add("detail", "one drill: what it is, its files, its statement").add_argument("id")
    submit = add("submit", "judge one drill, or hand over the correction when it "
                           "has no tests (the answer is read from disk)")
    submit.add_argument("id")
    submit.add_argument("--duration", type=float, default=0,
                        help="seconds spent, for the log line")
    grade = add("selfgrade", "record the self-grade (any judged drill)")
    grade.add_argument("id")
    grade.add_argument("verdict", choices=list(VERDICTS))
    grade.add_argument("--duration", type=float, default=0)
    reveal = add("reveal", "show the correction (a failure line when never passed)")
    reveal.add_argument("id")
    reveal.add_argument("--duration", type=float, default=0)
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
