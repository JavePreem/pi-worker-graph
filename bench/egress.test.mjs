import assert from "node:assert/strict";
import test from "node:test";

import { startEgressBroker } from "./egress.mjs";

function recorder({ fail, relayLog = "relay up -> 203.0.113.7\n" } = {}) {
  const calls = [];
  return {
    calls,
    exec: async (args) => {
      const line = args.join(" ");
      calls.push(line);
      if (line.includes("docker logs"))
        return { code: 0, stdout: relayLog, stderr: "" };
      const code = fail !== undefined && line.includes(fail) ? 1 : 0;
      return { code, stdout: "", stderr: "boom" };
    },
  };
}

const lookup = async () => ["203.0.113.7", "203.0.113.8"];

test("the network is internal and the broker holds the provider's name", async () => {
  const { exec, calls } = recorder();
  const broker = await startEgressBroker({
    name: "cell_x",
    allowHost: "provider.example",
    exec,
    lookup,
  });
  assert.equal(broker.network, "cell_x_net");
  assert.ok(
    calls.some((c) => c.includes("network create --internal cell_x_net")),
    "network was not created internal",
  );
  assert.ok(
    calls.some((c) =>
      c.includes("network connect --alias provider.example cell_x_net"),
    ),
    "the provider name was not pointed at the broker",
  );
});

test("the relay dials the address, never the name it is aliased as", async () => {
  // Resolving the name inside the broker would find the broker: it carries
  // that alias. The relay would connect to itself and the handshake would hang.
  const { exec, calls } = recorder();
  await startEgressBroker({
    name: "cell_x",
    allowHost: "provider.example",
    exec,
    lookup,
  });
  const started = calls.find((c) => c.startsWith("docker run -d"));
  assert.ok(started.includes("TARGETS=203.0.113.7,203.0.113.8"));
  assert.ok(!started.includes("provider.example"));
});

test("every address is carried, not just the first", async () => {
  // A cell may run for an hour against a multi-address endpoint with a short
  // TTL. One pinned address that is withdrawn fails every later request.
  const { exec, calls } = recorder();
  const broker = await startEgressBroker({
    name: "cell_x",
    allowHost: "provider.example",
    exec,
    lookup,
  });
  assert.deepEqual(broker.addresses, ["203.0.113.7", "203.0.113.8"]);
  const started = calls.find((c) => c.startsWith("docker run -d"));
  assert.ok(started.includes("203.0.113.8"));
});

test("a broker whose relay never binds is an error, not a silent cell", async () => {
  // `docker run -d` exits 0 whether or not the relay then starts. Downstream
  // the only symptom is an agent that settles having spent nothing, after a
  // full settle window.
  const { exec } = recorder({
    relayLog: "Error: Cannot find module 'node:net'",
  });
  await assert.rejects(
    startEgressBroker({
      name: "cell_x",
      allowHost: "provider.example",
      exec,
      lookup,
      attempts: 2,
      pauseMs: 1,
    }),
    /never started listening/,
  );
});

test("a broker that cannot be stood up leaves nothing behind", async () => {
  // Otherwise a half-made network survives and the next cell collides with it.
  const { exec, calls } = recorder({ fail: "network connect" });
  await assert.rejects(
    startEgressBroker({
      name: "cell_x",
      allowHost: "provider.example",
      exec,
      lookup,
    }),
    /docker network connect/,
  );
  const removals = calls.filter((c) => c.includes("network rm cell_x_net"));
  assert.ok(removals.length >= 2, "the network was not cleaned up on failure");
});

test("stop removes the broker before the network it is attached to", async () => {
  const { exec, calls } = recorder();
  const broker = await startEgressBroker({
    name: "cell_x",
    allowHost: "provider.example",
    exec,
    lookup,
  });
  calls.length = 0;
  await broker.stop();
  const rmBroker = calls.findIndex((c) => c.includes("rm -f cell_x_broker"));
  const rmNet = calls.findIndex((c) => c.includes("network rm cell_x_net"));
  assert.ok(rmBroker !== -1 && rmNet !== -1);
  assert.ok(rmBroker < rmNet, "a network cannot be removed while attached");
});

test("a broker with no host to allow is refused", async () => {
  const { exec } = recorder();
  await assert.rejects(
    startEgressBroker({ name: "c", exec, lookup }),
    /needs a host to allow/,
  );
});

test("every address is carried, IPv4 first", async () => {
  // A broker on a network without IPv6 would otherwise spend a retry on every
  // connection before reaching an address it can use.
  const { exec, calls } = recorder();
  const broker = await startEgressBroker({
    name: "cell_x",
    allowHost: "provider.example",
    exec,
    lookup: async () => [
      { address: "2001:db8::1", family: 6 },
      { address: "203.0.113.7", family: 4 },
      { address: "203.0.113.8", family: 4 },
    ],
  });
  assert.deepEqual(broker.addresses, [
    "203.0.113.7",
    "203.0.113.8",
    "2001:db8::1",
  ]);
  const started = calls.find((c) => c.startsWith("docker run -d"));
  assert.ok(started.includes("TARGETS=203.0.113.7,203.0.113.8,2001:db8::1"));
});

test("a host that resolves to nothing is refused rather than relayed nowhere", async () => {
  const { exec } = recorder();
  await assert.rejects(
    startEgressBroker({
      name: "cell_x",
      allowHost: "provider.example",
      exec,
      lookup: async () => [],
    }),
    /resolved to no address/,
  );
});
