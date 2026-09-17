"""Runs one problem's tests in an isolated child process.

Invoked as: python -I -B -X utf8 _child_runner.py '<json config>' with cwd = a
private *copy* of the problem folder (never the folder itself, and never with
correction.py in it). It reads tests.py and solution.py from cwd, runs every
case on a fresh deep copy of the arguments, and prints exactly ONE json line on
stdout.

Three things make that line trustworthy:

- it carries the nonce the parent generated for this run, so user code cannot
  fake a result by writing its own json to fd 1 and exiting;
- `emit` fires at most once, so the first result wins;
- TESTS is deep-copied *before* solution.py is imported, so user code cannot
  rewrite the suite it is about to be graded against.

Anything the user's code prints is captured, never mixed into that line.
Progress markers go to the real stderr so the parent can name the test that
hung when it has to kill us.

Timeouts are per test case (`budget`): a case that runs over is reported as
that case failing and the next one still runs, so a slow but legitimate suite
is never cut mid-run. `total_cap` is the ceiling for the whole run.
"""

from __future__ import annotations

import copy
import io
import json
import math
import os
import sys
import threading
import time
import traceback

MAX_REPR = 400

REAL_STDOUT = sys.stdout
REAL_STDERR = sys.stderr
CWD = os.path.abspath(os.getcwd())

INPUT_HINT = ("do not use input(): the test runner calls your function with "
              "arguments")
COMPARE_FAIL = ("cannot compare: the value returned refuses to be "
                "compared")
NAN_HINT = ("careful: the expected value is NaN, which is never equal to "
            "itself")


def _read_config() -> dict:
    """Parse argv[1], then blank argv so imported user code cannot read it."""
    raw = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        cfg = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    del sys.argv[1:]
    return cfg


CFG = _read_config()
NONCE = str(CFG.get("nonce") or "")

_EMIT_LOCK = threading.Lock()
_EMITTED = False
CURRENT = {"index": None, "name": None}


def emit(obj) -> None:
    """Write the one and only result line. Later calls are ignored."""
    global _EMITTED
    with _EMIT_LOCK:
        if _EMITTED:
            return
        _EMITTED = True
        payload = dict(obj)
        if NONCE:
            payload["nonce"] = NONCE
        try:
            REAL_STDOUT.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
            REAL_STDOUT.flush()
        except Exception:  # pragma: no cover - stdout hijacked or closed
            pass


def progress(tag: str, payload) -> None:
    try:
        REAL_STDERR.write(f"@@{tag} {json.dumps(payload, ensure_ascii=False)}\n")
        REAL_STDERR.flush()
    except Exception:
        pass


def srepr(value) -> str:
    try:
        text = repr(value)
    except BaseException as exc:  # pragma: no cover - pathological __repr__
        text = f"<repr failed: {exc.__class__.__name__}>"
    if len(text) > MAX_REPR:
        text = text[:MAX_REPR] + " … (truncated)"
    return text


def _eq(a, b) -> bool:
    """`a == b` that never lets a hostile __eq__ escape."""
    try:
        return bool(a == b)
    except BaseException:
        raise CompareError()


class CompareError(Exception):
    """Raised when the submitted value refuses to be compared."""


def is_nan(value) -> bool:
    return isinstance(value, float) and math.isnan(value)


