"""Static checks on the user's solution.py: constraints and signature.

Constraint vocabulary (app/CLAUDE.md):

- builtin names: any bare name, e.g. `max`, `sorted`, `sum`, `len`
- method calls: leading dot, e.g. `.append`, `.sort`; group `list-methods`
  expands to every list method
- node classes: `for`, `while`, `loop` (either), `comprehension`, `slice`,
  `import`, `lambda`, `try`, `recursion`

Nothing here executes user code: ast.parse only.
"""

from __future__ import annotations

import ast

LIST_METHODS = (
    "append", "extend", "insert", "remove", "pop", "clear",
    "index", "count", "sort", "reverse", "copy",
)

_TRY_NODES = (ast.Try,) + ((ast.TryStar,) if hasattr(ast, "TryStar") else ())

NODE_CLASSES = {
    "for": (ast.For, ast.AsyncFor),
    "while": (ast.While,),
    "loop": (ast.For, ast.AsyncFor, ast.While),
    "comprehension": (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp),
    "import": (ast.Import, ast.ImportFrom),
    "lambda": (ast.Lambda,),
    "try": _TRY_NODES,
}

SPECIAL = ("slice", "recursion")

LABELS = {
    "for": "a for loop",
    "while": "a while loop",
    "loop": "a loop",
    "comprehension": "a list comprehension",
    "slice": "a slice",
    "import": "an import",
    "lambda": "a lambda",
    "try": "try/except",
    "recursion": "recursion",
    "list-methods": "a list method",
}


def label(token: str) -> str:
    token = token.strip()
    if token in LABELS:
        return LABELS[token]
    if token.startswith("."):
        return f"the {token} method"
    return f"`{token}`"


class Analysis:
    """Parsed solution plus the lookups the checkers need."""

    def __init__(self, tree: ast.AST):
        self.tree = tree
        self.functions = {}       # name -> FunctionDef (first definition wins)
        self.call_graph = {}      # name -> {called name -> first lineno}
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.functions.setdefault(node.name, node)
                calls = self.call_graph.setdefault(node.name, {})
                for sub in ast.walk(node):
                    if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name):
                        calls.setdefault(sub.func.id, sub.lineno)

    # ------------------------------------------------------------- occurrences

    def occurrences(self, token: str, function: str | None = None) -> list:
        """Line numbers where `token` appears. Empty list = absent."""
        token = (token or "").strip()
        if not token:
            return []
        if token == "list-methods":
            lines = []
            for method in LIST_METHODS:
                lines.extend(self._method_lines(method))
            return sorted(set(lines))
        if token.startswith("."):
            return self._method_lines(token[1:])
        if token == "recursion":
            line = self._recursion_line(function)
            return [line] if line is not None else []
        if token == "slice":
            return self._slice_lines()
        if token in NODE_CLASSES:
            classes = NODE_CLASSES[token]
            return sorted(
                node.lineno
                for node in ast.walk(self.tree)
                if isinstance(node, classes)
            )
        return self._name_lines(token)

    def _name_lines(self, name: str) -> list:
        """Lines where `name` is read.

        A forbidden builtin is forbidden however it is spelled: the bare name
        `max`, but also `builtins.max` or `__import__('builtins').max`, which
        are the same call wearing a hat.
        """
        lines = []
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Name) and node.id == name:
                if isinstance(node.ctx, ast.Load):
                    lines.append(node.lineno)
            elif isinstance(node, ast.Attribute) and node.attr == name:
                lines.append(node.lineno)
        return sorted(set(lines))

    # ------------------------------------------------------------- bypasses

    def bypass_lines(self, forbidden_tokens) -> list:
        """Occurrences of the usual ways around a `forbidden` list.

        Only checked when the problem declares one. No reachability analysis:
        a mention is a violation, dead code included.
        """
        bare = set()
        for token in forbidden_tokens or []:
            token = (token or "").strip()
            if not token:
                continue
            if token == "list-methods":
                bare.update(LIST_METHODS)
            elif token.startswith("."):
                bare.add(token[1:])
            elif token not in NODE_CLASSES and token not in SPECIAL:
                bare.add(token)

        out = []
        for node in ast.walk(self.tree):
            name = None
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                name = node.id
            elif isinstance(node, ast.Attribute):
                name = node.attr
            if name in ("eval", "exec", "__import__", "__builtins__"):
                out.append((name, node.lineno,
                            f"forbidden workaround: `{name}` on line {node.lineno}."))
                continue
            if isinstance(node, ast.Call) and _callee_name(node.func) == "getattr":
                out.extend(self._getattr_violations(node, bare))
        out.sort(key=lambda item: (item[1], item[0]))
        return out

    def _getattr_violations(self, node: ast.Call, bare: set) -> list:
        line = node.lineno
        if len(node.args) < 2:
            return []
        attr = node.args[1]
        if isinstance(attr, ast.Constant) and isinstance(attr.value, str):
            if attr.value in bare:
                return [("getattr", line,
                         f"forbidden workaround: `getattr(..., {attr.value!r})` "
                         f"on line {line}.")]
            return []
        return [("getattr", line,
                 f"forbidden workaround: `getattr` with a computed name on line {line}.")]

    def _method_lines(self, attr: str) -> list:
        lines = []
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Attribute) and node.attr == attr:
                lines.append(node.lineno)
        return sorted(set(lines))

    def _slice_lines(self) -> list:
        lines = []
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Slice):
                lines.append(node.lineno)
            elif isinstance(node, ast.Slice) and hasattr(node, "lineno"):
                lines.append(node.lineno)
        return sorted(set(lines))

    def _recursion_line(self, function: str | None):
        """Line of the call that closes a recursive cycle.

        Direct recursion: the line where `function` calls itself. Mutual
        recursion: the line where `function` calls the helper that leads back.
        """
        names = [function] if function and function in self.call_graph else list(self.call_graph)
        for start in names:
            seen = {start}
            # (name to expand, line of the call made *by start* that got us here)
            frontier = [(callee, line) for callee, line in self.call_graph.get(start, {}).items()]
            while frontier:
                nxt = []
                for callee, origin_line in frontier:
                    if callee == start:
                        return origin_line
                    if callee in seen or callee not in self.call_graph:
                        continue
                    seen.add(callee)
                    for deeper in self.call_graph[callee]:
                        nxt.append((deeper, origin_line))
                frontier = nxt
        return None

    # --------------------------------------------------------------- signature

    def param_names(self, function: str):
        node = self.functions.get(function)
        if node is None:
            return None
        args = node.args
        names = [a.arg for a in list(args.posonlyargs) + list(args.args)]
        if args.vararg:
            names.append("*" + args.vararg.arg)
        names.extend(a.arg for a in args.kwonlyargs)
        if args.kwarg:
            names.append("**" + args.kwarg.arg)
        return names


