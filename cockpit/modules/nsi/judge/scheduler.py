"""Spaced repetition state machine.

Contract (app/CLAUDE.md):

    On pass: first-ever attempt with no correction viewed -> interval 14 days;
    solved within 2 attempts -> 7; otherwise 3. Passing a review multiplies the
    interval by 2.5 (cap 90 days).
    On fail or reveal-without-solve: status failed, due tomorrow, interval 1.
    Partial counts as fail for scheduling but is logged as partial.

A "review" is a pass on a problem whose due date had come: re-running a solved
problem that is not due yet is practice, counted as an attempt but leaving the
schedule alone. A failure clears `solved_at`; log.jsonl keeps the history.

Dates are ISO date strings (YYYY-MM-DD). The stored status is only
`unseen | failed | solved`; `due` is derived at read time (today >= due).
"""

from __future__ import annotations

import datetime as _dt

from . import store

FIRST_CLEAN_INTERVAL = 14
QUICK_INTERVAL = 7
STRUGGLE_INTERVAL = 3
FAIL_INTERVAL = 1
REVIEW_FACTOR = 2.5
MAX_INTERVAL = 90


def today() -> _dt.date:
    return _dt.date.today()


def iso(day: _dt.date) -> str:
    return day.isoformat()


def parse_date(value):
    if not value:
        return None
    try:
        return _dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def is_due(entry: dict, day: _dt.date | None = None) -> bool:
    day = day or today()
    if entry.get("status") != "solved":
        return False
    due = parse_date(entry.get("due"))
    return due is not None and day >= due


def display_status(entry: dict, day: _dt.date | None = None) -> str:
    """Status as the API reports it: `due` overrides a stored `solved`.

    `store.normalise` has already folded a legacy stored `due` back into
    `solved`, so the date is the only thing that decides here.
    """
    entry = store.normalise(entry)
    if is_due(entry, day):
        return "due"
    return entry["status"]


def next_interval(entry: dict, *, was_review: bool) -> int:
    if was_review:
        base = entry.get("interval_days") or FAIL_INTERVAL
        value = int(round(base * REVIEW_FACTOR))
        return max(1, min(value, MAX_INTERVAL))
    attempts = entry.get("attempts", 0)
    if attempts <= 1 and not entry.get("correction_viewed"):
        return FIRST_CLEAN_INTERVAL
    if attempts <= 2:
        return QUICK_INTERVAL
    return STRUGGLE_INTERVAL


def apply_verdict(entry: dict, verdict: str, day: _dt.date | None = None) -> dict:
    """Advance one problem state for a graded submission.

    `entry` is the state *before* the submission; attempts is incremented here.
    Returns a new normalised state dict.
    """
    day = day or today()
    entry = store.normalise(entry)
    new = dict(entry)
    new["attempts"] = entry["attempts"] + 1

    if verdict == "pass":
        if entry["status"] == "solved" and not is_due(entry, day):
            # Already solved and not due yet: this is practice, not a review.
            # Only the attempt count moves; re-running a solved problem must
            # not push the next review further and further away.
            return store.normalise(new)
        # A review is a pass on a problem the date had actually brought back.
        interval = next_interval(new, was_review=is_due(entry, day))
        new["status"] = "solved"
        new["solved_at"] = iso(day)
        new["interval_days"] = interval
        new["due"] = iso(day + _dt.timedelta(days=interval))
    else:  # fail, partial
        new["status"] = "failed"
        new["solved_at"] = None  # it is not solved any more; log.jsonl keeps the history
        new["interval_days"] = FAIL_INTERVAL
        new["due"] = iso(day + _dt.timedelta(days=FAIL_INTERVAL))
    return store.normalise(new)


def apply_reveal(entry: dict, day: _dt.date | None = None) -> dict:
    """Correction shown. A reveal on an unsolved problem is a failure."""
    day = day or today()
    entry = store.normalise(entry)
    new = dict(entry)
    new["correction_viewed"] = True
    if entry["status"] not in ("solved", "due"):
        new["status"] = "failed"
        new["interval_days"] = FAIL_INTERVAL
        new["due"] = iso(day + _dt.timedelta(days=FAIL_INTERVAL))
    return store.normalise(new)


