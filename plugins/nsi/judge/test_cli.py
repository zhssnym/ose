#!/usr/bin/env python3
"""Self-test for the Informatique judge CLI. Stdlib only, no pytest.

    python -B -m judge.test_cli [-v]

Builds a throwaway flat drill tree in the system temp dir and drives
`python -m judge.cli` against it as a real subprocess, so what is tested is
exactly what the Ose plugin runs: the arguments, the one JSON object on
stdout, the exit code, and the accents on the way through.

Nothing under a vault is touched.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MODULE_DIR))

from judge import astcheck, code_checker, store as store_mod  # noqa: E402

VERBOSE = "-v" in sys.argv
PASSED = 0
FAILED = []
SECTION = "—"

#: What `detail` answers, and nothing else. No status, no due date, no attempt
#: count: the log is the state and the plugin reads it.
DETAIL_FIELDS = sorted([
    "id", "number", "title", "tags", "has_tests", "tests_count",
    "has_correction", "judged",
    "enonce", "answer", "answer_exists", "answer_path",
    "correction_path", "correction_format", "folder"])

#: Words for state the judge used to keep. None of them may come back.
STATE_WORDS = {"status", "due", "attempts", "solved_at", "interval_days",
               "overdue_days", "state", "duree_s", "meilleure_s", "reason"}


def section(name: str) -> None:
    global SECTION
    SECTION = name
    print(f"\n== {name}")


def ok(label: str, condition, detail="") -> bool:
    global PASSED
    if condition:
        PASSED += 1
        if VERBOSE:
            print(f"   ok   {label}")
        return True
    FAILED.append((SECTION, label, str(detail)[:900]))
    print(f"   FAIL {label}")
    if detail:
        print(f"        {str(detail)[:900]}")
    return False


def eq(label: str, got, expected) -> bool:
    return ok(label, got == expected, f"expected {expected!r}, got {got!r}")


# ------------------------------------------------------------------ fixtures

#: A meta.json as the format stands now: a title, tags, and a `code` block when
#: the drill has a signature. No `kind`, no `source`, no `difficulty`, no
#: `concepts`: words for a thing that never varied, or for what `tags` says.
META_CODE = {
    "title": "Maximum d'un dictionnaire",
    "tags": ["dictionnaires"],
    "code": {"function": "max_dico", "params": ["dico"], "return_type": "number",
             "constraints": {"forbidden": ["max"], "required": ["for"]}},
}

TESTS_PY = (
    "TESTS = [\n"
    "    {\"name\": \"cas simple\", \"args\": ({\"a\": 4, \"b\": 5},), \"expect\": 5},\n"
    "    {\"name\": \"négatifs\", \"args\": ({\"a\": -4},), \"expect\": -4},\n"
    "]\n"
)

GOOD = ("def max_dico(dico):\n"
        "    m = None\n"
        "    for c in dico:\n"
        "        if m is None or dico[c] > m:\n"
        "            m = dico[c]\n"
        "    return m\n")

HALF = ("def max_dico(dico):\n"
        "    for c in dico:\n"
        "        pass\n"
        "    return 5\n")

CHEAT = "def max_dico(dico):\n    for c in dico:\n        pass\n    return max(dico.values())\n"

#: Cases not written yet: `tests.py` is there, `TESTS` is empty. Self-graded
#: against its correction.md.
META_NO_TESTS = {
    "title": "Dérouler l'inversion d'un dictionnaire",
    "tags": ["révision", "listes", "révision"],
    "code": {"function": "inverse", "params": ["dico"]},
}

EMPTY_TESTS_PY = ("# Un cas : {\"name\": \"cas simple\", \"args\": (1, 2), \"expect\": 3}\n"
                  "TESTS = []\n")

#: A meta written before the flattening and before `tags` had its name: a stale
#: `id`, a `difficulty` and a `concepts` list. The file is read exactly as one
#: without them — the id is the folder's, and the drill has no tags — and every
#: one of them is left on disk where it is.
META_LEGACY = {
    "id": "chapitre-1/07-perso-dico-rapide",
    "title": "Pourquoi un dictionnaire est rapide",
    "kind": "written",
    "source": "generated",
    "difficulty": 2,
    "concepts": ["complexité"],
}

META_PARCOURS = {"title": "Parcours", "tags": ["parcours"],
                 "code": {"function": "somme", "params": ["xs"]}}

#: Nothing to judge it with: a drill written down and not finished. Its number
#: is 10, which must sort after 5 and not between 1 and 2.
META_FREE = {"title": "Trier sans trier", "tags": ["tris"]}

#: The shape the deleted `create` used to leave behind: an empty suite and a
#: correction file that only promises one. One click on `passed` against this
#: wrote a solve into the record (ADV-N); it must now be `not_judgeable`.
META_PROMISE = {"title": "Une promesse", "tags": ["promesses"],
                "code": {"function": "promesse", "params": []}}
CORRECTION_PLACEHOLDER = "# correction de référence : à écrire\n"


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="")


def build_tree(root: Path) -> None:
    code = root / "1-max-dico"
    write(code / "meta.json", json.dumps(META_CODE, ensure_ascii=False, indent=2))
    write(code / "enonce.md", "# Maximum d'un dictionnaire\n\nÉcrire `max_dico`, sans `max`.\n")
    write(code / "tests.py", TESTS_PY)
    write(code / "correction.py", GOOD)

    bare = root / "2-derouler-inversion"
    write(bare / "meta.json", json.dumps(META_NO_TESTS, ensure_ascii=False, indent=2))
    write(bare / "enonce.md", "# Dérouler l'inversion\n\nQue vaut `resultat` ?\n")
    write(bare / "tests.py", EMPTY_TESTS_PY)
    write(bare / "correction.md", "# Correction\n\n`{1: 'c', 2: 'b'}` : la clé est écrasée.\n")

    legacy = root / "3-dico-rapide"
    write(legacy / "meta.json", json.dumps(META_LEGACY, ensure_ascii=False, indent=2))
    write(legacy / "enonce.md", "# Pourquoi un dictionnaire est rapide\n\nExpliquer.\n")
    write(legacy / "correction.md", "# Correction\n\nLe hachage donne un accès en O(1).\n")

    parcours = root / "5-parcours"
    write(parcours / "meta.json", json.dumps(META_PARCOURS, ensure_ascii=False, indent=2))
    write(parcours / "enonce.md", "# Parcours\n\nSommer une liste.\n")
    write(parcours / "tests.py",
          "TESTS = [{\"name\": \"vide\", \"args\": ([],), \"expect\": 0}]\n")
    write(parcours / "correction.py", "def somme(xs):\n    return sum(xs)\n")

    promise = root / "7-une-promesse"
    write(promise / "meta.json", json.dumps(META_PROMISE, ensure_ascii=False, indent=2))
    write(promise / "enonce.md", "# Une promesse\n\nÀ écrire.\n")
    write(promise / "tests.py", EMPTY_TESTS_PY)
    write(promise / "correction.py", CORRECTION_PLACEHOLDER)

    free = root / "10-trier-sans-trier"
    write(free / "meta.json", json.dumps(META_FREE, ensure_ascii=False, indent=2))
    write(free / "enonce.md", "# Trier sans trier\n\nExpliquer l'idée.\n")


# --------------------------------------------------------------------- runner


class Cli:
    def __init__(self, root: Path):
        self.root = root
        self.last = None

    def __call__(self, *args, stdin=None, expect_ok=True, root=None):
        cmd = [sys.executable, "-B", "-m", "judge.cli",
               "--root", str(root or self.root)]
        cmd += [str(a) for a in args]
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8",
                   NSI_JUDGE_TIMEOUT="3")
        proc = subprocess.run(
            cmd, cwd=str(MODULE_DIR), env=env,
            input=(stdin.encode("utf-8") if stdin is not None else None),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        raw = proc.stdout.decode("ascii", "replace")
        self.last = proc
        lines = [l for l in raw.splitlines() if l.strip()]
        if len(lines) != 1:
            ok(f"{args[0]}: exactly one line on stdout", False, raw[:400])
            return {}
        try:
            body = json.loads(lines[0])
        except json.JSONDecodeError as exc:
            ok(f"{args[0]}: valid JSON", False, f"{exc} :: {lines[0][:300]}")
            return {}
        if expect_ok and not body.get("ok"):
            ok(f"{args[0]}: ok", False, body.get("error"))
        return body

    def stderr(self) -> str:
        return self.last.stderr.decode("utf-8", "replace") if self.last else ""

    def store(self):
        return store_mod.Store(self.root / ".nsi")

    def log(self, limit=None) -> list:
        """The log as the judge wrote it, newest first.

        Read from the file: it is the only record there is, and it is what the
        plugin reads too.
        """
        return self.store().read_log(limit)

    def lines_of(self, pid: str) -> list:
        return [l for l in self.log() if l.get("problem") == pid]


# ---------------------------------------------------------------------- tests


def test_detail(cli):
    section("detail, paths and accents")
    body = cli("detail", "1-max-dico")
    eq("title", body["title"], "Maximum d'un dictionnaire")
    ok("the statement keeps its accents", "Écrire" in body["enonce"], body["enonce"][:80])
    ok("the answer seed is the signature",
       body["answer"].startswith("def max_dico(dico):"), body["answer"])
    ok("with a docstring", '"""' in body["answer"], body["answer"])
    eq("the answer file does not exist yet", body["answer_exists"], False)
    eq("the fields of a detail, and no others",
       sorted(set(body) - {"ok", "command"}), DETAIL_FIELDS)
    ok("no state travels with it", not STATE_WORDS & set(body), sorted(body))
    ok("no kind, no source, no chapter, no difficulty, no concepts",
       not {"kind", "source", "source_ref", "chapter", "difficulty",
            "concepts", "meta"} & set(body), sorted(body))
    eq("the number is an integer", body["number"], 1)

    eq("folder", body["folder"], "1-max-dico")
    eq("answer_path", body["answer_path"], "1-max-dico/solution.py")
    eq("correction_path", body["correction_path"], "1-max-dico/correction.py")
    eq("correction_format", body["correction_format"], "py")
    eq("has_correction", body["has_correction"], True)
    eq("has_tests: there are cases", body["has_tests"], True)
    eq("and the page can say how many", body["tests_count"], 2)
    eq("judged: cases", body["judged"], True)

    body = cli("detail", "2-derouler-inversion")
    eq("has_tests: an empty TESTS counts for nothing", body["has_tests"], False)
    eq("judged: a correction is enough", body["judged"], True)

    body = cli("detail", "3-dico-rapide")
    eq("an old `written` meta is read as code, kind and all", body["has_tests"], False)
    eq("no cases, no count", body["tests_count"], None)
    eq("with no signature the seed is an English comment", body["answer"], "# answer\n")
    eq("the id is the folder's name, not the meta's", body["id"], "3-dico-rapide")
    eq("a markdown correction", body["correction_format"], "md")

    body = cli("detail", "7-une-promesse")
    eq("a correction that is only a promise is not a correction",
       body["has_correction"], False)
    eq("so the promise is not judgeable either", body["judged"], False)

    body = cli("detail", "10-trier-sans-trier")
    eq("the number of a two-digit folder", body["number"], 10)
    eq("free-form: no correction", body["correction_path"], None)
    eq("nor a format", body["correction_format"], None)
    eq("nor a judge", body["judged"], False)
    eq("and it says so through has_correction too", body["has_correction"], False)

    unknown = cli("detail", "99-rien", expect_ok=False)
    eq("unknown id", unknown["error_kind"], "not_found")
    unknown = cli("detail", "../..", expect_ok=False)
    eq("and a drill id that walks out of the folder", unknown["error_kind"], "not_found")


