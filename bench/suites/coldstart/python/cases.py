"""Collects one task's hidden cases into the flat list `runner.py` reads.

    python3 cases.py <task> <source-dir> <reference-dir> <out.json>

The hidden cases are the compliance cases the reference implementation
passes. A case the reference gets wrong would make the reference unusable as
the yardstick for the agent's own tests, so it does not grade either; the
count dropped is printed.

Every case gets a `group` (the spec area it grades, one grading target each)
and a `name`. Only the cases the task statement's scope covers are kept:
Mustache's optional modules and JMESPath's benchmark entries, which carry no
expected result, are left out.
"""

import glob
import json
import os
import sys

import runner

MUSTACHE_MODULES = [
    "comments",
    "delimiters",
    "interpolation",
    "inverted",
    "partials",
    "sections",
]


def mustache(source):
    cases = []
    for module in MUSTACHE_MODULES:
        with open(os.path.join(source, "specs", f"{module}.json"), encoding="utf8") as f:
            for test in json.load(f)["tests"]:
                cases.append(
                    {
                        "group": module,
                        "name": f"{module}: {test['name']}",
                        "template": test["template"],
                        "data": test["data"],
                        "partials": test.get("partials", {}),
                        "expected": test["expected"],
                    }
                )
    return cases


def jmespath(source):
    cases = []
    for path in sorted(glob.glob(os.path.join(source, "tests", "*.json"))):
        group = os.path.splitext(os.path.basename(path))[0]
        with open(path, encoding="utf8") as f:
            for index, suite in enumerate(json.load(f)):
                for number, case in enumerate(suite["cases"]):
                    if "result" not in case and "error" not in case:
                        continue
                    cases.append(
                        {
                            "group": group,
                            "name": f"{group} {index}.{number}: {case['expression']}",
                            "given": suite["given"],
                            "expression": case["expression"],
                            **(
                                {"error": case["error"]}
                                if "error" in case
                                else {"result": case["result"]}
                            ),
                        }
                    )
    return cases


def jsonpath(source):
    with open(os.path.join(source, "cts.json"), encoding="utf8") as f:
        tests = json.load(f)["tests"]
    cases = []
    for test in tests:
        group = test["name"].split(",")[0].strip().replace(" ", "-")
        case = {
            "group": group,
            "name": test["name"],
            "selector": test["selector"],
            "document": test.get("document"),
        }
        for key in ("result", "results", "invalid_selector"):
            if key in test:
                case[key] = test[key]
        cases.append(case)
    return cases


def main():
    task, source, reference, out = sys.argv[1:5]
    cases = {"mustache": mustache, "jmespath": jmespath, "jsonpath": jsonpath}[task](
        source
    )
    failed = []
    runner.run(task, reference, cases, failed)
    hidden = [case for case in cases if case["name"] not in set(failed)]
    with open(out, "w", encoding="utf8") as f:
        json.dump(hidden, f)
    print(f"{task}: {len(hidden)} hidden cases, {len(failed)} dropped: {failed}")


if __name__ == "__main__":
    main()
