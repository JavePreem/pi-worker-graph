// A minimal, protocol-correct client for `pi --mode rpc`.
//
// RPC mode is strict JSONL with LF as the only record delimiter, so this splits
// on "\n" itself rather than using node:readline, which would also split on
// U+2028 and U+2029 — both legal inside a JSON string.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const STARTUP_PROBE_MS = 2000;

export class PiRpcClient {
  #child;
  #buffer = "";
  // stdout arrives in arbitrary chunks that can split a multi-byte character.
  // Decoding each chunk on its own would turn the halves into U+FFFD, silently
  // corrupting an event or making its line unparseable, so one decoder holds
  // the incomplete tail until the rest of the character arrives.
  #decoder = new StringDecoder("utf8");
  #waiters = new Map();
  #settledWaiters = [];
  #sequence = 0;
  #exited;

  /** Every event seen, for post-hoc inspection of a trial. */
  events = [];
  /** ui.notify calls, in order. */
  notifications = [];
  /** One entry per finished tool call. */
  toolCalls = [];
  /** Set when the process died or could not be started. */
  failure = undefined;
  // Settlement is latched rather than only signalled. `#drain` handles a whole
  // stdout chunk synchronously, so a prompt's response and the `agent_settled`
  // that follows it can both be dispatched before the caller awaiting that
  // response resumes — leaving a later `waitSettled` waiting for an event that
  // has already happened, until its timeout. Callers take a mark before
  // sending and pass it back, so a settlement in that window still counts.
  #settledCount = 0;

