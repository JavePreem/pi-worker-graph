/**
 * One cell: one task, one arm, one repetition, from container to record.
 *
 * The task comes from a suite (`bench/suites/<name>/suite.mjs`), which owns
 * what a task is: its image, its prompt, how its checkout is prepared and how
 * it is graded. Everything else here is the same for every suite.
 *
 * Everything that is not the agent failing the task classes as **not
 * attempted** -- a container that will not start, a provider that will not
 * answer, a cell stopped by its own spend cap. Scoring those as losses would
 * charge an arm for the weather, and the distinction cannot be recovered later
 * from a record that says only "failed". It is therefore drawn here, at the
 * point of failure.
 */
import { createHash } from "node:crypto";

import { armConfig, PROVIDER, workerGraphConfig } from "./arms.mjs";
import {
  run as dockerCli,
  ensureImage,
  removeImage,
  startContainer,
  TESTBED,
} from "./container.mjs";
import { startEgressBroker } from "./egress.mjs";
import { evaluatePreconditions } from "./preconditions.mjs";
import { makeRecord } from "./queue.mjs";
import { openPi } from "./rpc-client.mjs";
import {
  CONTAINER_AGENT_DIR,
  CONTAINER_PATH,
  CONTAINER_PI,
  installInContainer,
  makeAgentDirectory,
} from "./toolchain.mjs";

/**
 * The package's own diagnostic for a worker subprocess that never started, one
 * of a closed allowlist it is willing to surface (`src/execution-failure.ts`).
 * Matched as a string because it crosses the tool boundary as result text.
 */
const WORKER_STARTUP_FAILURE = "Pi worker process failed to start";

/**
 * What the manifest records instead of the prompt itself: enough to prove two
 * cells were asked the same thing, short enough to read in a listing. It
 * covers every drawn task's own prompt as well as the preamble, because a
 * suite that builds its prompts from a template can reword them without the
 * preamble moving.
 */
export function promptFingerprint(suite, tasks) {
  const hash = createHash("sha256").update(
    `${suite.name}\n${suite.revision ?? ""}\n${suite.preamble}`,
  );
  for (const task of [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1)))
    hash.update(`\0${task.id}\0${task.prompt}`);
  return hash.digest("hex").slice(0, 12);
}

/**
 * Whether one `worker_graph` result is a graph in which no worker ever ran.
 *
 * The tool answers once for the whole graph, not once per node: a status line
 * per task and then every node's review as JSON (`finalText` in
 * `src/orchestrator.ts`). A substring match over that blob is therefore true
 * as soon as *one* node fails to start, which would throw away a cell where
 * the other three ran and resolved the instance. The question is per node.
 *
 * A node counts as never having run when it carries the startup diagnostic,
 * and also when it is `blocked` -- a node whose dependency failed to start is
 * never dispatched, so it has no record and no diagnostic of its own. At least
 * one node has to carry the diagnostic, or nothing here is evidence of a
 * broken harness.
 */
function noWorkerStarted(text) {
  const block =
    /<worker_graph_reports_json>([\s\S]*?)<\/worker_graph_reports_json>/.exec(
      text,
    );
  if (block === null) {
    // A result shape this harness does not know how to read, which means the
    // package moved under it. Fall back to the blunt match, but only where no
    // node reports success, so the fallback cannot discard a cell that worked.
    return text.includes(WORKER_STARTUP_FAILURE) && !/: succeeded$/m.test(text);
  }
  let reviews;
  try {
    reviews = JSON.parse(block[1]);
  } catch {
    return false;
  }
  if (!Array.isArray(reviews) || reviews.length === 0) return false;
  return (
    reviews.some((r) => r?.diagnostics === WORKER_STARTUP_FAILURE) &&
    reviews.every(
      (r) =>
        r?.diagnostics === WORKER_STARTUP_FAILURE || r?.status === "blocked",
    )
  );
}

