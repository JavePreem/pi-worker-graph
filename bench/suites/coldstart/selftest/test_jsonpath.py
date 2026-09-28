"""Stands in for an agent's tests in the self-test: contract-only and correct."""

import pytest

from jsonpath import JSONPathSyntaxError, query


def test_root_and_names():
    assert query("$", {"a": 1}) == [{"a": 1}]
    assert query("$.a", {"a": 1}) == [1]


def test_index_and_slice():
    assert query("$[-1]", [1, 2, 3]) == [3]
    assert query("$[0:3:2]", [1, 2, 3]) == [1, 3]


def test_wildcard_and_descendants():
    assert query("$.*", {"a": 1, "b": 2}) in ([1, 2], [2, 1])
    assert query("$..b", {"a": {"b": 1}}) == [1]


def test_filter_comparison():
    assert query("$[?@.n > 1].n", [{"n": 1}, {"n": 2}]) == [2]


def test_functions():
    assert query("$[?length(@) == 2]", ["ab", "c"]) == ["ab"]
    assert query('$[?match(@, "a.")]', ["ab", "b"]) == ["ab"]


def test_invalid_selector():
    with pytest.raises(JSONPathSyntaxError):
        query("$[", {})
