"""Checker for kind=code.

1. save solution.py (the real folder stays the source of truth for the editor)
2. parse it, run the signature + constraint checks (no execution)
3. copy the problem folder to a private sandbox *without* correction.py, drop
   the submitted source in it, run tests.py there in an isolated subprocess,
   compare in the parent

All tests pass -> pass, some -> partial, none / constraint violation / crash
-> fail.

Judging one problem is serialised by a per-problem lock, and every run gets its
own sandbox, so two submissions landing together can never read each other's
solution.py, each other's __pycache__, or the reference solution.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from . import astcheck

KIND = "code"

RUNNER = Path(__file__).with_name("_child_runner.py")

#: Per test case, as the contract says. The whole run is capped separately so
#: a runaway suite cannot hold a request open forever.
DEFAULT_TIMEOUT = 5.0
CASES_BUDGET_FACTOR = 8.0   # total cap = per-case budget × this …
MAX_TOTAL_TIMEOUT = 40.0    # … never more than this

#: Never copied into the sandbox: the reference solution must be unreachable
#: from the submitted code, and cached bytecode must never be reused.
SANDBOX_EXCLUDE = frozenset({"correction.py", "correction.md", "__pycache__"})

NO_FUNCTION = ("meta.json declares no function: this drill cannot be tested "
               "(`code.function` is missing).")

_LOCKS: dict = {}
_LOCKS_GUARD = threading.Lock()

_LIVE_CHILDREN: set = set()
_LIVE_GUARD = threading.Lock()


def timeout_seconds() -> float:
    raw = os.environ.get("NSI_JUDGE_TIMEOUT")
    if raw:
        try:
            return max(0.2, float(raw))
        except ValueError:
            pass
    return DEFAULT_TIMEOUT


def total_cap_seconds(per_case: float) -> float:
    """Ceiling for one whole run, whatever the number of cases."""
    return min(max(per_case * CASES_BUDGET_FACTOR, per_case + 1.0), MAX_TOTAL_TIMEOUT)


# ------------------------------------------------------------------ plumbing


def problem_lock(pid: str) -> threading.Lock:
    """One lock per problem id, created on demand."""
    with _LOCKS_GUARD:
        lock = _LOCKS.get(pid)
        if lock is None:
            lock = _LOCKS[pid] = threading.Lock()
        return lock


def purge_pycache(folder) -> int:
    """Delete every __pycache__ under `folder`. Returns how many were removed.

    Bytecode caches are keyed on (mtime seconds, size): resubmitting a file of
    the same length inside the same second would otherwise be graded against
    the previous code.
    """
    folder = Path(folder)
    removed = 0
    try:
        targets = [folder / "__pycache__"] + list(folder.rglob("__pycache__"))
    except OSError:
        return 0
    for target in targets:
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
            removed += 1
    return removed


def _child_env() -> dict:
    """Environment for the child.

    `-I` makes Python ignore PYTHON* variables, so `-B -X utf8` on the command
    line is what actually does the work; these are belt and braces for anyone
    who drops the flags, and LANG keeps a launchd-started server (no locale at
    all) from encoding French test names in ASCII.
    """
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env.setdefault("LANG", "fr_FR.UTF-8")
    env.setdefault("LC_ALL", "fr_FR.UTF-8")
    return env


def _kill_tree(proc) -> None:
    """Kill the child *and* anything it spawned (it owns its own session)."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        return
    except (AttributeError, OSError):
        pass
    try:
        proc.kill()
    except OSError:
        pass


def kill_running_children() -> int:
    """Kill every judge child still running. Called on server shutdown."""
    with _LIVE_GUARD:
        live = list(_LIVE_CHILDREN)
    for proc in live:
        if proc.poll() is None:
            _kill_tree(proc)
    return len(live)


def _make_sandbox(problem, source: str | None) -> Path:
    """Private copy of the problem folder, minus the correction and bytecode."""
    sandbox = Path(tempfile.mkdtemp(prefix="nsi-judge-"))
    try:
        for item in problem.path.iterdir():
            if item.name in SANDBOX_EXCLUDE:
                continue
            dest = sandbox / item.name
            if item.is_dir():
                shutil.copytree(item, dest,
                                ignore=shutil.ignore_patterns("__pycache__"),
                                dirs_exist_ok=True)
            else:
                shutil.copyfile(item, dest)
    except OSError as exc:
        print(f"[judge] partial copy of the folder {problem.id} ({exc})")
    if source is not None:
        (sandbox / "solution.py").write_text(source, encoding="utf-8", newline="")
    purge_pycache(sandbox)
    return sandbox