export class NotAttempted extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = "NotAttempted";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Wait for the agent to settle, giving up if the cell crosses its spend cap.
 *
 * The runtime bounds tasks, concurrency, payload, output, context and per-task
 * runtime, but has no token or cost ceiling -- `docs/NEXT.md` defers that
 * deliberately -- so one task that will not converge can eat a whole budget
 * unnoticed. Polling session stats is the harness supplying the ceiling the
 * package does not.
 */
export async function settleWithSpendCap(
  client,
  { prompt, settleMs, capUsd, pollMs = 30_000, now = () => Date.now() },
) {
  const mark = client.settledMark;
  const deadline = now() + settleMs;
  const response = await client.send(
    { type: "prompt", message: prompt },
    120_000,
  );
  if (response?.success !== true) {
    throw new NotAttempted(
      "prompt refused",
      JSON.stringify(response)?.slice(0, 400),
    );
  }
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0)
      return { outcome: "timeout", stats: await sessionStats(client) };
    const outcome = await client.waitSettled(Math.min(pollMs, remaining), mark);
    if (outcome === "settled")
      return { outcome, stats: await sessionStats(client) };
    const stats = await sessionStats(client);
    if (capUsd !== undefined && (stats?.cost ?? 0) > capUsd) {
      return { outcome: "spend-cap", stats };
    }
  }
}

/**
 * Abort a session the cell stopped, then read its spend again.
 *
 * A worker's usage reaches the session only when its graph returns, and a
 * graph returns on abort with every node settled and its usage kept. Killed
 * instead, a worker still running at the stop is never counted: the
 * tests-first cell reported $0.93 without the audit node its timeout cut off.
 * Pi answers `abort` once the session is idle, so the wait is bounded rather
 * than assumed, and a session that does not answer keeps the spend read at
 * the stop.
 */
async function abortSession(client) {
  const response = await client.send({ type: "abort" }, 120_000);
  if (response?.success !== true) return undefined;
  return sessionStats(client);
}

async function sessionStats(client) {
  const response = await client.send({ type: "get_session_stats" }, 60_000);
  return response?.success === true ? response.data : undefined;
}

/**
 * Start Pi inside the container, on the arm's parent model, with the mode
 * enabled where the arm calls for it.
 */
async function openAgent(container, { arm, provider }) {
  const client = await openPi({
    command: "docker",
    args: [
      "exec",
      "-i",
      "-w",
      TESTBED,
      "-e",
      `PI_CODING_AGENT_DIR=${CONTAINER_AGENT_DIR}`,
      // Pi runs with no shell, so nothing here sources a profile and the PATH
      // is whatever the image declared. A worker is spawned as a bare `pi`
      // (see `installInContainer`), so an image that does not carry
      // `/usr/local/bin` would spawn none. Named rather than inherited, so the
      // environment the workers get is the one the toolchain check verified.
      "-e",
      `PATH=${CONTAINER_PATH}`,
      container.name,
      CONTAINER_PI,
      "--mode",
      "rpc",
    ],
    cwd: process.cwd(),
    env: process.env,
  });

  const model = await client.send({
    type: "set_model",
    provider,
    modelId: armConfig(arm).parent,
  });
  if (model?.success !== true) {
    await client.close(true);
    throw new NotAttempted(
      "parent model unavailable",
      JSON.stringify(model)?.slice(0, 400),
    );
  }

  if (armConfig(arm).machinery) {
    // `/swarm on` rather than `--swarm`, so a refusal is visible as a failed
    // command rather than as a session that quietly started without the tool.
    // The command's own response is the acceptance; the short settle wait is
    // only to let the turn close, and a command that never reaches the model
    // may not settle at all, so its outcome is deliberately not checked.
    const enabled = await client.sendAndSettle(
      { type: "prompt", message: "/swarm on" },
      { settleMs: 15_000 },
    );
    if (enabled.response?.success !== true) {
      await client.close(true);
      throw new NotAttempted(
        "swarm mode refused",
        JSON.stringify(enabled.response)?.slice(0, 400),
      );
    }
  }
  return client;
}

