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

import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MODULE_DIR))

from judge import astcheck, code_checker, scheduler, store as store_mod  # noqa: E402

VERBOSE = "-v" in sys.argv
PASSED = 0
FAILED = []
SECTION = "—"

ROW_FIELDS = sorted([
    "id", "number", "title", "tags", "has_tests", "tests_count",
    "has_correction", "judged",
    "status", "due", "attempts", "solved_at", "interval_days",
    "correction_viewed", "overdue_days", "duree_s", "meilleure_s"])


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

    def log(self, limit=None) -> list:
        """The log as the judge wrote it, newest first.

        Read from the file: `log` was a CLI verb nothing could reach and it is
        gone, so the test reads what the plugin would read.
        """
        return store_mod.Store(self.root / ".nsi").read_log(limit)


# ---------------------------------------------------------------------- tests


def test_list(cli):
    section("list")
    body = cli("list")
    ids = [d["id"] for d in body["drills"]]
    eq("six drills indexed", len(ids), 6)
    eq("sorted by number, 10 after 5 and not after 1",
       ids, ["1-max-dico", "2-derouler-inversion", "3-dico-rapide", "5-parcours",
             "7-une-promesse", "10-trier-sans-trier"])
    ok("the rows are under `drills`, one word", "problems" not in body, sorted(body))

    row = body["drills"][0]
    eq("the fields of a row", sorted(row), ROW_FIELDS)
    ok("no kind, no source, no chapter, no difficulty, no concepts",
       not {"kind", "source", "source_ref", "chapter", "difficulty",
            "concepts"} & set(row), sorted(row))
    eq("the number is an integer", row["number"], 1)
    eq("and so is 10's", body["drills"][-1]["number"], 10)

    by_id = {d["id"]: d for d in body["drills"]}
    eq("has_tests: there are cases", by_id["1-max-dico"]["has_tests"], True)
    eq("and the page can say how many", by_id["1-max-dico"]["tests_count"], 2)
    eq("no cases, no count", by_id["3-dico-rapide"]["tests_count"], None)
    eq("has_tests: an empty TESTS counts for nothing",
       by_id["2-derouler-inversion"]["has_tests"], False)
    eq("has_tests: no tests.py at all",
       by_id["3-dico-rapide"]["has_tests"], False)
    eq("judged: cases", by_id["1-max-dico"]["judged"], True)
    eq("judged: a correction is enough", by_id["2-derouler-inversion"]["judged"], True)
    eq("not judged: neither one nor the other",
       by_id["10-trier-sans-trier"]["judged"], False)
    eq("and it says so through has_correction too",
       by_id["10-trier-sans-trier"]["has_correction"], False)
    eq("a correction that is only a promise is not a correction",
       by_id["7-une-promesse"]["has_correction"], False)
    eq("so the promise is not judgeable either",
       by_id["7-une-promesse"]["judged"], False)
    ok("no time to start with",
       all(d["duree_s"] is None and d["meilleure_s"] is None
           for d in body["drills"]), body["drills"][0])
    ok("the data dir is announced", body["data_dir"].endswith(".nsi"), body["data_dir"])