# ----------------------------------------------------------------- the run


def run_tests(problem, budget: float | None = None, source: str | None = None) -> dict:
    """Spawn the child runner. Never imports problem code in this process."""
    budget = budget or timeout_seconds()
    code_meta = problem.code_meta
    if not (problem.path / "tests.py").is_file():
        return {"ok": False, "error": "tests.py is missing from the drill folder.",
                "results": [], "tests": []}

    nonce = secrets.token_hex(16)
    cfg = {
        "function": code_meta.get("function"),
        "return_type": code_meta.get("return_type"),
        "budget": budget,                          # per test case
        "total_cap": total_cap_seconds(budget),    # ceiling for the whole run
        "nonce": nonce,
    }

    purge_pycache(problem.path)  # the app never leaves bytecode in a problem folder
    sandbox = _make_sandbox(problem, source)
    try:
        return _run_in(sandbox, cfg, budget, nonce)
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


def _run_in(sandbox: Path, cfg: dict, budget: float, nonce: str) -> dict:
    argv = [sys.executable, "-I", "-B", "-X", "utf8", str(RUNNER),
            json.dumps(cfg, ensure_ascii=False)]
    try:
        proc = subprocess.Popen(
            argv,
            cwd=str(sandbox),
            stdin=subprocess.DEVNULL,   # input() must fail fast, not eat the terminal
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_child_env(),
            start_new_session=True,     # so we can kill the whole group
        )
    except OSError as exc:
        return {"ok": False, "error": f"could not start Python: {exc}",
                "results": [], "tests": []}

    with _LIVE_GUARD:
        _LIVE_CHILDREN.add(proc)

    # The child stops itself at its own total cap; give it a little more so a
    # graceful in-child abort wins over the kill whenever possible.
    hard = total_cap_seconds(budget) + 3.0
    timed_out = False
    try:
        try:
            out, err = proc.communicate(timeout=hard)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_tree(proc)
            try:
                out, err = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:  # pragma: no cover
                out, err = "", ""
    finally:
        with _LIVE_GUARD:
            _LIVE_CHILDREN.discard(proc)

    names, hung = _parse_progress(err)
    line, spoofed = _last_json_line(out, nonce)

    if timed_out and line is not None:
        # The child did finish and signed its answer; something it left running
        # (a thread, a detached subprocess) held the pipe open. Trust the line.
        timed_out = False

    if timed_out:
        return {
            "ok": False,
            "timeout": True,
            "tests": names,
            "hung_test": hung,
            "error": _timeout_message(hung, budget),
            "results": _timeout_results(names, hung, budget),
        }

    if line is None:
        if spoofed:
            return {"ok": False, "tests": names, "results": [],
                    "error": "unauthenticated result: the test runner's output was faked."}
        detail = (err or out or "").strip()[-600:]
        return {"ok": False, "tests": names, "results": [],
                "error": "the test runner returned nothing" + (f": {detail}" if detail else "")}
    return line


def _timeout_message(hung, budget) -> str:
    if hung:
        return (f"timed out ({budget:g} s) during the test “{hung}”: "
                f"infinite loop, or too slow?")
    return f"timed out ({budget:g} s): infinite loop, or too slow?"


def _timeout_results(names, hung, budget) -> list:
    results = []
    for name in names:
        if name == hung:
            results.append({"name": name, "ok": False, "call": "", "expected_repr": "",
                            "got_repr": "", "error": _timeout_message(name, budget),
                            "timeout": True})
        else:
            results.append({"name": name, "ok": False, "call": "", "expected_repr": "",
                            "got_repr": "", "error": "not run (stopped after the timeout)",
                            "skipped": True})
    return results


