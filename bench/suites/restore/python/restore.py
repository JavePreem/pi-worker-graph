"""Builds and grades restore tasks: a real library with some functions gutted.

    python3 restore.py trace <checkout> <package> <out.json> <test>...
        Run the library's tests with a profiler and record every function of
        the package they call, as {"path": [first line, ...]}. Runs in the task
        image, so the Python that decides what is covered is the one that
        grades.

    python3 restore.py build <checkout> <package> <trace.json> <out.json>
                             <mode> <count> <seed> <min-lines>
        Pick `count` covered functions and write the gutted files:
        {"functions": [...], "files": {path: text}}. `mode` is `spread`
        (across the package's modules, round-robin) or `cluster` (one module,
        starting from the function with the most calls to its neighbours and
        growing along those calls), which is the coupling the suite varies.

    python3 restore.py grade <checkout> <out.json> <test>...
        Run the pinned tests and report {"groups": {test file: {"passed",
        "total", "failures"}}}, the shape `targetStates` reads.

A <test> is a test path, or `--deselect=<node id>` for tests left out of both.
Standard library only: `trace` and `grade` run inside the task image.
"""

import ast
import json
import os
import random
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ElementTree

MAX_DETAIL = 200


def is_docstring(statement):
    return (
        isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Constant)
        and isinstance(statement.value.value, str)
    )


def definitions(tree):
    """Module-level functions and methods of module-level classes.

    Nested functions are left alone: gutting the function that holds one
    removes it anyway.
    """
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node.name, node
        elif isinstance(node, ast.ClassDef):
            for member in node.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    yield f"{node.name}.{member.name}", member


def first_line(node):
    """The line a code object reports: the first decorator's, if any."""
    return min([node.lineno, *(d.lineno for d in node.decorator_list)])


def body_span(node):
    """The lines a gut replaces: the body after any docstring."""
    body = node.body[1:] if is_docstring(node.body[0]) else node.body
    if not body:
        return None
    return body[0].lineno, body[-1].end_lineno, body[0].col_offset


def package_files(checkout, package):
    root = os.path.join(checkout, package)
    for directory, subdirectories, files in os.walk(root):
        subdirectories[:] = sorted(
            d for d in subdirectories if d not in ("tests", "__pycache__")
        )
        for name in sorted(files):
            if name.endswith(".py"):
                yield os.path.relpath(os.path.join(directory, name), checkout)


def candidates(checkout, package, traced, min_lines):
    """Every definition the tests call, and importing the package does not,
    whose body is worth re-writing."""
    covered, at_import = traced["covered"], traced["import"]
    found = []
    for path in package_files(checkout, package):
        with open(os.path.join(checkout, path), encoding="utf-8") as handle:
            source = handle.read()
        tree = ast.parse(source)
        lines = set(covered.get(path, [])) - set(at_import.get(path, []))
        for qualname, node in definitions(tree):
            span = body_span(node)
            if span is None or first_line(node) not in lines:
                continue
            start, end, _ = span
            if node.lineno == start or end - start + 1 < min_lines:
                continue
            calls = {
                n.id if isinstance(n, ast.Name) else n.attr
                for n in ast.walk(node)
                if isinstance(n, (ast.Name, ast.Attribute))
            }
            found.append(
                {
                    "path": path,
                    "name": qualname,
                    "short": qualname.split(".")[-1],
                    "span": span,
                    "calls": calls,
                }
            )
    return found