def test_detail(cli):
    section("detail, paths and accents")
    body = cli("detail", "1-max-dico")
    eq("title", body["title"], "Maximum d'un dictionnaire")
    ok("the statement keeps its accents", "Écrire" in body["enonce"], body["enonce"][:80])
    ok("the answer seed is the signature",
       body["answer"].startswith("def max_dico(dico):"), body["answer"])
    ok("with a docstring", '"""' in body["answer"], body["answer"])
    eq("the answer file does not exist yet", body["answer_exists"], False)
    ok("every field of a row is here too",
       set(ROW_FIELDS) <= set(body), sorted(set(ROW_FIELDS) - set(body)))

    eq("folder", body["folder"], "1-max-dico")
    eq("answer_path", body["answer_path"], "1-max-dico/solution.py")
    eq("enonce_path", body["enonce_path"], "1-max-dico/enonce.md")
    eq("tests_path", body["tests_path"], "1-max-dico/tests.py")
    eq("correction_path", body["correction_path"], "1-max-dico/correction.py")
    eq("correction_format", body["correction_format"], "py")
    eq("has_correction", body["has_correction"], True)
    eq("meta is rendered whole", body["meta"]["code"]["constraints"]["forbidden"], ["max"])

    body = cli("detail", "3-dico-rapide")
    eq("an old `written` meta is read as code, kind and all", body["has_tests"], False)
    eq("with no signature the seed is an English comment", body["answer"], "# answer\n")
    eq("the id is the folder's name, not the meta's", body["id"], "3-dico-rapide")
    eq("and the meta is answered with the folder's id too",
       body["meta"]["id"], "3-dico-rapide")
    eq("a markdown correction", body["correction_format"], "md")

    body = cli("detail", "10-trier-sans-trier")
    eq("free-form: no correction", body["correction_path"], None)
    eq("nor a format", body["correction_format"], None)
    eq("nor a judge", body["judged"], False)
    eq("tests_path is still where they would go", body["tests_path"],
       "10-trier-sans-trier/tests.py")

    unknown = cli("detail", "99-rien", expect_ok=False)
    eq("unknown id", unknown["error_kind"], "not_found")


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

    write(answer, HALF)
    body = cli("submit", pid)
    eq("one test of two", (body["verdict"], body["passed"], body["total"]),
       ("partial", 1, 2))
    ok("the failing test is named", "négatifs" in body["failed_tests"], body["failed_tests"])

    write(answer, GOOD)
    body = cli("submit", pid, "--duration", "120")
    eq("passed", body["verdict"], "pass")
    eq("status", body["status"], "solved")
    eq("three attempts", body["state"]["attempts"], 3)
    eq("the struggling interval (3 attempts)", body["state"]["interval_days"], 3)
    eq("the duration is logged", body["logged"]["duration_s"], 120)
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


def test_submit_without_tests(cli, root):
    section("submit: without tests")
    pid = "2-derouler-inversion"
    answer = root / pid / "solution.py"

    write(answer, "   \n")
    body = cli("submit", pid, expect_ok=False)
    eq("an empty answer is refused", body["error_kind"], "bad_request")
    ok("and nothing is revealed", "correction" not in body, body)

    before = len(cli.log())
    write(answer, "# la clé 'a' est écrasée par 'c'\n")
    body = cli("submit", pid, "--duration", "45")
    eq("no automatic verdict", body["verdict"], None)
    eq("not graded", body["graded"], False)
    eq("a self-grade is awaited", body["awaiting_selfgrade"], True)
    ok("the correction is handed over", "écrasée" in body["correction"], body["correction"][:80])
    eq("its format", body["correction_format"], "md")
    eq("no log line before the self-grade", len(cli.log()), before)
    eq("status unchanged", body["status"], "unseen")
    eq("but the correction is noted as seen", body["state"]["correction_viewed"], True)

    body = cli("selfgrade", pid, "pass", "--duration", "60")
    eq("the grade is recorded", body["verdict"], "pass")
    eq("solved", body["status"], "solved")
    eq("correction seen: the short interval", body["state"]["interval_days"], 7)
    eq("one log line this time", len(cli.log()), before + 1)


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

    rows = {d["id"]: d for d in cli("list")["drills"]}
    eq("and neither of them moved", rows["7-une-promesse"]["status"], "unseen")
    eq("nor collected an attempt", rows["7-une-promesse"]["attempts"], 0)
    eq("nor a log line",
       [l for l in cli.log() if l.get("problem") == "7-une-promesse"], [])

    # The moment the promise is kept, the drill is judgeable again.
    write(root / "7-une-promesse" / "correction.py",
          "def promesse():\n    return 42\n")
    rows = {d["id"]: d for d in cli("list")["drills"]}
    eq("a correction with code in it counts", rows["7-une-promesse"]["judged"], True)
    body = cli("submit", "7-une-promesse")
    eq("and submit hands it over", body["awaiting_selfgrade"], True)
    write(root / "7-une-promesse" / "correction.py", CORRECTION_PLACEHOLDER)