def _parse_progress(stderr_text: str):
    names, hung = [], None
    for line in (stderr_text or "").splitlines():
        if line.startswith("@@TESTS "):
            try:
                value = json.loads(line[len("@@TESTS "):])
                if isinstance(value, list):
                    names = [str(v) for v in value]
            except json.JSONDecodeError:
                pass
        elif line.startswith("@@PROGRESS "):
            try:
                value = json.loads(line[len("@@PROGRESS "):])
                if isinstance(value, dict):
                    hung = str(value.get("name"))
            except json.JSONDecodeError:
                pass
    return names, hung


def _last_json_line(text: str, nonce: str | None = None):
    """Last json object on stdout carrying `nonce`.

    Returns (object_or_None, saw_unsigned_json). Submitted code can print
    whatever it likes on fd 1: without the nonce the parent generated for this
    run, it is not a result.
    """
    spoofed = False
    for line in reversed((text or "").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        if nonce is not None:
            if obj.get("nonce") != nonce:
                spoofed = True
                continue
            obj.pop("nonce", None)
        return obj, spoofed
    return None, spoofed


# -------------------------------------------------------------------- judge


def judge(problem, content: str | None) -> dict:
    """Static checks then dynamic tests. Returns the submit payload.

    Serialised per problem: the answer file write, the read-back and the run
    belong together, and two browser tabs submitting at once must not grade
    each other's code.
    """
    with problem_lock(problem.id):
        return _judge_locked(problem, content)


def _judge_locked(problem, content: str | None) -> dict:
    if content is not None:
        problem.write_answer(content)
    source = problem.read_answer()

    code_meta = problem.code_meta or {}
    if not code_meta.get("function"):
        return {
            "verdict": "fail",
            "tests": [],
            "constraint_violations": [
                astcheck.violation("meta", "code.function", None, NO_FUNCTION)
            ],
            "failed_tests": [],
            "passed": 0,
            "total": 0,
            "error": NO_FUNCTION,
        }

    violations = astcheck.check(source, code_meta)
    if violations:
        return {
            "verdict": "fail",
            "tests": [],
            "constraint_violations": violations,
            "failed_tests": [],
            "passed": 0,
            "total": 0,
            "error": violations[0]["message"],
        }

    outcome = run_tests(problem, source=source)
    results = outcome.get("results") or []
    names = outcome.get("tests") or [r.get("name") for r in results]

    if not outcome.get("ok"):
        # import error, missing tests.py, timeout, crashed runner
        if not results:
            results = [
                {"name": n, "ok": False, "call": "", "expected_repr": "",
                 "got_repr": "", "error": outcome.get("error") or "error"}
                for n in names
            ]
        return {
            "verdict": "fail",
            "tests": results,
            "constraint_violations": [],
            "failed_tests": [r["name"] for r in results if not r.get("ok")],
            "passed": 0,
            "total": len(results),
            "error": outcome.get("error") or "the run failed",
            "timeout": bool(outcome.get("timeout")),
        }

    truncated = bool(outcome.get("timed_out_at"))
    if truncated:
        # The run was cut short. Without this the missing cases would simply
        # vanish and "5/5, partial" would be reported for a 6-case suite.
        results = list(results) + [
            {"name": n, "ok": False, "call": "", "expected_repr": "", "got_repr": "",
             "error": "not run: out of time", "skipped": True}
            for n in names[len(results):]
        ]

    total = len(results)
    passed = sum(1 for r in results if r.get("ok"))
    if total and passed == total and not truncated:
        verdict = "pass"
    elif passed > 0:
        verdict = "partial"
    else:
        verdict = "fail"

    payload = {
        "verdict": verdict,
        "tests": results,
        "constraint_violations": [],
        "failed_tests": [r["name"] for r in results if not r.get("ok")],
        "passed": passed,
        "total": total,
    }
    slow = next((r["name"] for r in results if r.get("timeout")), None)
    if truncated or slow:
        payload["timeout"] = True
        payload["error"] = _timeout_message(
            outcome.get("timed_out_at") or slow, timeout_seconds())
    return payload


# ------------------------------------------------------------------ interface


def submit(problem, payload: dict) -> dict:
    content = payload.get("content")
    if content is not None and not isinstance(content, str):
        raise ValueError("`content` must be a string")
    result = judge(problem, content)
    result["graded"] = True
    return result


def supports_selfgrade() -> bool:
    return False
