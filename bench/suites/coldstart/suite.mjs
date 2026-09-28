/**
 * The cold-start suite: build a library from a specification alone, tests
 * included, in an empty checkout.
 *
 * Each task hands the agent a published specification and a public contract,
 * and nothing else: no stub, no tests. The work is graded three ways, all
 * mechanically:
 *
 * 1. Hidden acceptance cases from the specification's own compliance suite,
 *    run against the contract. They grade: the task is resolved only if every
 *    one passes, and each spec area is one target.
 * 2. The agent's tests, run against a reference implementation. A test that
 *    fails there asserts something the specification does not say.
 * 3. The agent's tests, run against mutants of the reference -- one small
 *    fault each, every one caught by the hidden cases. The share killed is how
 *    strong the tests are.
 *
 * Layers 2 and 3 are recorded beside the grade, never in it. The hidden cases
 * are the compliance cases the reference passes, so the reference is a fair
 * yardstick for the agent's tests; the few it fails are dropped and counted.
 *
 * Nothing that grades is in the checkout while the agent works. The hidden
 * cases, the reference and the mutants are written in after the session, and
 * the runner deletes the cases before it imports the code under grade.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { run, TESTBED } from "../../container.mjs";
import { resolveTier1 } from "../../grade.mjs";
import { ensureImage, imageTag } from "../polyglot/suite.mjs";

export { ensureImage };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = path.join(HERE, "python");
const ADAPTERS = path.join(HERE, "adapters");
const SELFTEST = path.join(HERE, "selftest");

export const name = "coldstart";

const SCRATCH = process.env.BENCH_SCRATCH ?? "/tmp/pi-worker-graph-bench";
const SOURCES = path.join(SCRATCH, "coldstart");

/** Every upstream repository a task draws on, pinned. */
const REPOSITORIES = {
  spec: [
    "https://github.com/mustache/spec",
    "e8ec001db7f594521e773c34866aca2b5d6b0037",
  ],
  "jmespath.test": [
    "https://github.com/jmespath/jmespath.test",
    "53abcc37901891cf4308fcd910eab287416c4609",
  ],
  "jmespath.site": [
    "https://github.com/jmespath/jmespath.site",
    "e7e6d36d7723cd212c58434ef56b64f97d170fd1",
  ],
  "jmespath.py": [
    "https://github.com/jmespath/jmespath.py",
    "2812594e69d43098ef60f81f4efc404c071b0418",
  ],
  chevron: [
    "https://github.com/noahmorrison/chevron",
    "5e1c12827b7fc3db30cb3b24cae9a7ee3092822b",
  ],
  "jsonpath-compliance-test-suite": [
    "https://github.com/jsonpath-standard/jsonpath-compliance-test-suite",
    "9d1a415a53f5dfb291bc874823892e49174e38eb",
  ],
  "python-jsonpath-rfc9535": [
    "https://github.com/jg-rp/python-jsonpath-rfc9535",
    "e5ad5a827f734fcfdab5027fa357b97ed2094555",
  ],
};

/** Documents fetched by URL, pinned by content hash. */
const DOCUMENTS = {
  "rfc9535.txt": [
    "https://www.rfc-editor.org/rfc/rfc9535.txt",
    "bfcb53387d47e3b807bdb695d0a3e136f0c515947289d9c67df354f12ae1fda5",
  ],
  "rfc9485.txt": [
    "https://www.rfc-editor.org/rfc/rfc9485.txt",
    "61e7addfe64e3b0fbff96619d067f3812aa9960cf9b87526d064c3fb3bfbe91f",
  ],
};

const MUSTACHE_MODULES = [
  "comments",
  "delimiters",
  "interpolation",
  "inverted",
  "partials",
  "sections",
];

/**
 * The tasks. `cases` is the compliance repository, `spec` what the checkout
 * starts with, as [path under TESTBED/spec, source]; a source is a file under
 * SOURCES, or a function of SOURCES for text derived from one.
 */
