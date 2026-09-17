"""state.json + log.jsonl access.

state.json is rewritten atomically (temp file + os.replace) under a single lock,
because the server is threaded. log.jsonl is append only: never edited, never
truncated; a correction is a new line carrying a "note" field.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import threading
from pathlib import Path

DEFAULT_STATE = {
    "status": "unseen",
    "attempts": 0,
    "solved_at": None,
    "due": None,
    "interval_days": 0,
    "correction_viewed": False,
}

STATE_KEYS = tuple(DEFAULT_STATE)


def now_ts() -> str:
    """Local timestamp, seconds resolution, as used in log.jsonl."""
    return _dt.datetime.now().replace(microsecond=0).isoformat()


class Store:
    def __init__(self, app_dir: Path):
        self.app_dir = Path(app_dir)
        self.state_path = self.app_dir / "state.json"
        self.log_path = self.app_dir / "log.jsonl"
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ state

    def read_state(self) -> dict:
        with self._lock:
            return self._read_state_unlocked()

    def _read_state_unlocked(self) -> dict:
        try:
            raw = self.state_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {"problems": {}}
        except OSError as exc:
            print(f"[store] lecture de state.json impossible ({exc}) ; état vide")
            return {"problems": {}}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"[store] state.json illisible ({exc}) ; état vide")
            return {"problems": {}}
        if not isinstance(data, dict):
            return {"problems": {}}
        problems = data.get("problems")
        if not isinstance(problems, dict):
            data["problems"] = {}
        return data

    def _write_state_unlocked(self, state: dict) -> None:
        self.app_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, self.state_path)

    def write_state(self, state: dict) -> None:
        with self._lock:
            self._write_state_unlocked(state)

    def problem_state(self, pid: str) -> dict:
        """Stored state for one problem, defaults filled in. Never None."""
        with self._lock:
            state = self._read_state_unlocked()
            return normalise(state["problems"].get(pid))

    def all_problem_states(self) -> dict:
        with self._lock:
            state = self._read_state_unlocked()
            return {k: normalise(v) for k, v in state["problems"].items()}

    def update_problem_state(self, pid: str, mutator) -> dict:
        """Read-modify-write one problem entry under the lock.

        `mutator(current) -> new` receives a normalised dict and returns the
        replacement (or mutates and returns it).
        """
        with self._lock:
            state = self._read_state_unlocked()
            current = normalise(state["problems"].get(pid))
            new = mutator(current)
            if new is None:
                new = current
            new = normalise(new)
            state["problems"][pid] = new
            self._write_state_unlocked(state)
            return new

    # -------------------------------------------------------------------- log

    def append_log(self, entry: dict) -> dict:
        entry = dict(entry)
        entry.setdefault("ts", now_ts())
        line = json.dumps(entry, ensure_ascii=False)
        with self._lock:
            self.app_dir.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        return entry

    def read_log(self, limit: int | None = None, newest_first: bool = True) -> list:
        with self._lock:
            try:
                raw = self.log_path.read_text(encoding="utf-8")
            except FileNotFoundError:
                return []
            except OSError:
                return []
        out = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                out.append(obj)
        if newest_first:
            out.reverse()
        if limit is not None and limit >= 0:
            out = out[:limit]
        return out


def normalise(entry) -> dict:
    """Fill defaults and drop unknown keys so state.json keeps its shape."""
    out = dict(DEFAULT_STATE)
    if isinstance(entry, dict):
        for key in STATE_KEYS:
            if key in entry:
                out[key] = entry[key]
    if not isinstance(out["attempts"], int) or out["attempts"] < 0:
        out["attempts"] = 0
    if out["status"] == "due":
        # Legacy value written by an older version. `due` is derived from the
        # date, never stored: left as is it would read back as a permanent
        # `solved` that no `is_due` check can ever revive.
        out["status"] = "solved"
    if out["status"] not in ("unseen", "failed", "solved"):
        out["status"] = "unseen"
    out["correction_viewed"] = bool(out["correction_viewed"])
    try:
        out["interval_days"] = int(out["interval_days"])
    except (TypeError, ValueError):
        out["interval_days"] = 0
    return out