def test_submit_code(cli, root):
    section("submit: with tests")
    pid = "1-max-dico"
    answer = root / pid / "solution.py"

    write(answer, CHEAT)
    body = cli("submit", pid, "--duration", "30")
    eq("max is forbidden", body["verdict"], "fail")
    ok("the violation names the construct",
       body["constraint_violations"][0]["construct"] == "max", body["constraint_violations"])
    eq("no test was run", body["total"], 0)
    eq("first attempt", body["logged"]["attempt"], 1)
    eq("the source that was judged is in the line", body["logged"]["code"], CHEAT)
    ok("and no state came back with it", not STATE_WORDS & set(body), sorted(body))

    write(answer, HALF)
    body = cli("submit", pid)
    eq("one test of two", (body["verdict"], body["passed"], body["total"]),
       ("partial", 1, 2))
    ok("the failing test is named", "négatifs" in body["failed_tests"], body["failed_tests"])
    eq("the attempt is counted off the log", body["logged"]["attempt"], 2)

    write(answer, GOOD)
    body = cli("submit", pid, "--duration", "120")
    eq("passed", body["verdict"], "pass")
    eq("three attempts", body["logged"]["attempt"], 3)
    eq("the duration is logged", body["logged"]["duration_s"], 120)
    eq("and the code with it", body["logged"]["code"], GOOD)
    ok("the correction comes with the pass",
       body.get("correction", "").startswith("def max_dico"), body.get("correction"))
    eq("and its format", body.get("correction_format"), "py")
    ok("an accented test name survives the log",
       any("é" in n for n in cli.log()[1]["failed_tests"]), cli.log()[1])

    entry = cli.log()[0]
    eq("a log line says `tags`, not `concepts`", entry["tags"], ["dictionnaires"])
    ok("and nothing else says it", "concepts" not in entry, sorted(entry))
    ok("nor `kind`, which never varied", "kind" not in entry, sorted(entry))
    ok("nor `source`", "source" not in entry, sorted(entry))
    eq("the fields of a submit line", sorted(entry),
       sorted(["problem", "verdict", "attempt", "failed_tests",
               "constraint_violations", "duration_s", "correction_viewed",
               "tags", "code", "ts"]))
    eq("the correction was not seen", entry["correction_viewed"], False)
    eq("three lines for three submissions", len(cli.lines_of(pid)), 3)


