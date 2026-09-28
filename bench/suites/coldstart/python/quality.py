"""Scores the tests an agent wrote: are they right, and would they catch a bug?

    python3 quality.py <tests-dir> <own-impl-dir> <reference-dir> <mutants.json> <out.json>

The agent's tests run three ways, each from a copy of the tests with only one
implementation importable:

- own: against the agent's own implementation, which says whether its suite
  even runs green on the code it was written for;
- reference: against the reference implementation, where every failing test
  asserts something the specification does not say (validity);
- mutants: against the reference with one small fault each, where a mutant is
  killed when a test that passed on the reference fails, or the run times out
  (strength).

Standard library only, apart from the pytest the task image carries.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ElementTree

RUN_SECONDS = 120
KEPT_SURVIVORS = 10


def run_tests(tests, impl, scratch):
    """Maps each test id to whether it passed, or None when the run timed out."""
    report = os.path.join(scratch, "report.xml")
    if os.path.exists(report):
        os.remove(report)
    env = {
        **os.environ,
        "PYTHONPATH": impl,
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    try:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                tests,
                "-q",
                "-p",
                "no:cacheprovider",
                # Test ids are relative to the rootdir, which pytest otherwise
                # derives from the working directory -- a different one per
                # implementation, so the same test would not match itself.
                f"--rootdir={tests}",
                f"--junitxml={report}",
            ],
            cwd=impl,
            env=env,
            timeout=RUN_SECONDS,
            capture_output=True,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None
    if not os.path.exists(report):
        return {}
    results = {}
    for case in ElementTree.parse(report).getroot().iter("testcase"):
        test_id = f"{case.get('classname')}::{case.get('name')}"
        results[test_id] = not any(
            child.tag in ("failure", "error", "skipped") for child in case
        )
    return results


def tally(results):
    if results is None:
        return {"passed": 0, "total": 0, "timedOut": True}
    return {"passed": sum(results.values()), "total": len(results)}


def main():
    tests_src, own, reference, mutants_path, out = sys.argv[1:6]
    with open(mutants_path, encoding="utf8") as f:
        mutants = json.load(f)
    with tempfile.TemporaryDirectory() as scratch:
        tests = os.path.join(scratch, "tests")
        if os.path.isdir(tests_src):
            shutil.copytree(tests_src, tests)
        else:
            os.mkdir(tests)

        own_results = run_tests(tests, own, scratch)
        ref_results = run_tests(tests, reference, scratch)
        passing = {t for t, ok in (ref_results or {}).items() if ok}

        killed = 0
        survivors = []
        for mutant in mutants:
            impl = os.path.join(scratch, "mutant")
            if os.path.exists(impl):
                shutil.rmtree(impl)
            shutil.copytree(reference, impl)
            with open(os.path.join(impl, mutant["file"]), "w", encoding="utf8") as f:
                f.write(mutant["source"])
            results = run_tests(tests, impl, scratch) if passing else {}
            if results is None or any(not results.get(t, False) for t in passing):
                killed += 1
            elif len(survivors) < KEPT_SURVIVORS:
                survivors.append(f"{mutant['file']} {mutant['site']}")

    with open(out, "w", encoding="utf8") as f:
        json.dump(
            {
                "own": tally(own_results),
                "reference": tally(ref_results),
                "mutants": {"killed": killed, "total": len(mutants)},
                "survivors": survivors,
            },
            f,
        )


if __name__ == "__main__":
    main()
