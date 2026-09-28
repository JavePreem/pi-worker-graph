"""Makes one task's mutants: the reference with one small fault each.

    python3 mutate.py <task> <reference-dir> <hidden.json> <out.json> [count] [seed]

A mutant changes one operator or constant in the reference package: a
comparison, an arithmetic or boolean operator, a `not`, an integer, or a
boolean literal. Sites are drawn in a seeded order, and a mutant is kept only
if the hidden cases catch it within the time limit -- one they do not catch may
be equivalent to the reference, and no test can be blamed for missing it.

The output is a list of {"file": <path relative to the reference dir>,
"source": <the whole mutated file>, "site": <what was changed>}.
"""

import ast
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RUN_SECONDS = 60
MAX_TRIES = 400

COMPARE_SWAPS = {
    ast.Eq: ast.NotEq,
    ast.NotEq: ast.Eq,
    ast.Lt: ast.LtE,
    ast.LtE: ast.Lt,
    ast.Gt: ast.GtE,
    ast.GtE: ast.Gt,
    ast.In: ast.NotIn,
    ast.NotIn: ast.In,
    ast.Is: ast.IsNot,
    ast.IsNot: ast.Is,
}
BINOP_SWAPS = {ast.Add: ast.Sub, ast.Sub: ast.Add, ast.Mult: ast.FloorDiv}
BOOLOP_SWAPS = {ast.And: ast.Or, ast.Or: ast.And}


def sites(tree):
    """Every mutable spot, as (node index in ast.walk order, kind)."""
    found = []
    for index, node in enumerate(ast.walk(tree)):
        if isinstance(node, ast.Compare) and type(node.ops[0]) in COMPARE_SWAPS:
            found.append((index, "compare"))
        elif isinstance(node, ast.BinOp) and type(node.op) in BINOP_SWAPS:
            found.append((index, "binop"))
        elif isinstance(node, ast.BoolOp) and type(node.op) in BOOLOP_SWAPS:
            found.append((index, "boolop"))
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            found.append((index, "not"))
        elif isinstance(node, ast.Constant) and type(node.value) is bool:
            found.append((index, "bool"))
        elif isinstance(node, ast.Constant) and type(node.value) is int:
            found.append((index, "int"))
    return found


class _Replace(ast.NodeTransformer):
    """Replaces one node, found by identity, with another."""

    def __init__(self, old, new):
        self.old = old
        self.new = new

    def generic_visit(self, node):
        if node is self.old:
            return self.new
        return super().generic_visit(node)


class Mutator:
    def __init__(self, target):
        self.target = target
        self.site = None

    def mutate(self, tree):
        # ast.walk order, applied by identity: walk once to find the node.
        for index, node in enumerate(ast.walk(tree)):
            if index == self.target:
                break
        else:
            return None
        line = getattr(node, "lineno", "?")
        if isinstance(node, ast.Compare):
            node.ops[0] = COMPARE_SWAPS[type(node.ops[0])]()
            self.site = f"line {line}: comparison swapped"
        elif isinstance(node, ast.BinOp):
            node.op = BINOP_SWAPS[type(node.op)]()
            self.site = f"line {line}: arithmetic swapped"
        elif isinstance(node, ast.BoolOp):
            node.op = BOOLOP_SWAPS[type(node.op)]()
            self.site = f"line {line}: and/or swapped"
        elif isinstance(node, ast.UnaryOp):
            self.site = f"line {line}: not removed"
            return _Replace(node, node.operand).visit(tree)
        elif type(node.value) is bool:
            node.value = not node.value
            self.site = f"line {line}: boolean flipped"
        else:
            node.value = node.value + 1
            self.site = f"line {line}: integer incremented"
        return tree


def mutate_source(source, target):
    tree = ast.parse(source)
    mutator = Mutator(target)
    mutated = mutator.mutate(tree)
    if mutated is None:
        return None, None
    return ast.unparse(ast.fix_missing_locations(mutated)), mutator.site


def caught(task, reference, relative, text, hidden):
    with tempfile.TemporaryDirectory() as scratch:
        copy = os.path.join(scratch, "impl")
        shutil.copytree(reference, copy)
        with open(os.path.join(copy, relative), "w", encoding="utf8") as f:
            f.write(text)
        out = os.path.join(scratch, "out.json")
        try:
            subprocess.run(
                [sys.executable, os.path.join(HERE, "runner.py"), task, copy, hidden, out],
                timeout=RUN_SECONDS,
                check=False,
                capture_output=True,
            )
        except subprocess.TimeoutExpired:
            return False
        if not os.path.exists(out):
            return False
        with open(out, encoding="utf8") as f:
            groups = json.load(f)["groups"]
        return any(g["passed"] < g["total"] for g in groups.values())


def main():
    task, reference, hidden, out = sys.argv[1:5]
    count = int(sys.argv[5]) if len(sys.argv) > 5 else 40
    seed = int(sys.argv[6]) if len(sys.argv) > 6 else 1
    candidates = []
    for root, _dirs, files in os.walk(reference):
        for name in sorted(files):
            path = os.path.join(root, name)
            relative = os.path.relpath(path, reference)
            # The adapter is the contract, not the implementation under test.
            if not name.endswith(".py") or os.sep not in relative:
                continue
            with open(path, encoding="utf8") as f:
                source = f.read()
            for index, _kind in sites(ast.parse(source)):
                candidates.append((relative, index))
    candidates.sort()
    random.Random(seed).shuffle(candidates)
    kept = []
    for relative, index in candidates[:MAX_TRIES]:
        if len(kept) >= count:
            break
        with open(os.path.join(reference, relative), encoding="utf8") as f:
            text, site = mutate_source(f.read(), index)
        if text is None:
            continue
        if caught(task, reference, relative, text, hidden):
            kept.append({"file": relative, "source": text, "site": site})
    with open(out, "w", encoding="utf8") as f:
        json.dump(kept, f)
    print(f"{task}: kept {len(kept)} mutants from {len(candidates)} sites")


if __name__ == "__main__":
    main()