  /**
   * `spawnProcess` is a seam for tests, matching the adapter's own fakeable
   * subprocess boundary. Nothing else supplies it.
   */
  constructor({ args, cwd, env, spawnProcess = spawn }) {
    this.#child = spawnProcess("pi", args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    const stderrDecoder = new StringDecoder("utf8");
    this.#child.stderr.on("data", (chunk) => {
      this.stderr += stderrDecoder.write(chunk);
    });
    this.#child.stderr.on("end", () => {
      this.stderr += stderrDecoder.end();
    });
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.stdout.on("end", () => this.#finishStdout());
    // A spawn that never starts — no `pi` on PATH — emits "error" and never
    // "exit". Without this the harness dies on an unhandled event instead of
    // reporting which command could not be run.
    this.#child.on("error", (error) =>
      this.#fail(`pi could not be started: ${error.message}`),
    );
    // Writing to a child that has already gone emits EPIPE on stdin. That is a
    // dead session, not a crash, so it settles the same way.
    this.#child.stdin.on("error", (error) =>
      this.#fail(`pi stdin failed: ${error.message}`),
    );
    // "close" is the completion signal, not "exit". Node emits "exit" as soon
    // as the process ends, while its stdio streams may still be open — so
    // resolving on "exit" would let `close()` return before `#finishStdout`
    // had drained the last records, and the caller would read an incomplete
    // event list. "close" fires only once the streams are closed too.
    //
    // "exit" still records the status and settles pending commands, because a
    // dead process answers nothing further whether or not its pipes have
    // drained. "error" is the fallback for a spawn that never started.
    this.#exited = new Promise((resolve) => {
      let status = { code: null, signal: null };
      this.#child.on("exit", (code, signal) => {
        status = { code, signal };
        this.#fail(`pi exited (code ${code}, signal ${signal})`);
      });
      this.#child.on("close", (code, signal) => {
        this.#fail(`pi exited (code ${code}, signal ${signal})`);
        resolve({
          code: code ?? status.code,
          signal: signal ?? status.signal,
        });
      });
      this.#child.on("error", () => resolve(status));
    });
  }

  /**
   * Ends the stream and drains what is left.
   *
   * `#drain` only takes newline-terminated records, so a final record written
   * without a trailing newline would sit in the buffer forever. RPC mode
   * terminates every record, but a killed process can leave a partial one, and
   * a dropped final response is a trial that hangs until its timeout.
   */
  #finishStdout() {
    this.#buffer += this.#decoder.end();
    this.#drain();
    const tail = this.#buffer.trim();
    this.#buffer = "";
    if (tail.length === 0) return;
    try {
      this.#dispatch(JSON.parse(tail));
    } catch {
      // An unterminated partial record is not a protocol error worth raising.
    }
  }

  /**
   * Settles every pending command so a dead process surfaces immediately
   * rather than as a wall of timeouts, and records why for the caller.
   */
  #fail(reason) {
    if (this.failure === undefined) this.failure = reason;
    for (const [id, waiter] of this.#waiters) {
      this.#waiters.delete(id);
      waiter({ success: false, failed: true, error: reason });
    }
    for (const settle of this.#settledWaiters.splice(0)) settle("failed");
  }

  #consume(chunk) {
    this.#buffer += this.#decoder.write(chunk);
    this.#drain();
  }

  #drain() {
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.#dispatch(event);
    }
  }

  #dispatch(event) {
    if (event.type === "response") {
      const waiter = this.#waiters.get(event.id);
      if (waiter !== undefined) {
        this.#waiters.delete(event.id);
        waiter(event);
      }
      return;
    }
    if (event.type === "message_update") return; // token-level noise
    this.events.push(event);
    if (event.type === "agent_settled") {
      this.#settledCount += 1;
      for (const settle of this.#settledWaiters.splice(0)) settle("settled");
      return;
    }
    if (event.type === "tool_execution_end") {
      this.toolCalls.push({
        toolName: event.toolName,
        isError: event.isError === true,
        text: textOf(event.result),
      });
      return;
    }
    if (event.type === "extension_ui_request") {
      this.#answerDialog(event);
    }
  }

  // Dialog methods block the agent until answered, so every one is answered
  // rather than risking a trial that hangs until its timeout.
  #answerDialog(event) {
    if (event.method === "notify") {
      this.notifications.push({
        level: event.notifyType,
        message: event.message,
      });
      return;
    }
    const answer = { type: "extension_ui_response", id: event.id };
    if (event.method === "confirm") answer.confirmed = true;
    else if (event.method === "select") answer.value = event.options?.[0];
    else if (event.method === "input" || event.method === "editor")
      answer.value = "";
    else return;
    this.#child.stdin.write(`${JSON.stringify(answer)}\n`, () => {});
  }

  send(command, timeoutMs = 120_000) {
    const id = `c${this.#sequence++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(id);
        resolve({ timedOut: true });
      }, timeoutMs);
      this.#waiters.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      if (this.failure !== undefined) {
        this.#fail(this.failure);
        return;
      }
      this.#child.stdin.write(
        `${JSON.stringify({ ...command, id })}\n`,
        (error) => {
          if (error) this.#fail(`pi stdin failed: ${error.message}`);
        },
      );
    });
  }

  /**
   * A mark to pass to `waitSettled`, taken before the command that should
   * settle. Any settlement after this point counts, even one that arrives
   * before the wait is registered.
   */
  get settledMark() {
    return this.#settledCount;
  }

  /**
   * Resolves "settled", "failed" when the process died, or "timeout".
   *
   * `since` is a mark from `settledMark`; settlements already counted past it
   * resolve immediately.
   */
  waitSettled(timeoutMs, since = this.#settledCount) {
    if (this.#settledCount > since) return Promise.resolve("settled");
    if (this.failure !== undefined) return Promise.resolve("failed");
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      // The status is forwarded, not assumed: `#fail` settles these waiters
      // too, and a crash mid-prompt must not read as a completed turn.
      this.#settledWaiters.push((status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
  }

  /**
   * Sends a command and waits for the turn it starts to settle, taking the
   * mark first so the settlement cannot be missed in between.
   */
  async sendAndSettle(command, { settleMs = 900_000, responseMs } = {}) {
    const since = this.#settledCount;
    const response = await this.send(
      command,
      ...(responseMs === undefined ? [] : [responseMs]),
    );
    if (response.success !== true) return { response, outcome: "rejected" };
    return { response, outcome: await this.waitSettled(settleMs, since) };
  }

  /** Closing stdin is Pi's graceful shutdown: the runtime host is disposed. */
  async close(force = false) {
    if (force) {
      this.#child.kill("SIGKILL");
    } else {
      this.#child.stdin.end();
    }
    // The losing timer has to be cleared: an unreferenced pending timeout keeps
    // the event loop alive, so a clean shutdown would still hold the process
    // open for the full fallback.
    let timer;
    const exit = await Promise.race([
      this.#exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), 15_000);
      }),
    ]);
    clearTimeout(timer);
    if (exit.timedOut) this.#child.kill("SIGKILL");
    return exit;
  }
}

function textOf(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Starts Pi and waits until it answers, rather than sleeping a fixed interval
 * and hoping. `get_state` is the cheapest command that proves the loop is
 * reading stdin: a command sent before then is silently lost, which shows up
 * later as an inexplicably empty trial.
 */
export async function openPi(options, { timeoutMs = 60_000 } = {}) {
  const client = new PiRpcClient(options);
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    const state = await client.send({ type: "get_state" }, STARTUP_PROBE_MS);
    if (state.success === true) return client;
    // A process that died or never started will not answer a later probe
    // either, so waiting out the deadline only delays the same error.
    const dead = client.failure;
    if (dead !== undefined || Date.now() >= deadline) {
      await client.close(true);
      throw new Error(
        dead === undefined
          ? `pi did not answer within ${timeoutMs}ms (${attempt} probes): ${client.stderr.slice(-500)}`
          : `${dead}: ${client.stderr.slice(-500)}`,
      );
    }
  }
}
