"""The two ways a submission is graded, and the state it moves.

There is one kind of problem, so there is no registry any more: `has_tests`
picks the path. With cases, `code_checker` runs them and the verdict is the
judge's. Without, the correction is handed over and the user self-grades — and
`selfgrade` is valid for every judged problem, tests or not, because a suite
that passes is not the same thing as an answer you are happy with.

Every drill is the app's own: there is nothing here that belongs to a course,
so there is nothing to refuse on those grounds either.
"""

from __future__ import annotations

from . import code_checker, scheduler

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
               correction_viewed=False, extra=None) -> dict:
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
    if extra:
        entry.update(extra)
    return entry


def _record(store, problem, verdict, result, payload, today=None) -> dict:
    """Advance state and append the log line as one step.

    The duration is parsed *first*: a malformed `duration_s` used to blow up
    between the state write and the log append, leaving a problem marked solved
    with no line in log.jsonl to show for it.
    """
    duration_s = _duration(payload)
    new_state = store.update_problem_state(
        problem.id, lambda cur: scheduler.apply_verdict(cur, verdict, today)
    )
    entry = store.append_log(
        _log_entry(problem, verdict, new_state["attempts"], result, duration_s,
                   correction_viewed=new_state.get("correction_viewed"))
    )
    result["state"] = state_view(new_state)
    result["logged"] = entry
    return result


def state_view(entry: dict, today=None) -> dict:
    view = dict(entry)
    view["status"] = scheduler.display_status(entry, today)
    return view


# -------------------------------------------------------------------- actions


def submit(store, problem, payload: dict, today=None) -> dict:
    if not problem.has_tests:
        if not problem.has_correction:
            raise NotJudgeable(NOT_JUDGEABLE)
        return _hand_over_correction(store, problem, payload or {}, today)

    result = code_checker.submit(problem, payload or {})
    verdict = result.get("verdict")
    if result.get("graded") and verdict in VERDICTS:
        _record(store, problem, verdict, result, payload, today)
        if verdict == "pass" and "correction" not in result:
            result["correction"] = problem.correction()
            result["correction_format"] = problem.correction_format
    else:
        result.setdefault("state", state_view(store.problem_state(problem.id), today))
    return result


def _hand_over_correction(store, problem, payload: dict, today=None) -> dict:
    """No cases to run: save the answer, show the correction, await the grade.

    Nothing is recorded here — no verdict, no log line. The one thing the state
    remembers is that the correction was seen, so the self-graded `pass` that
    follows collects the 7-day interval and not the 14 days a clean first solve
    earns.
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

    correction = problem.correction()
    new_state = store.update_problem_state(problem.id, scheduler.mark_correction_viewed)
    return {
        "verdict": None,
        "graded": False,
        "awaiting_selfgrade": True,
        "correction": correction or "",
        "correction_format": problem.correction_format,
        "answer": problem.read_answer(),
        "state": state_view(new_state, today),
    }


def selfgrade(store, problem, payload: dict, today=None) -> dict:
    """Record a grade the user gave themselves. Valid for every judged problem."""
    verdict = (payload or {}).get("verdict")
    if verdict not in VERDICTS:
        raise ValueError("`verdict` must be pass, partial or fail")
    if not problem.judged:
        # There is nothing to have read: a self-grade here is a number about
        # nothing, and the spaced review would run off it.
        raise NotJudgeable(NOT_JUDGEABLE)
    result = {"verdict": verdict, "graded": True}
    _record(store, problem, verdict, result, payload, today)
    return result


def reveal(store, problem, today=None) -> dict:
    """Show the correction. On an unsolved problem this counts as a failure.

    A reveal is not a submission, so it adds no log line: only the state moves
    (status failed, due tomorrow, interval 1, correction_viewed true).
    """
    if not problem.has_correction:
        raise NotJudgeable("there is no correction in this folder yet")
    new_state = store.update_problem_state(
        problem.id, lambda cur: scheduler.apply_reveal(cur, today)
    )
    correction = problem.correction()
    return {
        "correction": correction or "",
        "correction_format": problem.correction_format,
        "state": state_view(new_state, today),
    }
