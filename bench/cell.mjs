/**
 * One cell: one task, one arm, one repetition, from container to record.
 *
 * Everything that is not the agent failing the task classes as **not
 * attempted** -- a container that will not start, a provider that will not
 * answer, a cell stopped by its own spend cap. Scoring those as losses would
 * charge an arm for the weather, and the distinction cannot be recovered later
 * from a record that says only "failed". It is therefore drawn here, at the
 * point of failure.
 */
import { armConfig, PROVIDER, workerGraphConfig } from "./arms.mjs";
import {
  run as dockerCli,
  pullImage,
  removeImage,
  startContainer,
  TESTBED,
} from "./container.mjs";
import { startEgressBroker } from "./egress.mjs";
import { gradeTier1 } from "./grade.mjs";
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
 * refactors -- the gold patches in this pool run to tens of kilobytes -- and
 * the overflow says what it dropped rather than ending mid-hunk in silence.
 */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

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

export async function runCell({
  instance,
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
    pull = pullImage,
    start = startContainer,
    drop = removeImage,
    install = installInContainer,
    agentDirectory = makeAgentDirectory,
    openAgentSession = openAgent,
    settle = settleWithSpendCap,
    startBroker = startEgressBroker,
    grade = gradeTier1,
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
      await pull(instance.row.image_name);
      const name = `cell_${cell.arm}_${cell.repetition}_${instance.id.replace(/[^a-z0-9]/gi, "_").slice(-30)}`;
      // Stood up before the container, so the container can be put on the
      // confined network at creation rather than moved onto it afterwards.
      if (egressAllowHost !== undefined) {
        broker = await startBroker({
          name,
          allowHost: egressAllowHost,
          exec: dockerCli,
        });
      }
      container = await start(instance.row.image_name, {
        name,
        network: broker?.network,
      });
      agent = await agentDirectory({
        from: agentDirectorySource,
        workerGraphConfig: workerGraphConfig(cell.arm, { provider }),
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
      ({ outcome, stats } = await settle(client, {
        prompt: instance.row.problem_statement,
        settleMs,
        capUsd,
      }));
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
      // code the cell runs. `test_patch` is applied and Bazel builds and runs
      // targets out of an image nobody here built, as root. Real provider
      // credentials should not be sitting on that filesystem while it happens.
      // The client object outlives its session: the transcript it captured is
      // still read below.
      await client.close(true).catch(() => {});
      sessionClosed = true;
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
      // resolvable, so it is not scored.
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
        detail: `agent did not settle: ${outcome}`,
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

    const graded = await grade(container, {
      testPatch: instance.row.test_patch,
      targets: instance.targets,
      regressionTargets: instance.regressionTargets,
    });

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
      detail: {
        targetStates: Object.fromEntries(
          Object.entries(graded.states ?? {}).map(([t, s]) => [
            t,
            `${s.state}: ${s.reason}`,
          ]),
        ),
        // The tool's own result text carries per-task worker accounting, which
        // is what the spend split is computed from later.
        workerGraphResults: client.toolCalls
          .filter((c) => c.toolName === "worker_graph")
          .map((c) => c.text),
        wallClockMs: Date.now() - startedAt,
        ...(graded.detail === undefined ? {} : { gradeDetail: graded.detail }),
      },
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
    if (dropImage) await drop(instance.row.image_name).catch(() => {});
  }
}