def test_reveal_and_selfgrade_anywhere(cli):
    section("reveal, and a self-grade on a drill that has tests")
    body = cli("reveal", "5-parcours")
    ok("the correction is handed over",
       body["correction"].startswith("def somme"), body["correction"][:60])
    eq("with its format", body["correction_format"], "py")
    eq("revealing without solving is a failure", body["status"], "failed")
    eq("correction_viewed", body["state"]["correction_viewed"], True)
    eq("a reveal adds no log line",
       [l["problem"] for l in cli.log() if l["problem"] == "5-parcours"], [])

    body = cli("selfgrade", "5-parcours", "partial")
    eq("a self-grade is accepted even with tests", body["verdict"], "partial")
    eq("partial counts as a failure", body["status"], "failed")
    eq("and this time the log moves",
       [l["problem"] for l in cli.log() if l["problem"] == "5-parcours"],
       ["5-parcours"])

    proc = subprocess.run(
        [sys.executable, "-B", "-m", "judge.cli", "--root", str(cli.root),
         "selfgrade", "5-parcours", "excellent"],
        cwd=str(MODULE_DIR), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=dict(os.environ, PYTHONUTF8="1"), timeout=60)
    eq("an invented verdict is a usage error", proc.returncode, 2)
    eq("and nothing on stdout", proc.stdout.strip(), b"")


def test_next(cli):
    section("next")
    body = cli("next")
    eq("the failure comes back first", body["drill"]["id"], "5-parcours")
    ok("the reason is in English", "failed" in body["reason"], body["reason"])
    eq("the row it hands back is a list row", sorted(body["drill"]), ROW_FIELDS)
    ok("one word for the thing: `drill`", "problem" not in body, sorted(body))


def test_timings(cli, root):
    section("duree_s and meilleure_s")
    rows = {d["id"]: d for d in cli("list")["drills"]}
    eq("the last timed submission", rows["1-max-dico"]["duree_s"], 120)
    eq("and the best pass", rows["1-max-dico"]["meilleure_s"], 120)
    eq("a self-grade counts as a submission",
       rows["2-derouler-inversion"]["duree_s"], 60)
    eq("and as a pass", rows["2-derouler-inversion"]["meilleure_s"], 60)
    eq("an untimed submission counts for neither",
       rows["5-parcours"]["duree_s"], None)
    eq("a failure is never a best", rows["5-parcours"]["meilleure_s"], None)
    eq("never submitted: nothing", rows["3-dico-rapide"]["duree_s"], None)

    write(root / "1-max-dico" / "solution.py", GOOD)
    body = cli("submit", "1-max-dico", "--duration", "45")
    eq("faster this time", body["verdict"], "pass")
    rows = {d["id"]: d for d in cli("list")["drills"]}
    eq("the last duration follows", rows["1-max-dico"]["duree_s"], 45)
    eq("the best comes down", rows["1-max-dico"]["meilleure_s"], 45)

    cli("submit", "1-max-dico", "--duration", "300")
    rows = {d["id"]: d for d in cli("list")["drills"]}
    eq("a slower submission does not raise the best",
       rows["1-max-dico"]["meilleure_s"], 45)
    eq("but it is the last one", rows["1-max-dico"]["duree_s"], 300)
    eq("detail says the same",
       (cli("detail", "1-max-dico")["duree_s"], cli("detail", "1-max-dico")["meilleure_s"]),
       (300, 45))

    # A best time belongs to a drill that has ever passed, and a later failure
    # does not take it away (ADV-N: the column blinked in and out).
    cli("selfgrade", "1-max-dico", "fail", "--duration", "20")
    rows = {d["id"]: d for d in cli("list")["drills"]}
    eq("the drill is failed now", rows["1-max-dico"]["status"], "failed")
    eq("and it keeps the best time it earned",
       rows["1-max-dico"]["meilleure_s"], 45)
    write(root / "1-max-dico" / "solution.py", GOOD)
    cli("submit", "1-max-dico", "--duration", "300")