const TASKS = {
  mustache: {
    cases: "spec",
    spec: MUSTACHE_MODULES.map((module) => [
      `${module}.md`,
      async (root) => {
        const { overview } = JSON.parse(
          await readFile(
            path.join(root, "spec", "specs", `${module}.json`),
            "utf8",
          ),
        );
        return `# Mustache: ${module}\n\n${overview}`;
      },
    ]),
    contract: `Build a Mustache template renderer as the Python module or package \`mustache\`,
following the specification in ${TESTBED}/spec/. Its core modules are in scope:
comments, delimiters, interpolation, inverted sections, partials and sections.
Lambdas, inheritance and dynamic names are out of scope.

Public contract:
  mustache.render(template: str, data, partials: dict[str, str] | None = None) -> str

\`data\` is JSON-like: dicts, lists, strings, numbers, booleans and None.
\`partials\` maps a partial's name to its template text.
`,
  },
  jmespath: {
    cases: "jmespath.test",
    spec: [["specification.rst", "jmespath.site/docs/specification.rst"]],
    contract: `Build a JMESPath implementation as the Python module or package \`jmespath\`,
following the specification in ${TESTBED}/spec/specification.rst.

Public contract:
  jmespath.search(expression: str, data) -> the result
  Exceptions, every one a subclass of jmespath.JMESPathError:
    jmespath.ParseError            an expression that is not valid syntax
    jmespath.JMESPathTypeError     a function argument of the wrong type
    jmespath.ArityError            a function called with the wrong number of arguments
    jmespath.UnknownFunctionError  a call to a function the specification does not define
  Any other error the specification describes raises jmespath.JMESPathError or a
  subclass.

\`data\` is JSON-like: dicts, lists, strings, numbers, booleans and None.
`,
  },
  jsonpath: {
    cases: "jsonpath-compliance-test-suite",
    spec: [
      ["rfc9535.txt", "rfc9535.txt"],
      ["rfc9485.txt", "rfc9485.txt"],
    ],
    contract: `Build an RFC 9535 JSONPath implementation as the Python module or package
\`jsonpath\`, following ${TESTBED}/spec/rfc9535.txt. Its match() and search()
function extensions use I-Regexp, specified in ${TESTBED}/spec/rfc9485.txt.

Public contract:
  jsonpath.query(query: str, document) -> list
    the values of the resulting nodelist, in nodelist order
  jsonpath.JSONPathSyntaxError
    raised for any query that is not well-formed or not valid, including one
    that is not well-typed

\`document\` is JSON-like: dicts, lists, strings, numbers, booleans and None.
`,
  },
};

export const preamble = `You are working in a checkout at ${TESTBED} that holds a specification and
nothing else. Build what the task asks from scratch, in Python 3.11 with the
standard library only. pytest is available for tests; nothing can be installed.

Deliver two things:
- The implementation, importable from ${TESTBED} by the module name the task
  gives, exposing exactly the public contract it states.
- A test suite under ${TESTBED}/tests/, runnable from ${TESTBED} with:
  python3 -m pytest tests
  Tests must use only the public contract: import only the names it lists,
  never your own internal modules.

How the work is judged:
- A hidden acceptance suite derived from the specification exercises the public
  contract. The task is solved only if every hidden case passes.
- Your tests are also run against a correct reference implementation, where
  every one of them should pass, and against deliberately broken versions of
  it, where they should catch as many of the faults as they can.

The task follows.

`;

/** What fixes the task text and its grading, for the fingerprint. */
export const revision = `coldstart ${Object.values(REPOSITORIES)
  .map(([, commit]) => commit.slice(0, 12))
  .join(" ")}`;

async function sh(args, what, options) {
  const result = await run(args, options);
  if (result.code !== 0)
    throw new Error(`${what}: ${(result.stderr || result.stdout).slice(-400)}`);
  return result.stdout;
}

