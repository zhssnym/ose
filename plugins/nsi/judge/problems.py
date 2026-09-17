"""Drill index: scan the root's `NN-slug/` folders and expose one Problem each.

The root is flat. One drill is one folder directly under it — `1-max-dico/`,
`2-inverser-un-dictionnaire/` — and the id is the folder name, always: a stale
`id` left inside a meta.json is ignored. The number is the integer prefix as it
is written, padded or not, and it orders the list. There are no
chapters, no `exos`, no school and no personal: every drill is the same thing,
a statement with a place to write, judged when there is something to judge it
with.

    <root>/
      1-max-dico/
        meta.json enonce.md solution.py tests.py correction.py
      2-…/
      .nsi/            state.json, log.jsonl, clocks.json

`meta.json` carries a title, `tags` and, for a drill with a signature, a `code`
block. Four keys, and nothing else is read: `kind`, `source`, `difficulty` and
`concepts` were words for things that never varied or that `tags` already says,
and a file that still carries them is read exactly as a file that does not.
They are left on disk untouched; the judge simply has no use for them.

The app owns nothing inside a drill folder except the user's answer file
(solution.py). Everything else is read-only content.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

ANSWER_FILE = "solution.py"
TESTS_FILE = "tests.py"
ENONCE_FILE = "enonce.md"
CORRECTIONS = (("py", "correction.py"), ("md", "correction.md"))

NUMBER_RE = re.compile(r"^(\d+)")
SLUG_OF_RE = re.compile(r"^\d+-")


class Problem:
    __slots__ = ("id", "path", "meta", "number", "slug", "_tests")

    def __init__(self, pid: str, path: Path, meta: dict, number):
        self.id = pid
        self.path = path
        self.meta = meta
        self.number = number
        self.slug = SLUG_OF_RE.sub("", path.name)
        self._tests = None

    # ------------------------------------------------------------- meta views

    @property
    def title(self) -> str:
        return self.meta.get("title") or self.slug

    @property
    def tags(self) -> list:
        """Short labels for the drill. Always a list, never null.

        `meta.tags` and nothing else — including an explicit `[]`, which means
        "none". The `concepts` an older meta wrote down is not read any more:
        one name won, and it is `tags`. A file that still has a `concepts` list
        keeps it, and the drill has no tags until `tags` is written.
        """
        value = self.meta.get("tags")
        return clean_tags(value) if isinstance(value, list) else []

    @property
    def code_meta(self) -> dict:
        value = self.meta.get("code")
        return value if isinstance(value, dict) else {}

    # ----------------------------------------------------------------- paths

    @property
    def answer_filename(self) -> str:
        return ANSWER_FILE

    @property
    def answer_path(self) -> Path:
        return self.path / ANSWER_FILE

    @property
    def enonce_path(self) -> Path:
        return self.path / ENONCE_FILE

    @property
    def tests_path(self) -> Path:
        """Where the cases live, whether or not the file is there yet."""
        return self.path / TESTS_FILE

    @property
    def correction_path(self):
        """The correction file that exists, `.py` before `.md`, or None."""
        for _fmt, name in CORRECTIONS:
            candidate = self.path / name
            if candidate.is_file():
                return candidate
        return None

    @property
    def correction_format(self):
        for fmt, name in CORRECTIONS:
            if (self.path / name).is_file():
                return fmt
        return None

    @property
    def has_tests(self) -> bool:
        """`tests.py` exists and its `TESTS` is a non-empty list."""
        return self._tests_flag[0]

    @property
    def tests_count(self):
        """How many cases `TESTS` holds, or None when it cannot be counted.

        A suite built by a loop has a length only the interpreter knows, and
        running problem code to decide how to label a page is not something
        this process does. The page then says `tests` and no number.
        """
        return self._tests_flag[1]

    @property
    def _tests_flag(self):
        if self._tests is None:
            self._tests = read_tests(self.tests_path)
        return self._tests

    @property
    def has_correction(self) -> bool:
        """A correction with something in it, not a file promising one.

        A `correction.py` holding nothing but comments — the `à écrire`
        placeholder the old `create` wrote — is a promise, and submitting
        against a promise used to hand out a pass (ADV-N).
        """
        path = self.correction_path
        if path is None:
            return False
        return bool(correction_body(self._read(path.name) or "", path.suffix))

    @property
    def judged(self) -> bool:
        """Whether the judge has anything to say about this drill.

        Cases, or a correction. A drill with neither is perfectly legal — it is
        a statement you have written down and not finished — and the interface
        draws it as a page with a code area and no Submit.
        """
        return self.has_tests or self.has_correction

    # ----------------------------------------------------------------- files

    def _read(self, name: str, default=None):
        try:
            return (self.path / name).read_text(encoding="utf-8")
        except (FileNotFoundError, OSError, UnicodeDecodeError):
            return default

    def enonce(self) -> str:
        return self._read(ENONCE_FILE, "") or ""

    def correction(self):
        path = self.correction_path
        if path is None:
            return None
        return self._read(path.name)

    def tests_source(self):
        return self._read(TESTS_FILE)

    def read_answer(self) -> str:
        text = self._read(ANSWER_FILE)
        if text is not None:
            return text
        return self.default_answer()

    def default_answer(self) -> str:
        """Seed text when solution.py does not exist yet. Not written here."""
        fn = self.code_meta.get("function")
        if fn:
            params = ", ".join(self.code_meta.get("params") or [])
            return stub_source(fn, params, self.title)
        return "# answer\n"

    def write_answer(self, content: str) -> None:
        if not isinstance(content, str):
            raise ValueError("`content` must be a string")
        self.answer_path.write_text(content, encoding="utf-8", newline="")

    # ------------------------------------------------------------------ views

    def public_meta(self) -> dict:
        """meta.json as it is on disk. Nothing in it spoils an answer."""
        return json.loads(json.dumps(self.meta, ensure_ascii=False))

    def summary(self) -> dict:
        return {
            "id": self.id,
            "number": self.number,
            "title": self.title,
            "tags": self.tags,
            "has_tests": self.has_tests,
            "tests_count": self.tests_count,
            "has_correction": self.has_correction,
            "judged": self.judged,
        }


def correction_body(text: str, suffix: str) -> str:
    """What is left of a correction once the empty promises are removed.

    In a `.py` file, comment lines and blank lines are the promise; anything
    else is a correction. In a `.md` file the prose is the correction, so only
    emptiness disqualifies it. Returns the remainder, empty when there is none.
    """
    if suffix.lower() != ".py":
        return (text or "").strip()
    keep = [line for line in (text or "").splitlines()
            if line.strip() and not line.lstrip().startswith("#")]
    return "\n".join(keep).strip()


def clean_tags(values) -> list:
    """A list of short non-empty strings, in order, without repeats."""
    out = []
    for value in values or []:
        if value is None:
            continue
        text = " ".join(str(value).split())
        if text and text not in out:
            out.append(text)
    return out


def number_key(number, pid: str = ""):
    """Sort key for the prefix: 9 before 10, and a folder with none last."""
    try:
        return (0, int(str(number)), pid)
    except (TypeError, ValueError):
        return (1, 0, pid)


def number_of(name: str):
    """The integer a folder name starts with, or None. `07-x` is 7, `x` is None."""
    match = NUMBER_RE.match(name)
    return int(match.group(1)) if match else None


def docstring(text: str) -> str:
    """`text` as a triple-quoted docstring that parses, whatever is in it.

    A title is free text and ends up here verbatim. Escaping the backslash and
    then the quote is enough for every case: a quote at the very end (where the
    closing delimiter lands), a lone trailing backslash, a `\"\"\"` in the
    middle. The common title has neither and comes through untouched.
    """
    body = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"""{body}"""'


def stub_source(function: str, params: str, title: str) -> str:
    """The solution.py seed: one signature, one docstring, one `pass`."""
    doc = (title or "").strip() or function
    return f"def {function}({params}):\n    {docstring(doc)}\n    pass\n"


def read_tests(path: Path):
    """(are there cases, how many) for one `tests.py`. Never executes it.

    A suite built by a loop rather than a literal counts as tests — we cannot
    see inside it without running it, and running problem code to decide how to
    grade problem code is not something this process does — and its count is
    None, which the page reads as "say `tests` and no number".
    """
    try:
        source = path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return (False, None)
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError) as exc:
        print(f"[index] tests.py unreadable, read as having none: {path} ({exc})")
        return (False, None)

    value = None
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        else:
            continue
        for target in targets:
            if isinstance(target, ast.Name) and target.id == "TESTS":
                value = node.value
    if value is None:
        return (False, None)
    if isinstance(value, (ast.List, ast.Tuple, ast.Set)):
        return (bool(value.elts), len(value.elts))
    if isinstance(value, ast.Constant) and value.value is None:
        return (False, None)
    return (True, None)


def read_tests_flag(path: Path) -> bool:
    """True when `path` assigns a non-empty `TESTS`."""
    return read_tests(path)[0]


def load_problem(meta_path: Path):
    """Build one Problem or return None after warning about a skipped folder."""
    folder = meta_path.parent
    try:
        raw = meta_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        # The folder went away between the listing and the read — the plugin
        # trashes folders while the judge is running. Not a fault, not a line.
        return None
    except (OSError, UnicodeDecodeError) as exc:
        print(f"[index] meta.json unreadable, drill skipped: {meta_path} ({exc})")
        return None
    try:
        meta = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"[index] meta.json invalid, drill skipped: {meta_path} ({exc})")
        return None
    if not isinstance(meta, dict):
        print(f"[index] meta.json is not an object, drill skipped: {meta_path}")
        return None

    pid = folder.name
    # The folder name is the id. A meta carrying an older one — `chapitre-1/16-…`
    # from before the flattening — is simply not believed, and not complained
    # about either: `update` rewrites the field the next time it writes the file.
    meta["id"] = pid
    return Problem(pid, folder, meta, number_of(folder.name))


def scan(root: Path) -> dict:
    """Index every drill under `root`: one `NN-slug/meta.json` each.

    Returns an ordered dict {id: Problem}, by number then name. A dotted folder
    (`.nsi`) is data, not a drill, and is never looked at.
    """
    root = Path(root)
    try:
        folders = sorted(root.iterdir(), key=lambda p: p.name)
    except OSError as exc:
        print(f"[index] drills root unreadable: {root} ({exc})")
        return {}

    found = []
    for folder in folders:
        # Every probe below is a question about a folder that may already be in
        # the recycle bin: the plugin trashes one while a `list` is in flight,
        # and a scan must come back short, never come back with a traceback.
        try:
            if folder.name.startswith(".") or not folder.is_dir():
                continue
            meta_path = folder / "meta.json"
            if not meta_path.is_file():
                continue
            problem = load_problem(meta_path)
        except OSError as exc:
            print(f"[index] folder unreadable, skipped: {folder} ({exc})")
            continue
        if problem is not None:
            found.append(problem)

    found.sort(key=lambda p: number_key(p.number, p.id))
    index = {}
    for problem in found:
        if problem.id in index:
            print(f"[index] duplicate id skipped: {problem.id}")
            continue
        index[problem.id] = problem
    return index