def test_submit_without_tests(cli, root):
    section("submit: without tests")
    pid = "2-derouler-inversion"
    answer = root / pid / "solution.py"

    write(answer, "   \n")
    body = cli("submit", pid, expect_ok=False)
    eq("an empty answer is refused", body["error_kind"], "bad_request")
    ok("and nothing is revealed", "correction" not in body, body)

    before = len(cli.log())
    written = "# la clé 'a' est écrasée par 'c'\n"
    write(answer, written)
    body = cli("submit", pid, "--duration", "45")
    eq("no automatic verdict", body["verdict"], None)
    eq("not graded", body["graded"], False)
    eq("a self-grade is awaited", body["awaiting_selfgrade"], True)
    ok("the correction is handed over", "écrasée" in body["correction"], body["correction"][:80])
    eq("its format", body["correction_format"], "md")
    eq("no log line before the self-grade", len(cli.log()), before)
    ok("and no state either", not STATE_WORDS & set(body), sorted(body))

    body = cli("selfgrade", pid, "pass", "--duration", "60")
    eq("the grade is recorded", body["verdict"], "pass")
    eq("one log line this time", len(cli.log()), before + 1)
    entry = cli.log()[0]
    eq("first attempt", entry["attempt"], 1)
    eq("a self-grade is a grade against the correction",
       entry["correction_viewed"], True)
    eq("and it carries the answer it graded", entry["code"], written)