/** Each pinned repository and document under SOURCES, fetched once. */
async function fetchSources(root) {
  await mkdir(root, { recursive: true });
  for (const [dir, [url, commit]] of Object.entries(REPOSITORIES)) {
    const target = path.join(root, dir);
    if (!existsSync(path.join(target, ".git"))) {
      await sh(["git", "clone", "-q", url, target], `git clone ${url}`, {
        timeoutMs: 600_000,
      });
    }
    const head = (
      await sh(["git", "-C", target, "rev-parse", "HEAD"], dir)
    ).trim();
    if (head !== commit) {
      await sh(
        [
          "git",
          "-C",
          target,
          "-c",
          "advice.detachedHead=false",
          "checkout",
          "-q",
          commit,
        ],
        `${dir} cannot check out ${commit}`,
      );
    }
  }
  for (const [file, [url, sha256]] of Object.entries(DOCUMENTS)) {
    const target = path.join(root, file);
    if (!existsSync(target))
      await sh(["curl", "-sfL", url, "-o", target], `fetch ${url}`);
    const actual = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    if (actual !== sha256)
      throw new Error(`${file}: sha256 ${actual}, pinned ${sha256}`);
  }
}

/** A hash of everything that decides what a task's build contains. */
async function buildKey() {
  const hash = createHash("sha256").update(revision);
  for (const dir of [PYTHON, ADAPTERS]) {
    for (const file of (await readdir(dir))
      .filter((f) => f.endsWith(".py"))
      .sort())
      hash.update(file).update(await readFile(path.join(dir, file)));
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * Builds a task's grading material on the host, once per build key: the
 * reference behind the contract, the hidden cases it passes, and its mutants.
 */
async function buildTask(root, id, key) {
  const dir = path.join(root, "build", `${id}-${key}`);
  const done = path.join(dir, "mutants.json");
  if (existsSync(done)) return dir;
  const reference = path.join(dir, "reference");
  await sh(
    [
      "python3",
      path.join(PYTHON, "reference.py"),
      id,
      root,
      ADAPTERS,
      reference,
    ],
    `${id} reference`,
  );
  await sh(
    [
      "python3",
      path.join(PYTHON, "cases.py"),
      id,
      path.join(root, TASKS[id].cases),
      reference,
      path.join(dir, "hidden.json"),
    ],
    `${id} hidden cases`,
  );
  await sh(
    [
      "python3",
      path.join(PYTHON, "mutate.py"),
      id,
      reference,
      path.join(dir, "hidden.json"),
      done,
    ],
    `${id} mutants`,
  );
  return dir;
}

export function taskPrompt(id) {
  return TASKS[id].contract;
}

export async function loadTasks({ root = SOURCES } = {}) {
  await fetchSources(root);
  const key = await buildKey();
  const image = await imageTag();
  const tasks = [];
  for (const id of Object.keys(TASKS)) {
    const spec = [];
    for (const [file, source] of TASKS[id].spec) {
      const text =
        typeof source === "function"
          ? await source(root)
          : await readFile(path.join(root, source), "utf8");
      spec.push([file, text]);
    }
    tasks.push({
      id,
      image,
      prompt: taskPrompt(id),
      spec,
      build: await buildTask(root, id, key),
    });
  }
  return { tasks, dropped: [] };
}

/** Every file under `dir`, as paths relative to it. */
async function filesUnder(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(path.join(dir, prefix), {
    withFileTypes: true,
  })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.name === "__pycache__") continue;
    if (entry.isDirectory()) out.push(...(await filesUnder(dir, relative)));
    else out.push(relative);
  }
  return out.sort();
}

/**
 * Writes host files into the container through `container.write`, so the
 * container's root owns them: with every capability dropped, root cannot
 * write a file a `docker cp` left owned by the host user.
 */
async function writeFiles(container, entries) {
  const dirs = [
    ...new Set(entries.map(([target]) => path.posix.dirname(target))),
  ];
  const made = await container.exec(
    `mkdir -p ${dirs.map((d) => JSON.stringify(d)).join(" ")}`,
  );
  if (made.code !== 0) throw new Error(`mkdir: ${made.stderr.slice(-400)}`);
  for (const [target, text] of entries) await container.write(target, text);
}

async function hostTree(dir, targetRoot) {
  const entries = [];
  for (const relative of await filesUnder(dir))
    entries.push([
      path.posix.join(targetRoot, relative),
      await readFile(path.join(dir, relative), "utf8"),
    ]);
  return entries;
}

