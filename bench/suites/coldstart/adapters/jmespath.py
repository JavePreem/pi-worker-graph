"""The JMESPath task's contract, over the reference implementation (jmespath.py)."""

from _jmespath_reference import search as _search
from _jmespath_reference.exceptions import (  # noqa: F401 - the contract
    ArityError,
    JMESPathError,
    JMESPathTypeError,
    ParseError,
    UnknownFunctionError,
)


def search(expression, data):
    return _search(expression, data)