def test_not_judgeable(cli, root):
    section("nothing to judge: no pass out of thin air (ADV-N)")
    for pid in ("7-une-promesse", "10-trier-sans-trier"):
        write(root / pid / "solution.py", "x = 1\n")
        body = cli("submit", pid, expect_ok=False)
        eq(f"submit on {pid}", body["error_kind"], "not_judgeable")
        ok("and says what is missing", "no tests and no correction" in body["error"],
           body["error"])
        body = cli("selfgrade", pid, "pass", expect_ok=False)
        eq(f"selfgrade on {pid}", body["error_kind"], "not_judgeable")
        body = cli("reveal", pid, expect_ok=False)
        eq(f"reveal on {pid}", body["error_kind"], "not_judgeable")
        eq(f"and {pid} collected no line", cli.lines_of(pid), [])

    # The moment the promise is kept, the drill is judgeable again.
    write(root / "7-une-promesse" / "correction.py",
          "def promesse():\n    return 42\n")
    eq("a correction with code in it counts",
       cli("detail", "7-une-promesse")["judged"], True)
    body = cli("submit", "7-une-promesse")
    eq("and submit hands it over", body["awaiting_selfgrade"], True)
    write(root / "7-une-promesse" / "correction.py", CORRECTION_PLACEHOLDER)


