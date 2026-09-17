"""The two ways a submission is graded, and the line it writes.

There is one kind of problem, so there is no registry any more: `has_tests`
picks the path. With cases, `code_checker` runs them and the verdict is the
judge's. Without, the correction is handed over and the user self-grades — and
`selfgrade` is valid for every judged problem, tests or not, because a suite
that passes is not the same thing as an answer you are happy with.

Nothing is scheduled and nothing is stored: the judge judges, appends one line
to log.jsonl and stops. What comes next is decided by an agent reading that
file.
"""

from __future__ import annotations

from . import code_checker

VERDICTS = ("pass", "partial", "fail")

#: A drill with no cases and no correction cannot be graded by anybody. Saying
#: so is the whole answer: the old code dropped into the self-grade path and one
#: click on `passed` wrote a solve against a placeholder (ADV-N).
NOT_JUDGEABLE = ("nothing to judge: this drill has no tests and no correction "
                 "yet")


class NotJudgeable(ValueError):
    """Raised by `submit` when there is nothing to grade the answer against."""


# --------------------------------------------------------------- log helpers


MAX_DURATION = 24 * 3600  # a sitting longer than a day is a clock glitch


def _duration(payload) -> int:
    """Seconds spent, clamped. Never raises: `1e999` is inf, not a 500."""
    value = (payload or {}).get("duration_s")
    try:
        value = int(round(float(value)))
    except (TypeError, ValueError, OverflowError):
        return 0
    return max(0, min(value, MAX_DURATION))


def _log_entry(problem, verdict, attempt, result, duration_s,
               correction_viewed=False, code=None) -> dict:
    entry = {
        "problem": problem.id,
        "verdict": verdict,
        "attempt": attempt,
        "failed_tests": list(result.get("failed_tests") or []),
        "constraint_violations": [
            v.get("construct") for v in (result.get("constraint_violations") or [])
        ],
        "duration_s": duration_s,
        "correction_viewed": bool(correction_viewed),
        "tags": problem.tags,
    }
    if code is not None:
        # The exact source that was judged, so an agent reading the log sees
        # how an attempt failed and not only that it failed.
        entry["code"] = code
    return entry


def _record(store, problem, verdict, result, payload, correction_viewed=None) -> dict:
    """Append the one line this submission is worth.

    The attempt number is the count of graded lines this drill already has,
    plus one: the log is the record, so it is also where the count comes from.
    The duration is parsed first, because a malformed `duration_s` used to blow
    up after the state was written and leave a solve with no line to show for
    it.
    """
    duration_s = _duration(payload)
    seen = store.correction_seen(problem.id) if correction_viewed is None \
        else bool(correction_viewed)
    entry = store.append_log(
        _log_entry(problem, verdict, store.attempts(problem.id) + 1, result,
                   duration_s, correction_viewed=seen,
                   code=problem.read_answer())
    )
    result["logged"] = entry
    return result


# -------------------------------------------------------------------- actions


def submit(store, problem, payload: dict) -> dict:
    if not problem.has_tests:
        if not problem.has_correction:
            raise NotJudgeable(NOT_JUDGEABLE)
        return _hand_over_correction(problem, payload or {})

    result = code_checker.submit(problem, payload or {})
    verdict = result.get("verdict")
    if result.get("graded") and verdict in VERDICTS:
        _record(store, problem, verdict, result, payload)
        if verdict == "pass" and "correction" not in result:
            result["correction"] = problem.correction()
            result["correction_format"] = problem.correction_format
    return result


def _hand_over_correction(problem, payload: dict) -> dict:
    """No cases to run: read the answer back, show the correction, await the grade.

    Nothing is recorded here — no verdict, no log line. The line comes with the
    grade, and it says the correction was seen, because grading yourself
    against it is the only thing it can mean.
    """
    content = payload.get("content")
    if content is not None and not isinstance(content, str):
        raise ValueError("`content` must be a string")
    text = content if content is not None else problem.read_answer()
    if not (text or "").strip():
        # Checked before anything is written: an empty submit used to truncate
        # the answer to nothing and hand over the correction anyway.
        raise ValueError("the answer is empty")
    if content is not None:
        problem.write_answer(content)

    return {
        "verdict": None,
        "graded": False,
        "awaiting_selfgrade": True,
        "correction": problem.correction() or "",
        "correction_format": problem.correction_format,
        "answer": problem.read_answer(),
    }


def selfgrade(store, problem, payload: dict) -> dict:
    """Record a grade the user gave themselves. Valid for every judged problem."""
    verdict = (payload or {}).get("verdict")
    if verdict not in VERDICTS:
        raise ValueError("`verdict` must be pass, partial or fail")
    if not problem.judged:
        # There is nothing to have read: a self-grade here is a number about
        # nothing.
        raise NotJudgeable(NOT_JUDGEABLE)
    result = {"verdict": verdict, "graded": True}
    _record(store, problem, verdict, result, payload, correction_viewed=True)
    return result


def reveal(store, problem, payload=None) -> dict:
    """Show the correction. On a drill that has never passed this is a failure.

    That failure is a log line, because the log is the only record: a rule the
    page prints and the file does not carry would be a rule that does nothing.
    The line says `correction_viewed` and has no `code`: nothing was judged.
    """
    if not problem.has_correction:
        raise NotJudgeable("there is no correction in this folder yet")
    result = {"correction": problem.correction() or "",
              "correction_format": problem.correction_format}
    if not store.solved(problem.id):
        entry = _log_entry(problem, "fail", store.attempts(problem.id) + 1,
                           {}, _duration(payload), correction_viewed=True)
        result["logged"] = store.append_log(entry)
    return result
