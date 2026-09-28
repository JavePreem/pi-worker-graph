"""Stands in for an agent's tests in the self-test: contract-only and correct."""

from mustache import render


def test_interpolation_escapes_html():
    assert render("{{x}}", {"x": "<b>"}) == "&lt;b&gt;"


def test_triple_mustache_does_not_escape():
    assert render("{{{x}}}", {"x": "<b>"}) == "<b>"


def test_section_iterates_a_list():
    assert render("{{#xs}}{{.}},{{/xs}}", {"xs": [1, 2, 3]}) == "1,2,3,"


def test_inverted_section_renders_on_empty_list():
    assert render("{{^xs}}none{{/xs}}", {"xs": []}) == "none"


def test_partial_is_rendered_in_context():
    assert render("{{>p}}", {"n": 1}, {"p": "n={{n}}"}) == "n=1"


def test_comment_is_dropped():
    assert render("a{{! note }}b", {}) == "ab"


def test_set_delimiter():
    assert render("{{=<% %>=}}<% x %>", {"x": 7}) == "7"