def _callee_name(func: ast.AST):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def violation(kind: str, construct: str, line, message: str) -> dict:
    return {"type": kind, "construct": construct, "line": line, "message": message}


def parse(source: str, filename: str = "solution.py"):
    """Return (analysis, error_dict). Exactly one of the two is None."""
    try:
        tree = ast.parse(source, filename=filename)
    except SyntaxError as exc:
        line = exc.lineno
        detail = exc.msg or "syntax error"
        return None, violation(
            "syntax", "syntax", line,
            f"syntax error on line {line}: {detail}",
        )
    except ValueError as exc:  # e.g. source with null bytes
        return None, violation("syntax", "syntax", None, f"unreadable file: {exc}")
    return Analysis(tree), None


def check_signature(analysis: Analysis, function: str, params) -> list:
    """Declared function must exist with exactly the declared params."""
    out = []
    if not function:
        return out
    names = analysis.param_names(function)
    if names is None:
        out.append(violation(
            "signature", function, None,
            f"the function `{function}` is not defined in solution.py.",
        ))
        return out
    expected = list(params or [])
    if names != expected:
        node = analysis.functions[function]
        got = ", ".join(names) if names else "none"
        want = ", ".join(expected) if expected else "none"
        out.append(violation(
            "signature", function, node.lineno,
            f"expected signature `{function}({want})`, found `{function}({got})` "
            f"on line {node.lineno}.",
        ))
    return out


def check_constraints(analysis: Analysis, constraints: dict, function: str | None = None) -> list:
    constraints = constraints or {}
    out = []
    forbidden = constraints.get("forbidden") or []
    if forbidden:
        # A problem that forbids anything also forbids the three doors around
        # the check: eval/exec/__import__, __builtins__, dynamic getattr.
        for construct, line, message in analysis.bypass_lines(forbidden):
            out.append(violation("forbidden", construct, line, message))
    for token in forbidden:
        lines = analysis.occurrences(token, function)
        if lines:
            line = lines[0]
            out.append(violation(
                "forbidden", token, line,
                f"forbidden: {label(token)} used on line {line}.",
            ))
    for token in constraints.get("required") or []:
        lines = analysis.occurrences(token, function)
        if not lines:
            out.append(violation(
                "required", token, None,
                f"required but missing: {label(token)}.",
            ))
    return out


def check(source: str, code_meta: dict) -> list:
    """Full static pass. Returns a list of violation dicts (empty = clean)."""
    code_meta = code_meta or {}
    analysis, err = parse(source)
    if err is not None:
        return [err]
    function = code_meta.get("function")
    out = check_signature(analysis, function, code_meta.get("params"))
    out.extend(check_constraints(analysis, code_meta.get("constraints"), function))
    return out