def select(found, mode, count, seed):
    rng = random.Random(seed)
    if len(found) < count:
        raise SystemExit(f"only {len(found)} candidates, {count} asked")
    if mode == "spread":
        by_module = {}
        for item in found:
            by_module.setdefault(item["path"], []).append(item)
        for items in by_module.values():
            rng.shuffle(items)
        order = sorted(by_module)
        rng.shuffle(order)
        chosen = []
        while len(chosen) < count:
            for path in order:
                if by_module[path] and len(chosen) < count:
                    chosen.append(by_module[path].pop())
        return chosen
    if mode == "cluster":
        by_module = {}
        for item in found:
            by_module.setdefault(item["path"], []).append(item)
        modules = [m for m, items in by_module.items() if len(items) >= count]
        if not modules:
            raise SystemExit(f"no module has {count} candidates")
        items = by_module[sorted(modules, key=lambda m: -len(by_module[m]))[0]]
        names = {item["short"] for item in items}

        def degree(item):
            return len(item["calls"] & names) + sum(
                item["short"] in other["calls"] for other in items
            )

        chosen = [max(items, key=lambda item: (degree(item), item["name"]))]
        while len(chosen) < count:
            taken = {item["name"] for item in chosen}
            chosen_shorts = {item["short"] for item in chosen}
            rest = [item for item in items if item["name"] not in taken]
            linked = [
                item
                for item in rest
                if item["calls"] & chosen_shorts
                or any(item["short"] in c["calls"] for c in chosen)
            ]
            pool = linked or rest
            chosen.append(rng.choice(sorted(pool, key=lambda i: i["name"])))
        return chosen
    raise SystemExit(f"unknown mode: {mode}")


def gut(checkout, chosen):
    """The chosen bodies replaced by `raise NotImplementedError`, per file."""
    files = {}
    by_path = {}
    for item in chosen:
        by_path.setdefault(item["path"], []).append(item)
    for path, items in sorted(by_path.items()):
        with open(os.path.join(checkout, path), encoding="utf-8") as handle:
            lines = handle.read().split("\n")
        # Bottom-up, so earlier spans keep their line numbers.
        for item in sorted(items, key=lambda i: -i["span"][0]):
            start, end, column = item["span"]
            lines[start - 1 : end] = [" " * column + "raise NotImplementedError"]
        files[path] = "\n".join(lines)
    return files


PROFILER = """
import atexit, json, os, sys, threading
ROOT = os.path.realpath(os.environ["RESTORE_TRACE_ROOT"])
CHECKOUT = os.path.realpath(os.environ["RESTORE_TRACE_CHECKOUT"])
OUT = os.environ["RESTORE_TRACE_OUT"]
seen = set()
def profile(frame, event, arg):
    if event == "call":
        seen.add((frame.f_code.co_filename, frame.f_code.co_firstlineno))
sys.setprofile(profile)
threading.setprofile(profile)
def dump():
    sys.setprofile(None)
    threading.setprofile(None)
    covered = {}
    for filename, line in list(seen):
        real = os.path.realpath(filename)
        if real.startswith(ROOT + os.sep):
            covered.setdefault(os.path.relpath(real, CHECKOUT), []).append(line)
    with open(OUT, "w") as handle:
        json.dump({key: sorted(value) for key, value in covered.items()}, handle)
atexit.register(dump)
"""


def profiled(checkout, package, command, what):
    """Runs `command` with every call into the package recorded."""
    scratch = tempfile.mkdtemp()
    with open(os.path.join(scratch, "restore_trace.py"), "w") as handle:
        handle.write(PROFILER)
    out = os.path.join(scratch, "trace.json")
    env = dict(
        os.environ,
        PYTHONPATH=os.pathsep.join([scratch, checkout]),
        PYTHONDONTWRITEBYTECODE="1",
        RESTORE_TRACE_ROOT=os.path.join(checkout, package),
        RESTORE_TRACE_CHECKOUT=checkout,
        RESTORE_TRACE_OUT=out,
    )
    ran = subprocess.run(
        command, cwd=checkout, env=env, capture_output=True, text=True
    )
    if ran.returncode != 0:
        raise SystemExit(f"{what} fails:\n{(ran.stdout + ran.stderr)[-2000:]}")
    if not os.path.exists(out):
        raise SystemExit(f"{what} wrote no trace:\n{ran.stderr[-2000:]}")
    with open(out) as handle:
        return json.load(handle)


