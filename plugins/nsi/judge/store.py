"""log.jsonl: the only thing the judge keeps.

    <drills root>/.nsi/log.jsonl

Append only: never edited, never truncated, and a correction is a new line
saying what was wrong. There is no state file any more. Whether a drill is
done, how many attempts it took and how long the best one was are read back
from these lines, here and in the plugin, so what an agent reads in the file is
exactly what the app shows.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

VERDICTS = ("pass", "partial", "fail")


def now_ts() -> str:
    """Local timestamp, seconds resolution, as used in log.jsonl."""
    return _dt.datetime.now().replace(microsecond=0).isoformat()


class Store:
    def __init__(self, app_dir: Path):
        self.app_dir = Path(app_dir)
        self.log_path = self.app_dir / "log.jsonl"

    def append_log(self, entry: dict) -> dict:
        entry = dict(entry)
        entry.setdefault("ts", now_ts())
        line = json.dumps(entry, ensure_ascii=False)
        self.app_dir.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        return entry

    def read_log(self, limit: int | None = None, newest_first: bool = True) -> list:
        try:
            raw = self.log_path.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError):
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

    # ---------------------------------------------------- what the lines say

    def graded(self, pid: str) -> list:
        """The lines of one drill that carry a verdict, newest first.

        A line with no verdict is a note somebody wrote into the log by hand;
        it counts for no attempt.
        """
        return [e for e in self.read_log()
                if e.get("problem") == pid and e.get("verdict") in VERDICTS]

    def attempts(self, pid: str) -> int:
        return len(self.graded(pid))

    def solved(self, pid: str) -> bool:
        """Has this drill ever passed? That is the whole definition of done."""
        return any(e.get("verdict") == "pass" for e in self.graded(pid))

    def correction_seen(self, pid: str) -> bool:
        return any(e.get("correction_viewed") for e in self.graded(pid))