/** The checkout: the specification under spec/, and a baseline commit. */
export async function prepare(container, task) {
  await writeFiles(
    container,
    task.spec.map(([file, text]) => [
      path.posix.join(TESTBED, "spec", file),
      text,
    ]),
  );
  const committed = await container.exec(
    `cd ${TESTBED} && git init -q && git add -A && ` +
      "git -c user.name=bench -c user.email=bench@invalid commit -qm baseline",
  );
  if (committed.code !== 0)
    throw new Error(`baseline commit: ${committed.stderr.slice(-400)}`);
}

async function readJson(container, file) {
  const read = await container.exec(`cat ${JSON.stringify(file)}`);
  if (read.code !== 0) return undefined;
  try {
    return JSON.parse(read.stdout);
  } catch {
    return undefined;
  }
}

/** Groups as grading targets: pass only when every case in the group does. */
export function targetStates(groups) {
  return Object.fromEntries(
    Object.entries(groups).map(([group, g]) => [
      group,
      {
        state: g.passed === g.total ? "pass" : "fail",
        reason: `${g.passed}/${g.total} passed`,
        tail: g.failures.join("\n").slice(-600),
      },
    ]),
  );
}

const GRADE = "/grade";

/**
 * Layer 1 grades; layers 2 and 3 are recorded as `quality`.
 *
 * The checkout is moved aside while the agent's tests run against the
 * reference and the mutants, so a test that reaches for ${TESTBED} directly
 * cannot run against the agent's own code instead, and moved back after.
 */
export async function grade(container, task) {
  const hidden = await readFile(path.join(task.build, "hidden.json"), "utf8");
  const cases = JSON.parse(hidden);
  const targets = [...new Set(cases.map((c) => c.group))];
  await writeFiles(container, [
    [
      `${GRADE}/runner.py`,
      await readFile(path.join(PYTHON, "runner.py"), "utf8"),
    ],
    [`${GRADE}/hidden.json`, hidden],
  ]);
  const ran = await container.exec(
    `cd ${GRADE} && timeout 1800 python3 runner.py ${task.id} ${TESTBED} hidden.json l1.json --consume`,
    { timeoutMs: 1_900_000 },
  );
  const l1 = await readJson(container, `${GRADE}/l1.json`);
  if (l1 === undefined) {
    return {
      resolved: false,
      outcome: "harness",
      detail: `hidden suite did not report: ${(ran.stderr || ran.stdout).slice(-400)}`,
      states: {},
    };
  }
  const states = targetStates(l1.groups);

  await writeFiles(container, [
    [
      `${GRADE}/quality.py`,
      await readFile(path.join(PYTHON, "quality.py"), "utf8"),
    ],
    [
      `${GRADE}/mutants.json`,
      await readFile(path.join(task.build, "mutants.json"), "utf8"),
    ],
    ...(await hostTree(
      path.join(task.build, "reference"),
      `${GRADE}/reference`,
    )),
  ]);
  // One exec: every exec starts in ${TESTBED}, so none can run while it is
  // moved aside, and the move back has to follow the run in the same shell.
  // `timeout` stops only the scoring, so the move back runs either way.
  const aside = `${TESTBED}.agent`;
  await container.exec(
    `mv ${TESTBED} ${aside} && cd ${GRADE} && ` +
      `timeout 1800 python3 quality.py ${aside}/tests ${aside} ${GRADE}/reference mutants.json quality.json; ` +
      `mv ${aside} ${TESTBED}`,
    { timeoutMs: 1_900_000 },
  );
  const quality = await readJson(container, `${GRADE}/quality.json`);

  return {
    ...resolveTier1({ targets, states }),
    states,
    ...(quality === undefined ? {} : { quality }),
  };
}

/**
 * The reference behind the contract and a small correct test suite, standing
 * in for the agent in the self-test.
 */
export async function applyReference(container, task) {
  await writeFiles(container, [
    ...(await hostTree(path.join(task.build, "reference"), TESTBED)),
    [
      `${TESTBED}/tests/test_${task.id}.py`,
      await readFile(path.join(SELFTEST, `test_${task.id}.py`), "utf8"),
    ],
  ]);
  return { applied: true };
}