/**
 * Remove the copied credentials from the container.
 *
 * `auth.json` is real, and it is copied into an image built by someone else so
 * that Pi can authenticate. It is deleted as soon as Pi no longer needs it,
 * which is the moment the session closes, rather than left until the container
 * stops.
 */
async function scrubAgentDirectory(container) {
  if (container === undefined) return;
  await container.exec(`rm -rf ${CONTAINER_AGENT_DIR}`, { timeoutMs: 60_000 });
}

/**
 * The largest diff a record will carry.
 *
 * An agent is free to write whatever it likes into the checkout, and whatever
 * it writes lands here: in memory, in the record, and then in an append-only
 * store that keeps it for good. One cell that generates a file rather than
 * editing one would otherwise be permanent. The cap is generous against real
 * refactors -- the ProMax gold patches run to tens of kilobytes -- and
 * the overflow says what it dropped rather than ending mid-hunk in silence.
 */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * The failing targets' output, bounded and keyed by target. Empty when every
 * target passed, so a resolved cell carries none of it.
 */
function targetFailures(states = {}) {
  const failures = Object.entries(states)
    .filter(([, s]) => s.state !== "pass")
    .map(([target, s]) => [
      target,
      [s.errorTail, s.tail].filter(Boolean).join("\n---\n"),
    ])
    .filter(([, text]) => text.length > 0);
  return failures.length === 0
    ? {}
    : { targetFailures: Object.fromEntries(failures) };
}

/** What the agent left in the checkout, before any test patch is applied. */
async function captureDiff(container) {
  // `git add -N` first, so a file the agent created appears in the diff. A
  // plain `git diff` omits untracked files entirely, which would hide whole
  // new modules from the blast radius and from the judge.
  const result = await container.exec(
    `cd ${TESTBED} && git add -A -N && git diff`,
    { timeoutMs: 300_000 },
  );
  if (result.code !== 0) return "";
  const diff = Buffer.from(result.stdout, "utf8");
  if (diff.length <= MAX_DIFF_BYTES) return result.stdout;
  // Back off the cut to a character boundary while the first dropped byte is
  // a UTF-8 continuation byte, so the kept text ends in a whole character
  // rather than in a replacement char standing for half of one.
  let end = MAX_DIFF_BYTES;
  while (end > 0 && (diff[end] & 0xc0) === 0x80) end -= 1;
  const note = `[diff truncated by the harness: ${diff.length} bytes captured, ${end} kept]`;
  return `${diff.subarray(0, end).toString("utf8")}\n${note}\n`;
}

/**
 * Grade a cell, turning a grade that throws into a harness outcome recorded
 * with what the cell already spent. Left to propagate, it would end the whole
 * run and lose a cell that has been paid for -- and a suite that writes its
 * tests into a checkout the agent controlled can throw on what the agent left
 * there.
 */
async function gradeSafely(grade, container, task) {
  try {
    return await grade(container, task);
  } catch (error) {
    return {
      resolved: false,
      outcome: "harness",
      detail: String(error).slice(0, 400),
      states: {},
    };
  }
}

/** What a graded record carries beside its class and outcome. */
function gradeDetail(graded, client, startedAt) {
  return {
    targetStates: Object.fromEntries(
      Object.entries(graded.states ?? {}).map(([t, s]) => [
        t,
        `${s.state}: ${s.reason}`,
      ]),
    ),
    // What the failing targets actually said. The build's own last words were
    // captured all along and dropped here, which left a cell reporting
    // `fail: build failed` and nothing about what failed to build -- the
    // one thing that tells a task too hard for the model from an edit that
    // never compiled. Kept for failures only; a pass explains itself.
    ...targetFailures(graded.states),
    // What a suite measures beside the grade, such as how good the tests
    // the agent wrote are. Recorded, never graded.
    ...(graded.quality === undefined ? {} : { quality: graded.quality }),
    // The files `git apply` refused, when it did.
    ...(graded.conflicted?.length
      ? { conflictedFiles: graded.conflicted }
      : {}),
    // The tool's own result text carries per-task worker accounting, which
    // is what the spend split is computed from later.
    workerGraphResults: client.toolCalls
      .filter((c) => c.toolName === "worker_graph")
      .map((c) => c.text),
    wallClockMs: Date.now() - startedAt,
    ...(graded.detail === undefined ? {} : { gradeDetail: graded.detail }),
  };
}