def trace(checkout, package, out, tests, options):
    """Records what the tests call, and what merely importing the package
    calls. A function run at import time is never gutted: gutting it breaks
    every import, so no test could run at all.
    """
    modules = [
        path[: -len(".py")].replace(os.sep, ".").removesuffix(".__init__")
        for path in package_files(checkout, package)
    ]
    imports = "\n".join(
        f"try:\n    import {module}\nexcept Exception:\n    pass"
        for module in modules
    )
    at_import = profiled(
        checkout,
        package,
        [sys.executable, "-c", f"import restore_trace\n{imports}"],
        "importing the package",
    )
    covered = profiled(
        checkout,
        package,
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
         "-p", "restore_trace", *options, *tests],
        "the pristine tests",
    )
    with open(out, "w") as handle:
        json.dump({"covered": covered, "import": at_import}, handle)


TEST_TIMEOUT_S = int(os.environ.get("RESTORE_TEST_TIMEOUT_S", "60"))

TIMEOUT = """
import signal, pytest
@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    def expire(signum, frame):
        pytest.fail("ran over %d s" % LIMIT, pytrace=False)
    previous = signal.signal(signal.SIGALRM, expire)
    signal.alarm(LIMIT)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)
"""


def grade(checkout, out, tests, options):
    """Runs the pinned tests, each under a time limit, so a body that never
    returns fails its test instead of hanging the grade."""
    scratch = tempfile.mkdtemp()
    with open(os.path.join(scratch, "restore_timeout.py"), "w") as handle:
        handle.write(f"LIMIT = {TEST_TIMEOUT_S}\n{TIMEOUT}")
    report = os.path.join(scratch, "report.xml")
    env = dict(
        os.environ,
        PYTHONDONTWRITEBYTECODE="1",
        PYTHONPATH=os.pathsep.join([checkout, scratch]),
    )
    subprocess.run(
        # One file that cannot be collected must not stop the others from
        # running, or a single broken import grades as every test failing.
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
         "-p", "restore_timeout", "--continue-on-collection-errors",
         f"--junitxml={report}", *options, *tests],
        cwd=checkout, env=env, capture_output=True, text=True, timeout=1500,
    )
    groups = {test: {"passed": 0, "total": 0, "failures": []} for test in tests}
    modules = {test[: -len(".py")].replace("/", "."): test for test in tests}
    if os.path.exists(report):
        for case in ElementTree.parse(report).getroot().iter("testcase"):
            classname = case.get("classname", "")
            group = next(
                (
                    test
                    for module, test in modules.items()
                    if classname == module or classname.startswith(module + ".")
                ),
                None,
            )
            if group is None or case.find("skipped") is not None:
                continue
            entry = groups[group]
            entry["total"] += 1
            problem = case.find("failure")
            if problem is None:
                problem = case.find("error")
            if problem is None:
                entry["passed"] += 1
            else:
                message = (problem.get("message") or "").splitlines()
                entry["failures"].append(
                    f"{case.get('name')}: {(message[0] if message else '')[:MAX_DETAIL]}"
                )
    # A test file that collected nothing is a failure of its own, not a pass.
    for entry in groups.values():
        if entry["total"] == 0:
            entry["total"] = 1
            entry["failures"].append("no test ran")
    with open(out, "w") as handle:
        json.dump({"groups": groups}, handle)


def split(tests):
    """Test paths, and the `--deselect=` options among them."""
    options = [t for t in tests if t.startswith("--deselect=")]
    return [t for t in tests if t not in options], options


def main():
    command, *args = sys.argv[1:]
    if command == "trace":
        checkout, package, out, *tests = args
        trace(os.path.abspath(checkout), package, out, *split(tests))
    elif command == "build":
        checkout, package, traced, out, mode, count, seed, min_lines = args
        with open(traced) as handle:
            found = candidates(checkout, package, json.load(handle), int(min_lines))
        chosen = select(found, mode, int(count), int(seed))
        with open(out, "w") as handle:
            json.dump(
                {
                    "candidates": len(found),
                    "functions": [
                        {"path": c["path"], "name": c["name"]} for c in chosen
                    ],
                    "files": gut(checkout, chosen),
                },
                handle,
            )
    elif command == "grade":
        checkout, out, *tests = args
        grade(os.path.abspath(checkout), out, *split(tests))
    else:
        raise SystemExit(f"unknown command: {command}")


if __name__ == "__main__":
    main()
