"""Stands in for an agent's tests in the self-test: contract-only and correct."""

import pytest

import jmespath


def test_field_and_subexpression():
    assert jmespath.search("a.b", {"a": {"b": 1}}) == 1


def test_index_and_slice():
    assert jmespath.search("[1]", [1, 2, 3]) == 2
    assert jmespath.search("[::-1]", [1, 2, 3]) == [3, 2, 1]


def test_projection_and_filter():
    data = {"xs": [{"n": 1}, {"n": 5}]}
    assert jmespath.search("xs[*].n", data) == [1, 5]
    assert jmespath.search("xs[?n > `2`].n", data) == [5]


def test_functions():
    assert jmespath.search("length(@)", [1, 2]) == 2
    assert jmespath.search("max_by(@, &n).n", [{"n": 1}, {"n": 4}]) == 4


def test_syntax_error():
    with pytest.raises(jmespath.ParseError):
        jmespath.search("a.[", {})


def test_type_error():
    with pytest.raises(jmespath.JMESPathTypeError):
        jmespath.search("abs(@)", "x")


def test_unknown_function():
    with pytest.raises(jmespath.UnknownFunctionError):
        jmespath.search("nope(@)", 1)
