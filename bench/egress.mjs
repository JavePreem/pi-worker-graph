/**
 * Confine a cell's container to one destination.
 *
 * A cell copies real provider credentials into an image built by someone else
 * and runs an agent in it as root (see DESIGN.md "What a cell exposes"). The
 * credentials are removed as soon as Pi is done, which bounds the window;
 * capabilities are dropped, which bounds what the container may do. Neither
 * bounds where it may send things.
 *
 * So the container is put on an `--internal` Docker network, which has no
 * route off the host at all, and a broker container is attached to both that
 * network and an ordinary one. The broker holds the provider's hostname as a
 * network alias, so the confined container resolves it to the broker and the
 * broker pipes the bytes to the real endpoint.
 *
 * The relay is plain TCP and never terminates TLS. The handshake is end to end
 * between Pi and the provider, against the real hostname, so the certificate
 * validates and nothing here can read the traffic -- which also means nothing
 * here needs to be trusted with it.
 *
 * The broker dials an IP rather than the hostname on purpose. It carries that
 * hostname as its own alias, so resolving the name inside the broker would
 * find the broker: the relay would connect to itself and the handshake would
 * hang. The address is therefore pinned before the alias exists.
 */

const BROKER_IMAGE = "node:22-alpine";

// One destination, not a list. Several aliases would all resolve to this one
// container, and telling their connections apart needs the relay to read the
// TLS SNI -- which is a parser standing in the path of every provider request,
// to buy a generality nothing here has asked for.
const RELAY = `
const net = require('node:net');
// Every A record, not one. A cell may run for an hour, these endpoints are
// multi-address with short TTLs, and a withdrawn address would otherwise fail
// every request for the rest of the cell. Addresses are tried in order.
const targets = process.env.TARGETS.split(',');
// Where the next connection begins looking. Advanced past an address only once
// that address has proved unreachable, so a working one is never abandoned.
let start = 0;
net
  .createServer((client) => {
    const base = start;
    let tried = 0;
    let upstream;
    // Registered once rather than per attempt: a listener per address stacks
    // up and warns past ten of them.
    client.on('error', () => upstream?.destroy());
    const dial = () => {
      const address = targets[(base + tried) % targets.length];
      const attempt = net.connect(443, address);
      upstream = attempt;
      // The guard on a retry is "never connected", not "nothing came back".
      // Once the client has been piped its handshake has been consumed, and a
      // second connection would receive nothing and hang -- which costs the
      // whole settle window rather than one request.
      let connected = false;
      attempt.on('connect', () => {
        connected = true;
        console.log('connect ' + address);
        client.pipe(attempt);
        attempt.pipe(client);
      });
      attempt.on('error', () => {
        attempt.destroy();
        if (!connected) {
          tried += 1;
          // One step, not two: later connections skip what this one found
          // dead, and this one moves on to the next address rather than past
          // it.
          start = (base + tried) % targets.length;
          if (tried < targets.length) {
            console.log('unreachable ' + address);
            dial();
            return;
          }
        }
        console.log('upstream failed ' + address);
        client.destroy();
      });
    };
    dial();
  })
  .listen(443, () => console.log('relay up -> ' + targets.join(',')));
`;

/**
 * Resolve a hostname to every address it has, on the host, before any alias
 * for it exists. Kept injectable so the tests never touch DNS.
 *
 * `lookup` rather than `resolve4`, because it is what the agent inside the
 * container would have used: it consults `/etc/hosts` and it answers for a
 * host that has only a AAAA record. Both are cases where querying DNS
 * directly would dial an address the provider is not actually reached at, or
 * refuse a cell that would have worked. IPv4 first, because a broker on a
 * network without IPv6 would otherwise spend a retry on every connection.
 */
export async function resolveHost(host, { lookup } = {}) {
  const resolver =
    lookup ??
    ((name) =>
      import("node:dns").then((d) => d.promises.lookup(name, { all: true })));
  const answers = await resolver(host);
  const list = (Array.isArray(answers) ? answers : [answers])
    .map((a) => (typeof a === "string" ? { address: a, family: 4 } : a))
    .filter((a) => a?.address)
    .sort((a, b) => (a.family ?? 4) - (b.family ?? 4))
    .map((a) => a.address);
  if (list.length === 0) throw new Error(`${host} resolved to no address`);
  return list;
}

/**
 * Stand up the network and the broker. Returns the network name to put the
 * cell's container on, and a `stop` that removes both.
 */
export async function startEgressBroker({
  name,
  allowHost,
  exec,
  lookup,
  image = BROKER_IMAGE,
  attempts,
  pauseMs,
}) {
  if (!allowHost) throw new Error("an egress broker needs a host to allow");
  const network = `${name}_net`;
  const broker = `${name}_broker`;

  const logs = async () => {
    const shown = await exec(["docker", "logs", "--tail", "50", broker], {
      timeoutMs: 30_000,
    });
    return `${shown.stdout}${shown.stderr}`.trim();
  };

  const stop = async () => {
    await exec(["docker", "rm", "-f", broker], { timeoutMs: 120_000 }).catch(
      () => {},
    );
    await exec(["docker", "network", "rm", network], {
      timeoutMs: 120_000,
    }).catch(() => {});
  };

  // Anything left by an interrupted cell would otherwise collide by name.
  await stop();
  try {
    const addresses = await resolveHost(allowHost, { lookup });
    const created = await exec([
      "docker",
      "network",
      "create",
      "--internal",
      network,
    ]);
    if (created.code !== 0)
      throw new Error(`docker network create: ${created.stderr.slice(-300)}`);

    // Started on the default network, because the broker is the one thing here
    // that does need to reach the outside.
    const started = await exec([
      "docker",
      "run",
      "-d",
      "--name",
      broker,
      "-e",
      `TARGETS=${addresses.join(",")}`,
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      image,
      "node",
      "-e",
      RELAY,
    ]);
    if (started.code !== 0)
      throw new Error(`docker run broker: ${started.stderr.slice(-300)}`);

    const attached = await exec([
      "docker",
      "network",
      "connect",
      "--alias",
      allowHost,
      network,
      broker,
    ]);
    if (attached.code !== 0)
      throw new Error(`docker network connect: ${attached.stderr.slice(-300)}`);

    // `docker run -d` exits 0 as soon as the container is created, which it
    // does whether or not the relay then binds. A relay that died leaves a
    // container nothing can connect to, and the only symptom downstream is an
    // agent that settles having spent nothing -- after a full settle window.
    // Waiting for the listener turns twenty minutes into one error.
    await waitForRelay({ broker, exec, attempts, pauseMs });

    return { network, broker, addresses, logs, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Wait until the relay is listening, or say why it is not.
 *
 * The container being up is not the question -- the relay process inside it
 * is. It announces itself on stdout once the listener is bound, so that line
 * is the readiness signal, and its absence comes back with whatever the
 * container did print instead.
 */
async function waitForRelay({ broker, exec, attempts = 40, pauseMs = 250 }) {
  let last = "";
  for (let i = 0; i < attempts; i += 1) {
    const shown = await exec(["docker", "logs", broker], { timeoutMs: 30_000 });
    last = `${shown.stdout}${shown.stderr}`;
    if (last.includes("relay up")) return;
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  throw new Error(
    `the egress relay never started listening: ${last.trim().slice(-300)}`,
  );
}