def test_tags(cli, root):
    section("tags")
    rows = {d["id"]: d for d in cli("list")["drills"]}
    eq("written in meta", rows["1-max-dico"]["tags"], ["dictionnaires"])
    eq("an old `concepts` list is not read as tags any more",
       rows["3-dico-rapide"]["tags"], [])
    eq("a written `tags` is cleaned and de-duplicated",
       rows["2-derouler-inversion"]["tags"], ["révision", "listes"])
    ok("always a list, never null",
       all(isinstance(r["tags"], list) for r in rows.values()),
       {k: v["tags"] for k, v in rows.items()})
    eq("detail answers the same",
       cli("detail", "1-max-dico")["tags"], ["dictionnaires"])
    ok("and nothing was written to disk for it",
       "tags" not in json.loads((root / "3-dico-rapide" / "meta.json")
                                .read_text(encoding="utf-8")), "")

    # The two dead fields: read by nothing, and so on no row and in no detail.
    legacy = cli("detail", "3-dico-rapide")
    ok("neither dead field reaches a detail",
       not {"difficulty", "concepts"} & set(legacy), sorted(legacy))
    eq("the file itself still carries them", legacy["meta"]["difficulty"], 2)
    ok("and a meta that never had them reads the same",
       not {"difficulty", "concepts"} & set(cli("detail", "1-max-dico")["meta"]),
       sorted(cli("detail", "1-max-dico")["meta"]))

    from judge import problems as problems_mod
    eq("cleaning folds the blanks and the empties",
       problems_mod.clean_tags(["  a  b ", "", None, "a b", "c"]), ["a b", "c"])
    eq("an empty list stays empty", problems_mod.clean_tags([]), [])


def test_update(cli, root):
    section("update: the tags, and nothing else")
    folder = root / "1-max-dico"
    meta_path = folder / "meta.json"
    enonce_path = folder / "enonce.md"
    raw_before = meta_path.read_text(encoding="utf-8")
    enonce_before = enonce_path.read_text(encoding="utf-8")

    body = cli("update", "1-max-dico", stdin=json.dumps(
        {"tags": ["révision", "  dictionnaires  ", "révision"]}, ensure_ascii=False))
    eq("only the tags change", body["updated"], ["tags"])
    eq("cleaned and de-duplicated", body["tags"], ["révision", "dictionnaires"])
    eq("the statement is untouched",
       enonce_path.read_text(encoding="utf-8"), enonce_before)
    raw_after = meta_path.read_text(encoding="utf-8")
    eq("meta.json changed one value and nothing else",
       raw_after.replace('"révision",\n    "dictionnaires"', '"dictionnaires"'),
       raw_before)
    ok("the answer does not carry a rename it did not do",
       "enonce_renamed" not in body, sorted(body))

    body = cli("update", "1-max-dico", stdin=json.dumps({"tags": []}))
    eq("emptied tags stay empty", body["tags"], [])
    eq("a written empty `tags` beats deriving",
       [d["tags"] for d in cli("list")["drills"] if d["id"] == "1-max-dico"], [[]])

    # A stale `id` is straightened when the file is rewritten anyway. Nothing
    # else moves: a field the judge does not read is not a field it deletes.
    stale = root / "3-dico-rapide" / "meta.json"
    before = json.loads(stale.read_text(encoding="utf-8"))
    eq("the stale id is still there beforehand", before["id"],
       "chapitre-1/07-perso-dico-rapide")
    eq("and the old field name too", before["concepts"], ["complexité"])
    body = cli("update", "3-dico-rapide",
               stdin=json.dumps({"tags": ["complexité"]}, ensure_ascii=False))
    eq("update does not claim to have changed the id", body["updated"], ["tags"])
    after = json.loads(stale.read_text(encoding="utf-8"))
    eq("but the file now carries the folder's name", after["id"], "3-dico-rapide")
    eq("the tags are written", after["tags"], ["complexité"])
    ok("everything the judge no longer reads is left exactly where it was",
       (after.get("kind"), after.get("source"), after.get("difficulty"),
        after.get("concepts")) == ("written", "generated", 2, ["complexité"]),
       after)
    ok("`difficulty` down to its own bytes",
       '"difficulty": 2' in stale.read_text(encoding="utf-8"), "")

    body = cli("update", "1-max-dico", stdin="{}", expect_ok=False)
    eq("an empty spec is refused", body["error_kind"], "bad_request")
    body = cli("update", "1-max-dico", stdin=json.dumps({"title": "x"}),
               expect_ok=False)
    eq("a title is not something update writes any more",
       body["error_kind"], "bad_request")
    body = cli("update", "1-max-dico", stdin=json.dumps({"tags": "révision"}),
               expect_ok=False)
    eq("tags that are not a list are refused", body["error_kind"], "bad_request")
    body = cli("update", "99-rien", stdin=json.dumps({"tags": []}), expect_ok=False)
    eq("unknown id", body["error_kind"], "not_found")


