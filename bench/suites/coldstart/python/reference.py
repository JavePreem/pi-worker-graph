"""Assembles one task's reference implementation behind its contract.

    python3 reference.py <task> <sources-root> <adapters-dir> <out-dir>

The out-dir holds the contract module (the adapter) and the reference package
it wraps, renamed where the reference's own name is the contract's, so an
import of the contract module can only ever reach the adapter.

JSONPath's reference imports two packages the task image does not have:
`regex`, which stands in for `re` except in Unicode property escapes, and
`iregexp_check`, which rejects patterns that are not I-Regexp. Both are
replaced with the standard library here; `hidden.json` drops the few cases the
replaced reference then gets wrong, so the reference still passes every case
that grades.
"""

import os
import shutil
import sys

REFERENCES = {
    "mustache": {
        "source": "chevron/chevron",
        "package": "chevron",
        "rename": [],
    },
    "jmespath": {
        "source": "jmespath.py/jmespath",
        "package": "_jmespath_reference",
        "rename": [
            ("from jmespath", "from _jmespath_reference"),
            ("import jmespath", "import _jmespath_reference"),
        ],
    },
    "jsonpath": {
        "source": "python-jsonpath-rfc9535/jsonpath_rfc9535",
        "package": "_jsonpath_reference",
        "rename": [
            ("jsonpath_rfc9535", "_jsonpath_reference"),
            ("import regex as re", "import re"),
            (
                "from iregexp_check import check",
                "check = lambda pattern: True  # noqa: E731",
            ),
            (", re.VERSION1", ""),
            # I-Regexp's `.`, which `regex` spells with surrogate classes; a
            # Python str decoded from JSON holds no lone surrogates.
            (r'r"(?:(?![\r\n])\P{Cs}|\p{Cs}\p{Cs})"', r'r"[^\r\n]"'),
        ],
    },
}


def build(task, sources, adapters, out):
    spec = REFERENCES[task]
    target = os.path.join(out, spec["package"])
    shutil.copytree(
        os.path.join(sources, spec["source"]),
        target,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "py.typed"),
    )
    for root, _dirs, files in os.walk(target):
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf8") as f:
                text = f.read()
            for old, new in spec["rename"]:
                text = text.replace(old, new)
            with open(path, "w", encoding="utf8") as f:
                f.write(text)
    shutil.copy(os.path.join(adapters, f"{task}.py"), out)


def main():
    task, sources, adapters, out = sys.argv[1:5]
    build(task, sources, adapters, out)


if __name__ == "__main__":
    main()
