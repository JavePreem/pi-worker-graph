"""Runs one cold-start task's hidden acceptance cases against an implementation.

    python3 runner.py <task> <impl-dir> <cases.json> <out.json> [--consume]

With --consume the cases file is deleted once read and before the
implementation is imported, so code under grade cannot read the expected
results from disk.

The implementation is imported from <impl-dir> by the task's contract module
name, exactly as the task statement names it. Every case runs under its own
alarm, so one runaway case fails that case rather than the whole grade.

The output is {"groups": {group: {"passed": n, "total": n, "failures": [...]}}}
with every failure kept, each naming the case. A failure's detail is bounded,
so the whole list is bounded by the case count: a record that kept only a few
per group hid the one bug behind most of them.

Standard library only: this runs inside the task image, which has nothing else.
"""

import json
import math
import os
import signal
import sys

CASE_SECONDS = 5


class CaseTimeout(Exception):
    pass


def _alarm(_signum, _frame):
    raise CaseTimeout()


def same(actual, expected):
    """JSON equality: numbers by value, but a boolean is never a number."""
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return math.isclose(actual, expected, rel_tol=1e-9, abs_tol=0.0)
    if isinstance(expected, list):
        return (
            isinstance(actual, (list, tuple))
            and len(actual) == len(expected)
            and all(same(a, e) for a, e in zip(actual, expected))
        )
    if isinstance(expected, dict):
        return (
            isinstance(actual, dict)
            and actual.keys() == expected.keys()
            and all(same(actual[k], expected[k]) for k in expected)
        )
    return type(actual) is type(expected) and actual == expected


def mustache_case(module, case):
    actual = module.render(case["template"], case["data"], case.get("partials"))
    return same(actual, case["expected"]), actual


JMESPATH_ERRORS = {
    "syntax": "ParseError",
    "invalid-type": "JMESPathTypeError",
    "invalid-arity": "ArityError",
    "unknown-function": "UnknownFunctionError",
    "invalid-value": "JMESPathError",
}


def jmespath_case(module, case):
    if "error" in case:
        expected = getattr(module, JMESPATH_ERRORS[case["error"]])
        try:
            actual = module.search(case["expression"], case["given"])
        except expected:
            return True, None
        except Exception as error:  # noqa: BLE001 - any other error is a miss
            return False, f"raised {type(error).__name__}"
        return False, actual
    actual = module.search(case["expression"], case["given"])
    return same(actual, case["result"]), actual


def jsonpath_case(module, case):
    if case.get("invalid_selector"):
        try:
            actual = module.query(case["selector"], case["document"])
        except module.JSONPathSyntaxError:
            return True, None
        except Exception as error:  # noqa: BLE001 - any other error is a miss
            return False, f"raised {type(error).__name__}"
        return False, actual
    actual = module.query(case["selector"], case["document"])
    wanted = case["results"] if "results" in case else [case["result"]]
    return any(same(actual, w) for w in wanted), actual


TASKS = {
    "mustache": ("mustache", mustache_case),
    "jmespath": ("jmespath", jmespath_case),
    "jsonpath": ("jsonpath", jsonpath_case),
}


def run(task, impl_dir, cases, failed=None):
    """Grades `cases`, appending every failing case's name to `failed`."""
    if failed is None:
        failed = []
    module_name, check = TASKS[task]
    sys.path.insert(0, impl_dir)
    groups = {}
    try:
        module = __import__(module_name)
    except BaseException as error:  # noqa: BLE001 - an unimportable impl fails every case
        for case in cases:
            group = groups.setdefault(
                case["group"], {"passed": 0, "total": 0, "failures": []}
            )
            group["total"] += 1
        for group in groups.values():
            group["failures"].append(f"import {module_name}: {type(error).__name__}: {error}")
        return groups
    signal.signal(signal.SIGALRM, _alarm)
    for case in cases:
        group = groups.setdefault(
            case["group"], {"passed": 0, "total": 0, "failures": []}
        )
        group["total"] += 1
        signal.alarm(CASE_SECONDS)
        try:
            ok, actual = check(module, case)
            detail = f"got {json.dumps(actual, default=repr)[:200]}"
        except CaseTimeout:
            ok, detail = False, f"timed out after {CASE_SECONDS}s"
        except BaseException as error:  # noqa: BLE001 - a crash fails the case
            ok, detail = False, f"raised {type(error).__name__}: {str(error)[:200]}"
        finally:
            signal.alarm(0)
        if ok:
            group["passed"] += 1
        else:
            failed.append(case["name"])
            group["failures"].append(f"{case['name']}: {detail}")
    return groups


def main():
    task, impl_dir, cases_path, out_path = sys.argv[1:5]
    with open(cases_path, encoding="utf8") as handle:
        cases = json.load(handle)
    if "--consume" in sys.argv[5:]:
        os.remove(cases_path)
    groups = run(task, impl_dir, cases)
    with open(out_path, "w", encoding="utf8") as handle:
        json.dump({"groups": groups}, handle)


if __name__ == "__main__":
    main()