def test_surface(cli):
    section("the surface: seven verbs, and the help says Informatique")
    from judge import cli as cli_mod
    eq("seven commands and no more", sorted(cli_mod.COMMANDS),
       ["detail", "list", "next", "reveal", "selfgrade", "submit", "update"])
    for gone in ("create", "convert", "migrate", "migrate-flat", "stats", "log"):
        ok(f"`{gone}` is gone", gone not in cli_mod.COMMANDS, sorted(cli_mod.COMMANDS))
    for gone in ("cmd_create", "cmd_convert", "cmd_migrate", "cmd_migrate_flat",
                 "cmd_stats", "cmd_log", "slugify", "numbering", "spell_number",
                 "rename_h1", "convert_folder", "comment_block"):
        ok(f"and so is `{gone}`", not hasattr(cli_mod, gone), gone)
    ok("App has no stats either", not hasattr(cli_mod.App, "stats"), "")

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
    ok("and --spec with it", "--spec" not in help_text, help_text[:400])

    body = cli("list")
    ok("no __pycache__ is written beside the judge (-B)",
       not (MODULE_DIR / "judge" / "__pycache__").exists(),
       sorted(p.name for p in (MODULE_DIR / "judge").iterdir()))
    ok("and list still answers", body["ok"], body)


def test_missing_folder(cli, root):
    section("a folder that disappears")
    before = len(cli("list")["drills"])
    gone = root / "10-trier-sans-trier"
    ok("the witness folder is there", gone.is_dir(), gone)
    shutil.rmtree(gone)

    body = cli("list")
    eq("list answers anyway", body["ok"], True)
    eq("with one drill fewer", len(body["drills"]), before - 1)
    ok("and no traceback", "Traceback" not in cli.stderr(), cli.stderr()[-400:])
    body = cli("detail", "10-trier-sans-trier", expect_ok=False)
    eq("the detail of the departed is a not_found", body["error_kind"], "not_found")
    eq("next still answers", cli("next")["ok"], True)

    from judge import problems as problems_mod
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
            "TESTS = [{\"name\": \"a\"}]\n": True,
            "TESTS = []\n": False,
            "TESTS = ()\n": False,
            "TESTS = None\n": False,
            "# rien du tout\n": False,
            "TESTS = [c for c in range(3)]\n": True,
            "TESTS = [\n": False,
            "TESTS = []\nTESTS = [1]\n": True,
        }
        for i, (src, expected) in enumerate(cases.items()):
            path = tmp / f"tests_{i}.py"
            path.write_text(src, encoding="utf-8", newline="")
            eq(f"{src.splitlines()[0][:28]!r}", problems_mod.read_tests_flag(path), expected)
        eq("no file at all", problems_mod.read_tests_flag(tmp / "absent.py"), False)
        counted = tmp / "counted.py"
        counted.write_text("TESTS = [1, 2, 3]\n", encoding="utf-8", newline="")
        eq("a literal suite is counted", problems_mod.read_tests(counted), (True, 3))
        looped = tmp / "looped.py"
        looped.write_text("TESTS = [c for c in range(3)]\n",
                          encoding="utf-8", newline="")
        eq("a built suite is tests with no count",
           problems_mod.read_tests(looped), (True, None))
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