def test_reveal(cli):
    section("reveal: the rule the page prints is a line in the log")
    body = cli("reveal", "5-parcours")
    ok("the correction is handed over",
       body["correction"].startswith("def somme"), body["correction"][:60])
    eq("with its format", body["correction_format"], "py")
    eq("revealing a drill that never passed is a failure",
       body["logged"]["verdict"], "fail")
    eq("the line says the correction was seen",
       body["logged"]["correction_viewed"], True)
    ok("and carries no code: nothing was judged", "code" not in body["logged"],
       sorted(body["logged"]))
    eq("one line for the drill", len(cli.lines_of("5-parcours")), 1)

    body = cli("selfgrade", "5-parcours", "partial")
    eq("a self-grade is accepted even with tests", body["verdict"], "partial")
    eq("and it is the second attempt", body["logged"]["attempt"], 2)
    eq("two lines now", len(cli.lines_of("5-parcours")), 2)

    before = len(cli.lines_of("1-max-dico"))
    body = cli("reveal", "1-max-dico")
    ok("revealing a drill that has passed writes nothing",
       "logged" not in body, sorted(body))
    eq("its lines are where they were", len(cli.lines_of("1-max-dico")), before)

    proc = subprocess.run(
        [sys.executable, "-B", "-m", "judge.cli", "--root", str(cli.root),
         "selfgrade", "5-parcours", "excellent"],
        cwd=str(MODULE_DIR), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=dict(os.environ, PYTHONUTF8="1"), timeout=60)
    eq("an invented verdict is a usage error", proc.returncode, 2)
    eq("and nothing on stdout", proc.stdout.strip(), b"")


def test_tags(cli, root):
    section("tags")
    eq("written in meta", cli("detail", "1-max-dico")["tags"], ["dictionnaires"])
    eq("an old `concepts` list is not read as tags any more",
       cli("detail", "3-dico-rapide")["tags"], [])
    eq("a written `tags` is cleaned and de-duplicated",
       cli("detail", "2-derouler-inversion")["tags"], ["révision", "listes"])
    ok("and nothing was written to disk for it",
       "tags" not in json.loads((root / "3-dico-rapide" / "meta.json")
                                .read_text(encoding="utf-8")), "")
    on_disk = json.loads((root / "3-dico-rapide" / "meta.json").read_text(encoding="utf-8"))
    ok("the dead fields are left exactly where they were",
       (on_disk.get("kind"), on_disk.get("difficulty"), on_disk.get("concepts"))
       == ("written", 2, ["complexité"]), on_disk)

    from judge import problems as problems_mod
    eq("cleaning folds the blanks and the empties",
       problems_mod.clean_tags(["  a  b ", "", None, "a b", "c"]), ["a b", "c"])
    eq("an empty list stays empty", problems_mod.clean_tags([]), [])


def test_surface(cli, root):
    section("the surface: four verbs, and nothing that schedules")
    from judge import cli as cli_mod
    eq("four commands and no more", sorted(cli_mod.COMMANDS),
       ["detail", "reveal", "selfgrade", "submit"])
    for gone in ("list", "next", "update", "create", "convert", "migrate",
                 "migrate-flat", "stats", "log"):
        ok(f"`{gone}` is gone", gone not in cli_mod.COMMANDS, sorted(cli_mod.COMMANDS))
    for gone in ("cmd_list", "cmd_next", "cmd_update", "set_members",
                 "cmd_create", "cmd_stats", "slugify", "spell_number"):
        ok(f"and so is `{gone}`", not hasattr(cli_mod, gone), gone)
    for gone in ("listing", "next_up", "timings", "row", "stats"):
        ok(f"App has no `{gone}`", not hasattr(cli_mod.App, gone), gone)

    ok("there is no scheduler file",
       not (MODULE_DIR / "judge" / "scheduler.py").exists(),
       sorted(p.name for p in (MODULE_DIR / "judge").iterdir()))
    import judge as judge_pkg
    ok("nor a scheduler in the package", "scheduler" not in judge_pkg.__all__,
       judge_pkg.__all__)
    for gone in ("normalise", "DEFAULT_STATE", "STATE_KEYS"):
        ok(f"the store has no `{gone}`", not hasattr(store_mod, gone), gone)
    for gone in ("read_state", "write_state", "problem_state",
                 "all_problem_states", "update_problem_state"):
        ok(f"nor a `{gone}`", not hasattr(store_mod.Store, gone), gone)
    ok("and no state.json was ever written",
       not (root / ".nsi" / "state.json").exists(),
       sorted(p.name for p in (root / ".nsi").iterdir()))

    proc = subprocess.run([sys.executable, "-B", "-m", "judge.cli", "--help"],
                          cwd=str(MODULE_DIR), stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=60,
                          env=dict(os.environ, PYTHONUTF8="1"))
    help_text = proc.stdout.decode("utf-8", "replace")
    eq("--help exits cleanly", proc.returncode, 0)
    ok("the help says Informatique", "Informatique" in help_text, help_text[:200])
    ok("and no longer says NSI", "NSI" not in help_text,
       [l for l in help_text.splitlines() if "NSI" in l])
    ok("--data-dir is gone", "--data-dir" not in help_text, help_text[:400])
    ok("and --json with it", "--json" not in help_text, help_text[:400])

    body = cli("detail", "1-max-dico")
    ok("no __pycache__ is written beside the judge (-B)",
       not (MODULE_DIR / "judge" / "__pycache__").exists(),
       sorted(p.name for p in (MODULE_DIR / "judge").iterdir()))
    ok("and detail still answers", body["ok"], body)