export async function runCell({
  suite,
  task,
  cell,
  manifest,
  agentDirectorySource,
  toolchainDir,
  packageTree,
  packageVersion,
  provider = PROVIDER,
  settleMs = 3_600_000,
  capUsd,
  onEvents,
  egressAllowHost,
  deps = {},
}) {
  const {
    pull = suite.ensureImage ?? ensureImage,
    start = startContainer,
    prepare = suite.prepare,
    drop = removeImage,
    install = installInContainer,
    agentDirectory = makeAgentDirectory,
    openAgentSession = openAgent,
    settle = settleWithSpendCap,
    startBroker = startEgressBroker,
    grade = suite.grade,
    dropImage = process.env.BENCH_RMI === "1",
  } = deps;

  const startedAt = Date.now();
  // What the record carries about confinement, so a stored cell can be told
  // apart from one run with `BENCH_EGRESS=open` long after the console
  // scrolled away.
  const egress = egressAllowHost ?? "open";
  // The relay's own account of whether anything ever connected to it. It is
  // what separates confinement pointed at the wrong host from a provider that
  // was reached and refused, and every record that could be either carries it.
  const brokerLog = () =>
    broker === undefined
      ? Promise.resolve(undefined)
      : broker.logs().catch(() => undefined);
  let container;
  let agent;
  let client;
  let broker;
  let sessionClosed = false;
  try {
    let stats;
    let outcome;
    let diff = "";
    try {
      await pull(task.image);
      const name = `cell_${cell.arm}_${cell.repetition}_${task.id.replace(/[^a-z0-9]/gi, "_").slice(-30)}`;
      // Stood up before the container, so the container can be put on the
      // confined network at creation rather than moved onto it afterwards.
      if (egressAllowHost !== undefined) {
        broker = await startBroker({
          name,
          allowHost: egressAllowHost,
          exec: dockerCli,
        });
      }
      container = await start(task.image, {
        name,
        network: broker?.network,
      });
      if (prepare !== undefined) await prepare(container, task);
      agent = await agentDirectory({
        from: agentDirectorySource,
        workerGraphConfig: workerGraphConfig(cell.arm, {
          provider,
          maxGraphCostUsd: capUsd,
        }),
        packageTree,
        packageVersion,
        provider,
        model: armConfig(cell.arm).parent,
      });
      await install(container, { toolchainDir, agentDir: agent.dir });
      client = await openAgentSession(container, {
        arm: cell.arm,
        provider,
        settleMs,
      });
      // One deadline for the whole session, follow-ups included, so a refining
      // arm is held to the same limit as the arm it is compared with.
      const deadline = Date.now() + settleMs;
      ({ outcome, stats } = await settle(client, {
        prompt: `${suite.preamble}${task.prompt}${armConfig(cell.arm).guidance ?? ""}`,
        settleMs,
        capUsd,
      }));
      for (const followUp of armConfig(cell.arm).followUps ?? []) {
        if (outcome !== "settled") break;
        const remaining = deadline - Date.now();
        // A follow-up the deadline left no room for is a timeout, not a
        // settled cell: the arm's treatment was not all administered.
        ({ outcome, stats } =
          remaining > 0
            ? await settle(client, {
                prompt: followUp,
                settleMs: remaining,
                capUsd,
              })
            : { outcome: "timeout", stats });
      }
      // Before the diff, too, so the diff is what the stopped session left
      // rather than a snapshot of workers still editing.
      if (outcome !== "settled") stats = (await abortSession(client)) ?? stats;
      diff = await captureDiff(container);
      // Handed over before the session is closed, because a cell that settled
      // without spending anything is diagnosable only from its event stream
      // and the client does not outlive this function.
      //
      // Swallowed on purpose. By this line the cell has run and been paid for,
      // and anything thrown here would be caught below as a harness fault --
      // discarding the usage, the cost and the diff to report that a file
      // could not be written. A failed write loses an explanation; letting it
      // throw loses the thing being explained.
      if (onEvents !== undefined) {
        try {
          await onEvents({
            events: client.events,
            toolCalls: client.toolCalls,
            brokerLog: await brokerLog(),
          });
        } catch {}
      }

      // The agent is finished, so the credentials it needed have no further
      // purpose -- and what follows is the largest quantity of third-party
      // code the cell runs. The suite's tests are added and its build runs
      // targets out of an image nobody here built, as root. Real provider
      // credentials should not be sitting on that filesystem while it happens.
      // The client object outlives its session: the transcript it captured is
      // still read below.
      await client.close(true).catch(() => {});
      sessionClosed = true;
      // Closing the client does not stop the session. A killed `docker exec`
      // client leaves what it started running in the container -- checked
      // against a live one -- so a cell stopped mid-turn would still have Pi
      // and its workers editing the checkout while it is graded. Everything
      // but the container's own init goes, before the scrub, so nothing is
      // left holding the credentials either.
      await container.exec("kill -9 -1", { timeoutMs: 60_000 }).catch(() => {});
      // Also swallowed, and for the same reason. The `finally` scrubs again
      // and is idempotent, so a failure here costs a retry rather than the
      // measurement.
      await scrubAgentDirectory(container).catch(() => {});
    } catch (error) {
      if (error instanceof NotAttempted) throw error;
      // Anything that went wrong before the agent settled is the harness or
      // the provider, not the task.
      throw new NotAttempted("harness", String(error).slice(0, 400));
    }

    if (outcome !== "settled") {
      // A timed-out or capped cell did run and did spend, so its cost is
      // recorded; it is still not a measurement of whether the task was
      // resolvable, so it is not scored. Its diff is graded all the same: it
      // is the work the cell paid for, and the grade is what says whether the
      // stop cut off a result or only more of the same.
      const graded = await gradeSafely(grade, container, task);
      return makeRecord({
        cell,
        cellClass: "not-attempted",
        outcome,
        manifest,
        provider,
        usage: stats?.tokens,
        costUsd: stats?.cost,
        diff,
        egress,
        // A relay that never carried anything and a provider that was slow
        // both end here, and only the log tells them apart.
        brokerLog: await brokerLog(),
        detail: {
          stopped: `agent did not settle: ${outcome}`,
          resolved: graded.resolved,
          gradeOutcome: graded.outcome,
          ...gradeDetail(graded, client, startedAt),
        },
      });
    }

    // A settled turn that spent nothing did not happen. Every provider turn
    // consumes input tokens, so a reported total of zero means the agent was
    // never asked -- a session that errored inside Pi, a provider that refused
    // without saying so. Scoring that as an unresolved task charges the arm
    // for a loss it never had the chance to avoid, which is exactly the
    // distinction this file exists to draw. Absent telemetry is a different
    // thing from zero and is left alone: the runtime keeps unknown and zero
    // apart, and so does this.
    if (stats?.tokens?.total === 0) {
      return makeRecord({
        cell,
        cellClass: "not-attempted",
        outcome: "no-agent-turn",
        manifest,
        provider,
        usage: stats.tokens,
        costUsd: stats.cost,
        diff,
        egress,
        // The two causes look identical from here: a relay nothing ever
        // connected to, which is confinement pointed at the wrong host or a
        // provider needing a second one, against a relay that carried traffic
        // the provider then refused.
        brokerLog: await brokerLog(),
        detail:
          "the agent settled having spent no tokens, so no turn reached " +
          "the provider; the cell is not evidence about the task",
      });
    }

    // A session the provider ended is not evidence about the task either.
    //
    // Seen live: a solo-sol cell settled after six tool calls on a turn the
    // provider cut off with `content_filter`, and was graded as sol failing a
    // bundle it resolved on the rerun. Pi settles an errored turn like any
    // other, so only the final message's stop reason tells them apart. An
    // earlier errored turn that the agent recovered from is not this case.
    const last = client.events.findLast(
      (e) => e.type === "message_end" && e.message?.role === "assistant",
    )?.message;
    if (last?.stopReason === "error") {
      return makeRecord({
        cell,
        cellClass: "not-attempted",
        outcome: "provider-error",
        manifest,
        provider,
        usage: stats?.tokens,
        costUsd: stats?.cost,
        diff,
        egress,
        detail: `the provider ended the session: ${String(last.errorMessage ?? "no message").slice(0, 400)}`,
      });
    }

    const preconditions = evaluatePreconditions({
      arm: cell.arm,
      events: client.events,
      toolCalls: client.toolCalls,
    });

    // A graph arm whose workers never started is not evidence about the task.
    //
    // It reaches the record looking exactly like a model that declined to fan
    // out: every graph one task, nothing resolved, no diff. The two call for
    // opposite responses -- one is a finding about the prompt surface, the
    // other is a broken harness -- and only the tool's own diagnostics tell
    // them apart. `analyse` deliberately reports a degenerate cell rather than
    // dropping it, so a cell that got here by fault would be counted as a loss
    // against the arm.
    const results = client.toolCalls
      .filter((c) => c.toolName === "worker_graph")
      .map((c) => c.text ?? "");
    const startupFailures = results.filter(noWorkerStarted).length;
    if (results.length > 0 && startupFailures === results.length) {
      return makeRecord({
        cell,
        cellClass: "not-attempted",
        outcome: "workers-never-started",
        manifest,
        provider,
        usage: stats?.tokens,
        costUsd: stats?.cost,
        preconditions,
        diff,
        egress,
        detail: {
          why:
            `all ${results.length} worker_graph calls failed with ` +
            `"${WORKER_STARTUP_FAILURE}", so no worker ran and the cell says ` +
            "nothing about the task or about the model's decomposition",
          workerGraphResults: results,
        },
      });
    }

    const graded = await gradeSafely(grade, container, task);

    // A grading run that could not be performed is a harness outcome; an
    // instance the agent did not fix is a result.
    const cellClass =
      graded.outcome === "harness"
        ? "not-attempted"
        : graded.resolved
          ? "resolved"
          : "not-resolved";

    return makeRecord({
      cell,
      cellClass,
      outcome: graded.outcome,
      manifest,
      provider,
      usage: stats?.tokens,
      costUsd: stats?.cost,
      preconditions,
      diff,
      egress,
      detail: gradeDetail(graded, client, startedAt),
    });
  } catch (error) {
    if (!(error instanceof NotAttempted)) throw error;
    return makeRecord({
      cell,
      cellClass: "not-attempted",
      outcome: error.reason,
      manifest,
      provider,
      egress,
      // The broker outlives this catch -- the `finally` below is what stops
      // it -- so a harness fault that was really a confinement fault can
      // still say so.
      brokerLog: await brokerLog(),
      detail: error.detail,
    });
  } finally {
    if (!sessionClosed) await client?.close(true).catch(() => {});
    // Idempotent on purpose: the happy path already removed it, and a cell
    // that threw anywhere after the copy has not.
    await scrubAgentDirectory(container).catch(() => {});
    await agent?.dispose().catch(() => {});
    await container?.stop().catch(() => {});
    // After the container, because a network cannot be removed while
    // something is still attached to it.
    await broker?.stop().catch(() => {});
    if (dropImage) await drop(task.image).catch(() => {});
  }
}