def test_scheduler_unit():
    section("scheduler (unit)")
    day = _dt.date(2026, 9, 15)
    fresh = store_mod.normalise(None)
    solved = scheduler.apply_verdict(fresh, "pass", day)
    eq("a clean first try: 14 days", solved["interval_days"], 14)
    eq("due", solved["due"], "2026-09-29")
    again = scheduler.apply_verdict(solved, "pass", day)
    eq("passing again before the date pushes nothing", again["due"], solved["due"])
    eq("but counts an attempt", again["attempts"], solved["attempts"] + 1)
    review = scheduler.apply_verdict(solved, "pass", _dt.date(2026, 9, 29))
    eq("a review multiplies by 2.5", review["interval_days"], 35)
    failed = scheduler.apply_verdict(solved, "partial", day)
    eq("partial counts as a failure", failed["status"], "failed")
    eq("back tomorrow", failed["due"], "2026-09-16")
    legacy = store_mod.normalise({"status": "due", "due": "2020-01-01"})
    eq("a stored `due` is read back as solved", legacy["status"], "solved")
    eq("and the date makes it due again", scheduler.display_status(legacy, day), "due")

    unseen = [{"id": "10-x", "number": 10, "status": "unseen"},
              {"id": "2-y", "number": 2, "status": "unseen"},
              {"id": "9-z", "number": 9, "status": "unseen"}]
    item, reason = scheduler.pick_next(unseen, [], day)
    eq("the next unseen drill is the lowest number", item["id"], "2-y")
    ok("and the reason is in English", "new drill" in reason, reason)
    item, _ = scheduler.pick_next(unseen[:1] + unseen[2:], [], day)
    eq("9 before 10, not the other way round", item["id"], "9-z")

    log = [{"verdict": "fail", "tags": ["arbres"]},
           {"verdict": "fail", "tags": ["arbres"]},
           {"verdict": "fail", "tags": ["arbres"]},
           {"verdict": "pass", "tags": ["listes"]},
           {"verdict": "pass", "tags": ["listes"]},
           {"verdict": "pass", "tags": ["listes"]},
           {"verdict": "pass", "concepts": ["arbres"]}]
    eq("the weakest tag is the one that fails",
       scheduler.weakest_tags(log), ["arbres", "listes"])
    eq("an old line's `concepts` counts for no tag",
       scheduler.tag_rates(log)["arbres"]["attempts"], 3)
    tagged = [{"id": "1-a", "number": 1, "status": "unseen", "tags": ["listes"]},
              {"id": "2-b", "number": 2, "status": "unseen", "tags": ["arbres"]}]
    item, reason = scheduler.pick_next(tagged, log, day)
    eq("the weakest tag picks the drill", item["id"], "2-b")
    ok("and says which tag", "arbres" in reason, reason)


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

    Run last: every case here submits against `1-max-dico` and so moves its
    record on.
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
        test_list(cli)
        test_detail(cli)
        test_submit_code(cli, root)
        test_submit_without_tests(cli, root)
        test_not_judgeable(cli, root)
        test_reveal_and_selfgrade_anywhere(cli)
        test_next(cli)
        test_timings(cli, root)
        test_tags(cli, root)
        test_update(cli, root)
        test_surface(cli)
        test_missing_folder(cli, root)
        test_has_tests_unit()
        test_correction_body_unit()
        test_scheduler_unit()
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
