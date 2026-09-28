"""The JSONPath task's contract, over the reference implementation
(python-jsonpath-rfc9535)."""

import _jsonpath_reference as _reference


class JSONPathSyntaxError(Exception):
    pass


def query(selector, document):
    try:
        return _reference.find(selector, document).values()
    except _reference.JSONPathError as error:
        raise JSONPathSyntaxError(str(error)) from None