def test_missing_folder(cli, root):
    section("a folder that disappears")
    from judge import problems as problems_mod
    before = len(problems_mod.scan(root))
    gone = root / "10-trier-sans-trier"
    ok("the witness folder is there", gone.is_dir(), gone)
    shutil.rmtree(gone)

    eq("one drill fewer in the index", len(problems_mod.scan(root)), before - 1)
    body = cli("detail", "10-trier-sans-trier", expect_ok=False)
    eq("the detail of the departed is a not_found", body["error_kind"], "not_found")
    ok("and no traceback", "Traceback" not in cli.stderr(), cli.stderr()[-400:])
    eq("loading an absent meta.json raises nothing",
       problems_mod.load_problem(gone / "meta.json"), None)
    eq("scanning an absent root gives an empty index",
       problems_mod.scan(root / "pas-la"), {})


def test_has_tests_unit():
    section("has_tests (unit)")
    from judge import problems as problems_mod
    tmp = Path(tempfile.mkdtemp(prefix="nsi-tests-flag-"))
    try:
        cases = {
            "TESTS = [{\"name\": \"a\"}]\n": (True, 1),
            "TESTS = []\n": (False, 0),
            "TESTS = ()\n": (False, 0),
            "TESTS = None\n": (False, None),
            "# rien du tout\n": (False, None),
            "TESTS = [c for c in range(3)]\n": (True, None),
            "TESTS = [\n": (False, None),
            "TESTS = []\nTESTS = [1]\n": (True, 1),
        }
        for i, (src, expected) in enumerate(cases.items()):
            path = tmp / f"tests_{i}.py"
            path.write_text(src, encoding="utf-8", newline="")
            eq(f"{src.splitlines()[0][:28]!r}", problems_mod.read_tests(path), expected)
        eq("no file at all", problems_mod.read_tests(tmp / "absent.py"), (False, None))
        counted = tmp / "counted.py"
        counted.write_text("TESTS = [1, 2, 3]\n", encoding="utf-8", newline="")
        eq("a literal suite is counted", problems_mod.read_tests(counted), (True, 3))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_correction_body_unit():
    section("a correction, or a promise of one (unit)")
    from judge import problems as problems_mod
    body = problems_mod.correction_body
    eq("a python correction", body("def f():\n    return 1\n", ".py"),
       "def f():\n    return 1")
    eq("comments only: a promise", body("# correction : à écrire\n", ".py"), "")
    eq("comments and blanks: still a promise", body("#\n\n   \n# x\n", ".py"), "")
    eq("an indented comment is a comment", body("    # x\n", ".py"), "")
    eq("code under a comment is a correction",
       body("# why\nx = 1\n", ".py"), "x = 1")
    eq("empty", body("", ".py"), "")
    eq("markdown prose is a correction", body("Le hachage.\n", ".md"), "Le hachage.")
    eq("empty markdown is not", body("\n   \n", ".md"), "")


