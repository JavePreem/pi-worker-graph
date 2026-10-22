# The one image every polyglot task runs in: Python with pytest, Node with the
# Jest toolchain Aider's polyglot harness uses, and git for the diff. Built
# locally by `suite.mjs`; the tag is a hash of this directory.
#
# The base is pinned by digest and pytest by version, so a rebuild grades the
# way the self-test did. git and the Python interpreter are left to bookworm's
# security updates: pinning them breaks the build as soon as a fix supersedes
# the pinned version, and neither decides a grade beyond a patch release.
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git python3 python3-pytest=7.2.1-2 \
  && rm -rf /var/lib/apt/lists/*

# At the filesystem root rather than in the checkout, so a task's /testbed
# holds its exercises and nothing else. Node resolves `/node_modules` from
# any directory below it, which is how each exercise's babel.config.js finds
# its preset.
COPY package.json package-lock.json /
RUN cd / && npm ci --no-audit --no-fund && npm cache clean --force

RUN mkdir /testbed
WORKDIR /testbed