def mark_correction_viewed(entry: dict) -> dict:
    """The correction has been shown. Nothing else moves.

    Used by the written flow, where submitting always reveals correction.md
    before the self-grade: without this, every self-graded `pass` would collect
    the 14-day interval reserved for a clean first solve.
    """
    new = dict(store.normalise(entry))
    new["correction_viewed"] = True
    return store.normalise(new)


def mark_seen(entry: dict) -> dict:
    """No-op placeholder: opening a problem does not change its state."""
    return store.normalise(entry)


# --------------------------------------------------------------- next up


def overdue_days(entry: dict, day: _dt.date | None = None) -> int:
    day = day or today()
    due = parse_date(entry.get("due"))
    if due is None:
        return 0
    return (day - due).days


def tags_of(entry) -> list:
    """The tags of one log line. `concepts` is the name older lines used."""
    for key in ("tags", "concepts"):
        value = (entry or {}).get(key)
        if isinstance(value, list):
            return value
    return []


def tag_rates(log_entries, min_attempts: int = 3, window: int = 20) -> dict:
    """Pass rate per tag over the last `window` graded entries touching it.

    `log_entries` newest first. Only tags with at least `min_attempts` graded
    entries count. Returns {tag: {"attempts", "passes", "rate"}}.
    """
    buckets: dict[str, list] = {}
    for item in log_entries:
        verdict = item.get("verdict")
        if verdict not in ("pass", "partial", "fail"):
            continue
        for tag in tags_of(item):
            bucket = buckets.setdefault(tag, [])
            if len(bucket) < window:
                bucket.append(verdict)
    out = {}
    for tag, verdicts in buckets.items():
        attempts = len(verdicts)
        passes = sum(1 for v in verdicts if v == "pass")
        out[tag] = {
            "attempts": attempts,
            "passes": passes,
            "rate": round(passes / attempts, 4) if attempts else 0.0,
            "counts": attempts >= min_attempts,
        }
    return out


def weakest_tags(log_entries, min_attempts: int = 3, window: int = 20) -> list:
    rates = tag_rates(log_entries, min_attempts, window)
    eligible = [(v["rate"], k) for k, v in rates.items() if v["counts"]]
    eligible.sort(key=lambda pair: (pair[0], pair[1]))
    return [name for _rate, name in eligible]


def _number_key(item):
    """The drill's own number, as an integer: 9 comes before 10, not after."""
    try:
        return (0, int(item.get("number")))
    except (TypeError, ValueError):
        return (1, 0)


def pick_next(items, log_entries, day: _dt.date | None = None):
    """Choose the next problem.

    `items` is a list of dicts with at least: id, number, status, due, tags.
    Returns (item, reason) or (None, reason).

    Priority (contract):
      1. overdue reviews, most overdue first
      2. failed drills, oldest failure first
      3. unseen drills, lowest number first
      4. unseen drills carrying the weakest tag
    """
    day = day or today()

    if not items:
        # Fresh install or a mistyped root: saying "everything is solved" would
        # be a lie.
        return None, "no drill indexed: add an N-slug folder"

    overdue = [it for it in items if it.get("status") == "due"]
    if overdue:
        overdue.sort(key=lambda it: (-overdue_days(it, day), it["id"]))
        n = overdue_days(overdue[0], day)
        when = "today" if n == 0 else f"{n} d late"
        return overdue[0], f"review due ({when})"

    failed = [it for it in items if it.get("status") == "failed"]
    if failed:
        # `due` is failure day + 1, so ascending `due` is oldest failure first.
        failed.sort(key=lambda it: (str(it.get("due") or "9999-99-99"), it["id"]))
        return failed[0], "the oldest drill you failed"

    unseen = [it for it in items if it.get("status") == "unseen"]
    if not unseen:
        return None, "nothing to do: everything is solved and no review is due"

    # The list is flat, so rule 3 is simply the next drill you have not tried.
    # Rule 4 only ever fires when every unseen drill carries tags.
    tagged_only = [it for it in unseen if tags_of(it)]
    if len(tagged_only) != len(unseen):
        unseen.sort(key=lambda it: (_number_key(it), it["id"]))
        return unseen[0], "a new drill"

    for tag in weakest_tags(log_entries):
        tagged = [it for it in unseen if tag in tags_of(it)]
        if tagged:
            tagged.sort(key=lambda it: (_number_key(it), it["id"]))
            return tagged[0], f"your weakest tag: {tag}"

    unseen.sort(key=lambda it: (_number_key(it), it["id"]))
    return unseen[0], "a new drill"
