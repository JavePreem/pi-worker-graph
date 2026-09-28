"""The Mustache task's contract, over the reference implementation (chevron)."""

import chevron

_NO_PARTIAL_FILES = "/nonexistent-partials"


def render(template, data, partials=None):
    return chevron.render(
        template,
        data,
        partials_path=_NO_PARTIAL_FILES,
        partials_dict=dict(partials or {}),
    )