def deep_eq(a, b) -> bool:
    """Deep equality where a bool never equals an int.

    Raises CompareError if any comparison blows up, so the caller can report a
    clean failed test instead of losing the whole run.
    """
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a is b
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if is_nan(a) or is_nan(b):
            return False  # NaN is never equal to anything, itself included
        if _eq(a, b):
            return True
        try:
            return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12)
        except (OverflowError, ValueError, TypeError):
            return False
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        if type(a) is not type(b) or len(a) != len(b):
            return False
        return all(deep_eq(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        try:
            if set(a.keys()) != set(b.keys()):
                return False
        except BaseException:
            raise CompareError()
        return all(deep_eq(a[k], b[k]) for k in a)
    if isinstance(a, (set, frozenset)) and isinstance(b, (set, frozenset)):
        return _eq(set(a), set(b))
    return _eq(a, b)


TYPE_LABELS = {
    "int": "int", "float": "float", "number": "int or float", "str": "str",
    "bool": "bool", "list": "list", "dict": "dict", "tuple": "tuple",
    "set": "set", "none": "None",
}


def type_ok(value, wanted: str) -> bool:
    wanted = (wanted or "").strip().lower()
    if not wanted:
        return True
    if wanted == "bool":
        return isinstance(value, bool)
    if isinstance(value, bool):
        return False  # bool is not a number and not an int here
    if wanted == "number":
        return isinstance(value, (int, float))
    if wanted == "none":
        return value is None
    mapping = {
        "int": int, "float": float, "str": str, "list": list,
        "dict": dict, "tuple": tuple, "set": (set, frozenset),
    }
    cls = mapping.get(wanted)
    if cls is None:
        return True  # unknown type name: do not punish the student
    return isinstance(value, cls)


def type_name(value) -> str:
    return type(value).__name__


def user_traceback(exc: BaseException) -> str:
    """Traceback limited to frames inside the problem folder."""
    frames = traceback.extract_tb(exc.__traceback__)
    keep = [f for f in frames if os.path.abspath(os.path.dirname(f.filename or "")) == CWD]
    lines = traceback.format_list(keep) if keep else []
    lines.extend(traceback.format_exception_only(type(exc), exc))
    text = "".join(lines).strip()
    if len(text) > 2000:
        text = text[:2000] + " … (truncated)"
    return text


def error_text(exc: BaseException) -> str:
    """User-facing message for an exception raised by the submitted code."""
    if isinstance(exc, EOFError):
        return INPUT_HINT
    return user_traceback(exc)


def call_repr(name: str, args, kwargs) -> str:
    parts = [srepr(a) for a in args]
    parts += [f"{k}={srepr(v)}" for k, v in kwargs.items()]
    return f"{name}({', '.join(parts)})"


def snapshot_cases(cases) -> list:
    """Frozen copy of TESTS, taken BEFORE solution.py is imported.

    `check` stays the original callable (a function cannot be deep-copied
    usefully); everything else is deep-copied, so `import tests;
    tests.TESTS[:] = ...` or an in-place edit of a case no longer changes what
    is graded.
    """
    frozen = []
    for case in list(cases):
        if not isinstance(case, dict):
            frozen.append(case)
            continue
        clean = {}
        for key, value in case.items():
            if key == "check":
                clean[key] = value
                continue
            try:
                clean[key] = copy.deepcopy(value)
            except BaseException:
                clean[key] = value
        frozen.append(clean)
    return frozen


def case_names(cases) -> list:
    names = []
    for i, case in enumerate(cases):
        if isinstance(case, dict):
            names.append(str(case.get("name") or f"test {i + 1}"))
        else:
            names.append(f"test {i + 1}")
    return names


def call_with_timeout(fn, args, kwargs, budget):
    """Run one case with its own time budget.

    The call runs in a daemon thread: Python cannot interrupt a hung call, but
    a daemon thread does not keep the process alive, and the runner exits with
    os._exit anyway. Returns (value, exception, timed_out).
    """
    box = {"value": None, "exc": None}
    done = threading.Event()

    def target():
        try:
            box["value"] = fn(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001 - reported to the student
            box["exc"] = exc
        finally:
            done.set()

    worker = threading.Thread(target=target, daemon=True)
    worker.start()
    if not done.wait(max(0.05, budget)):
        return None, None, True
    return box["value"], box["exc"], False


def case_timeout_message(name, budget) -> str:
    return (f"timed out ({budget:g} s) during the test “{name}”: "
            f"infinite loop, or too slow?")


def timeout_payload(names, budget) -> dict:
    """Result line for a hard stop inside the child (a test never returned)."""
    hung = CURRENT.get("name")
    if hung:
        message = (f"timed out ({budget:g} s) during the test “{hung}”: "
                   f"infinite loop, or too slow?")
    else:
        message = f"timed out ({budget:g} s): infinite loop, or too slow?"
    results = []
    for name in names:
        if name == hung:
            results.append({"name": name, "ok": False, "call": "", "expected_repr": "",
                            "got_repr": "", "error": message, "timeout": True})
        else:
            results.append({"name": name, "ok": False, "call": "", "expected_repr": "",
                            "got_repr": "",
                            "error": "not run (stopped after the timeout)",
                            "skipped": True})
    return {"ok": False, "timeout": True, "tests": names, "hung_test": hung,
            "error": message, "results": results}


def start_watchdog(names, budget) -> None:
    """Self-destruct: the child never outlives its budget, even if orphaned.

    Protects against a hang inside one call (the per-case deadline is only
    checked between cases) and against the parent being killed outright.
    """
    def fire():
        emit(timeout_payload(names, budget))
        os._exit(0)

    timer = threading.Timer(max(0.2, budget + 0.5), fire)
    timer.daemon = True
    timer.start()


def main() -> int:
    func_name = CFG.get("function")
    return_type = CFG.get("return_type")
    try:
        per_case_s = float(CFG.get("budget", 5.0))
    except (TypeError, ValueError):
        per_case_s = 5.0
    try:
        total_cap_s = float(CFG.get("total_cap", per_case_s * 8.0))
    except (TypeError, ValueError):
        total_cap_s = per_case_s * 8.0

    sys.path.insert(0, CWD)  # -I implies -P, so cwd is not on the path
    captured = io.StringIO()
    sys.stdout = captured
    sys.stderr = captured

    # --- load tests.py -----------------------------------------------------
    try:
        import tests as tests_mod  # noqa: E402
    except BaseException as exc:
        sys.stdout = REAL_STDOUT
        emit({"ok": False, "phase": "tests", "error": error_text(exc)})
        return 0
    raw_cases = getattr(tests_mod, "TESTS", None)
    if not isinstance(raw_cases, (list, tuple)):
        sys.stdout = REAL_STDOUT
        emit({"ok": False, "phase": "tests",
              "error": "tests.py does not define a TESTS list."})
        return 0

    # Frozen before solution.py gets a chance to touch tests.TESTS.
    cases = snapshot_cases(raw_cases)
    names = case_names(cases)
    progress("TESTS", names)
    # Each case gets `per_case_s`; the whole run gets that times the number of
    # cases (plus a little slack), capped, so a legitimately slow suite is
    # never cut mid-run but a runaway one still ends.
    total_s = min(per_case_s * max(1, len(cases)) + 1.0, total_cap_s)
    start_watchdog(names, total_s)

    # --- load solution.py --------------------------------------------------
    try:
        import solution as sol_mod  # noqa: E402
    except BaseException as exc:
        sys.stdout = REAL_STDOUT
        emit({"ok": False, "phase": "import", "error": error_text(exc),
              "tests": names})
        return 0

    fn = getattr(sol_mod, func_name, None) if func_name else None
    if func_name and not callable(fn):
        sys.stdout = REAL_STDOUT
        emit({"ok": False, "phase": "function", "tests": names,
              "error": f"solution.py does not define a function `{func_name}`."})
        return 0
    if not func_name:
        sys.stdout = REAL_STDOUT
        emit({"ok": False, "phase": "function", "tests": names,
              "error": "meta.json declares no function to test."})
        return 0

    started = time.monotonic()
    results = []
    timed_out_at = None

    for index, case in enumerate(cases):
        name = names[index] if index < len(names) else f"test {index + 1}"
        CURRENT["index"], CURRENT["name"] = index, name
        progress("PROGRESS", {"index": index, "name": name})
        if time.monotonic() - started > total_s:
            timed_out_at = name
            break
        if not isinstance(case, dict):
            results.append({"name": name, "ok": False, "call": "",
                            "expected_repr": "", "got_repr": "",
                            "error": "malformed test case in tests.py",
                            "stdout": ""})
            continue

        args = tuple(case.get("args", ()))
        kwargs = dict(case.get("kwargs", {}))
        try:
            args = copy.deepcopy(args)
            kwargs = copy.deepcopy(kwargs)
        except BaseException:
            pass
        shown = call_repr(func_name or "solution", args, kwargs)

        has_expect = "expect" in case
        expected = case.get("expect")
        checker = case.get("check")
        expected_repr = srepr(expected) if has_expect else (
            "custom condition" if callable(checker) else "—"
        )

        before = captured.tell()
        record = {"name": name, "ok": False, "call": shown,
                  "expected_repr": expected_repr, "got_repr": "",
                  "error": None, "stdout": ""}
        got, raised, case_timed_out = call_with_timeout(fn, args, kwargs, per_case_s)
        if case_timed_out:
            record["error"] = case_timeout_message(name, per_case_s)
            record["timeout"] = True
            record["stdout"] = _drain(captured, before)
            results.append(record)
            continue
        if raised is not None:
            record["error"] = error_text(raised)
            record["stdout"] = _drain(captured, before)
            results.append(record)
            continue

        record["got_repr"] = srepr(got)
        if return_type and not type_ok(got, return_type):
            record["error"] = (
                f"expected return type {TYPE_LABELS.get(return_type, return_type)}, "
                f"got {type_name(got)}"
            )
            record["type_violation"] = True
            record["stdout"] = _drain(captured, before)
            results.append(record)
            continue

        if has_expect:
            try:
                record["ok"] = deep_eq(got, expected)
            except BaseException:
                record["ok"] = False
                record["error"] = COMPARE_FAIL
            if not record["ok"] and is_nan(expected) and record["error"] is None:
                record["error"] = NAN_HINT
        elif callable(checker):
            try:
                record["ok"] = bool(checker(copy.deepcopy(got)))
            except BaseException as exc:
                record["ok"] = False
                record["error"] = "check() failed: " + error_text(exc)
        else:
            record["ok"] = False
            record["error"] = "test case with neither `expect` nor `check`"
        record["stdout"] = _drain(captured, before)
        results.append(record)

    CURRENT["index"], CURRENT["name"] = None, None
    sys.stdout = REAL_STDOUT
    sys.stderr = REAL_STDERR
    emit({"ok": True, "tests": names, "results": results,
          "timed_out_at": timed_out_at})
    return 0


def _drain(buf: io.StringIO, before: int) -> str:
    try:
        text = buf.getvalue()[before:]
    except Exception:
        return ""
    if len(text) > 1000:
        text = text[:1000] + " … (truncated)"
    return text


if __name__ == "__main__":
    try:
        main()
    except BaseException as exc:  # last resort: still emit exactly one json line
        sys.stdout = REAL_STDOUT
        emit({"ok": False, "phase": "runner", "error": repr(exc)})
    # Hard exit: a correct solution that left a non-daemon thread (or an atexit
    # hook) behind must not keep the stdout pipe open and turn a pass into a
    # phantom timeout. The result line is already written and flushed.
    REAL_STDOUT.flush()
    os._exit(0)
