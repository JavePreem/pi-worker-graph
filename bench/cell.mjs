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
  pullImage,
  removeImage,
  startContainer,
  TESTBED,
} from "./container.mjs";
import { gradeTier1 } from "./grade.mjs";
import { evaluatePreconditions } from "./preconditions.mjs";
import { makeRecord } from "./queue.mjs";
import { openPi } from "./rpc-client.mjs";
import {
  CONTAINER_AGENT_DIR,
  CONTAINER_PI,
  installInContainer,
  makeAgentDirectory,
} from "./toolchain.mjs";

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

/** What the agent left in the checkout, before any test patch is applied. */
async function captureDiff(container) {
  // `git add -N` first, so a file the agent created appears in the diff. A
  // plain `git diff` omits untracked files entirely, which would hide whole
  // new modules from the blast radius and from the judge.
  const result = await container.exec(
    `cd ${TESTBED} && git add -A -N && git diff`,
    { timeoutMs: 300_000 },
  );
  return result.code === 0 ? result.stdout : "";
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
    grade = gradeTier1,
    dropImage = process.env.BENCH_RMI === "1",
  } = deps;

  const startedAt = Date.now();
  let container;
  let agent;
  let client;
  try {
    let stats;
    let outcome;
    let diff = "";
    try {
      await pull(instance.row.image_name);
      container = await start(instance.row.image_name, {
        name: `cell_${cell.arm}_${cell.repetition}_${instance.id.replace(/[^a-z0-9]/gi, "_").slice(-30)}`,
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
        usage: stats?.tokens,
        costUsd: stats?.cost,
        diff,
        detail: `agent did not settle: ${outcome}`,
      });
    }

    const preconditions = evaluatePreconditions({
      arm: cell.arm,
      events: client.events,
      toolCalls: client.toolCalls,
    });
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
      usage: stats?.tokens,
      costUsd: stats?.cost,
      preconditions,
      diff,
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
      detail: error.detail,
    });
  } finally {
    await client?.close(true).catch(() => {});
    await agent?.dispose().catch(() => {});
    await container?.stop().catch(() => {});
    if (dropImage) await drop(instance.row.image_name).catch(() => {});
  }
}