def test_log_unit():
    section("the log is the whole record (unit)")
    tmp = Path(tempfile.mkdtemp(prefix="nsi-log-"))
    try:
        store = store_mod.Store(tmp / ".nsi")
        eq("no file, no lines", store.read_log(), [])
        eq("and no attempts", store.attempts("1-a"), 0)
        eq("nor a solve", store.solved("1-a"), False)

        store.append_log({"problem": "1-a", "verdict": "fail", "attempt": 1})
        store.append_log({"note": "une correction écrite à la main"})
        store.append_log({"problem": "2-b", "verdict": "pass", "attempt": 1})
        store.append_log({"problem": "1-a", "verdict": "partial", "attempt": 2,
                          "correction_viewed": True})
        eq("two graded lines for the first", store.attempts("1-a"), 2)
        eq("a note counts for no attempt", store.attempts("2-b"), 1)
        eq("partial is not a pass", store.solved("1-a"), False)
        eq("a pass is", store.solved("2-b"), True)
        eq("the correction was seen", store.correction_seen("1-a"), True)
        eq("and not for the other", store.correction_seen("2-b"), False)
        ok("every line got a timestamp",
           all(l.get("ts") for l in store.read_log()), store.read_log())
        eq("newest first", store.read_log(1)[0]["problem"], "1-a")
        ok("the file is append only: four lines, four writes",
           len((tmp / ".nsi" / "log.jsonl").read_text(encoding="utf-8")
               .strip().splitlines()) == 4, "")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_vocabulary_unit():
    section("the constraint vocabulary (unit)")
    src = ("import math\n"
           "def f(xs):\n"
           "    ys = [x for x in xs]\n"
           "    ys.append(1)\n"
           "    zs = ys[1:3]\n"
           "    for y in ys:\n"
           "        pass\n"
           "    return len(zs)\n")
    analysis, err = astcheck.parse(src)
    ok("the witness parses", err is None, err)
    for token, expected in {"import": True, "comprehension": True, ".append": True,
                            "list-methods": True, "slice": True, "for": True,
                            "loop": True, "len": True, "max": False,
                            "while": False, "sorted": False}.items():
        eq(f"`{token}`", bool(analysis.occurrences(token, "f")), expected)


def test_messages_english(cli, root):
    """The app is English: the checker and the runner speak it too.

    Run last: every case here submits against `1-max-dico` and so adds to its
    record.
    """
    section("the checker and the runner speak English")
    pid = "1-max-dico"
    answer = root / pid / "solution.py"

    write(answer, CHEAT)
    body = cli("submit", pid)
    eq("a forbidden name", body["constraint_violations"][0]["message"],
       "forbidden: `max` used on line 4.")

    write(answer, "def max_dico(dico):\n    return 0\n")
    body = cli("submit", pid)
    eq("a required construct", body["constraint_violations"][0]["message"],
       "required but missing: a for loop.")

    write(answer, "def max_dico(d):\n    for c in d:\n        pass\n    return 0\n")
    body = cli("submit", pid)
    eq("a wrong signature", body["constraint_violations"][0]["message"],
       "expected signature `max_dico(dico)`, found `max_dico(d)` on line 1.")

    write(answer, "def max_dico(dico)\n")
    body = cli("submit", pid)
    message = body["constraint_violations"][0]["message"]
    ok("a syntax error", message.startswith("syntax error on line 1: "), message)

    write(answer, "def max_dico(dico):\n    for c in dico:\n        pass\n    return 'x'\n")
    body = cli("submit", pid)
    eq("a wrong return type, from the child runner", body["tests"][0]["error"],
       "expected return type int or float, got str")

    eq("the label of a method", astcheck.label(".append"), "the .append method")
    eq("the label of a node class", astcheck.label("recursion"), "recursion")
    eq("the label of a bare name", astcheck.label("sorted"), "`sorted`")
    eq("a timeout naming the test", code_checker._timeout_message("négatifs", 5.0),
       "timed out (5 s) during the test “négatifs”: infinite loop, or too slow?")
    eq("a timeout naming none", code_checker._timeout_message(None, 5.0),
       "timed out (5 s): infinite loop, or too slow?")


# ----------------------------------------------------------------------- main


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="nsi-cli-test-"))
    root = tmp / "1-drills"
    try:
        build_tree(root)
        cli = Cli(root)
        test_detail(cli)
        test_submit_code(cli, root)
        test_submit_without_tests(cli, root)
        test_not_judgeable(cli, root)
        test_reveal(cli)
        test_tags(cli, root)
        test_surface(cli, root)
        test_missing_folder(cli, root)
        test_has_tests_unit()
        test_correction_body_unit()
        test_log_unit()
        test_vocabulary_unit()
        test_messages_english(cli, root)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILED:
        print(f"{PASSED} ok, {len(FAILED)} FAILED")
        for sec, label, detail in FAILED:
            print(f" - [{sec}] {label}")
        return 1
    print(f"{PASSED} ok, nothing failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
