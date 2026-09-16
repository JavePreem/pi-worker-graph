#!/usr/bin/env python3
"""Derives each ProMax instance's fail-to-pass target set, which the dataset
does not ship.

Per instance: pull, apply `test_patch`, climb from each changed test file to the
nearest BUILD.bazel declaring a test rule, run every rule before the gold patch
and after, and keep the ones that flip fail->pass. An instance yielding no such
target cannot be graded and is dropped. No agent, no provider spend.

Resumable. Results accumulate in bench/validate-results.json, and an instance
already recorded there is skipped, so the sweep can be run a couple of
instances at a time -- which on a small host it has to be. Named instance ids
are validated in the order given; with no arguments the whole TypeScript subset
is swept, minus what is already recorded.

Dataset pages are fetched to $BENCH_SCRATCH on first use; see DESIGN.md
"Measured".
"""
import json, os, re, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.environ.get("BENCH_SCRATCH", "/tmp/pi-worker-graph-bench")
RESULTS = os.environ.get("BENCH_RESULTS", f"{HERE}/validate-results.json")
LANGUAGE = os.environ.get("BENCH_LANGUAGE", "typescript")
MEM_LIMIT = os.environ.get("BENCH_MEM", "6g")
CPU_LIMIT = os.environ.get("BENCH_CPUS", "4")
MIN_FREE_KB = int(os.environ.get("BENCH_MIN_FREE_GB", "5")) * 1024 * 1024
HEADROOM_WAIT_S = int(os.environ.get("BENCH_HEADROOM_WAIT_S", "300"))
BAZEL_FLAGS = "--jobs=3 --local_ram_resources=3072"
ROWS_URL = ("https://datasets-server.huggingface.co/rows"
            "?dataset=swe-bench-promax/SWE-Bench-ProMax"
            "&config=default&split=test&offset=%d&length=100")
IDS = sys.argv[1:]


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def mem_available_kb():
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable:"):
            return int(line.split()[1])
    return None


def await_headroom(label):
    """Wait until the host has memory again before pulling the next image.

    Four runs on this 13 GB box were killed for host memory, always during the
    pull and never during the grading. Why is not settled. Page cache from
    unpacking ~14 GB is the suspect, but the six-instance sweep that first
    completed did so without this wait ever engaging, so nothing here is shown
    to be the cure. It is cheap insurance against a documented failure: it
    touches nothing, and when the memory does not come back it says so and
    proceeds rather than becoming a stall of its own.
    """
    deadline = time.time() + HEADROOM_WAIT_S
    while True:
        available = mem_available_kb()
        if available is None or available >= MIN_FREE_KB:
            return
        if time.time() >= deadline:
            print(f"  {label}: only {available // 1024} MB available after "
                  f"{HEADROOM_WAIT_S}s; continuing anyway", flush=True)
            return
        print(f"  {label}: {available // 1024} MB available, waiting", flush=True)
        time.sleep(15)


def dex(c, script, timeout=1800):
    return sh(["docker", "exec", c, "bash", "-lc", script], timeout=timeout)


def derive(container, files):
    """Changed test file -> nearest BUILD.bazel -> the test rule inside it."""
    targets = []
    for f in files:
        d = "/".join(f.split("/")[:-1])
        while d:
            r = dex(container, f"test -f /testbed/{d}/BUILD.bazel && cat /testbed/{d}/BUILD.bazel")
            if r.returncode == 0:
                names = re.findall(r'(\w*test\w*)\(\s*name\s*=\s*"([^"]+)"', r.stdout)
                # Keep climbing when a BUILD.bazel exists but declares no test
                # rule: a test helper's own directory is a ts_library, and the
                # runnable target lives further up.
                if names:
                    for _, n in names:
                        targets.append(f"//{d}:{n}")
                    break
            d = "/".join(d.split("/")[:-1])
    # Deduplicate, keep order.
    seen, out = set(), []
    for t in targets:
        if t not in seen:
            seen.add(t); out.append(t)
    return out


def run_target(container, targets, nocache):
    flag = "--nocache_test_results" if nocache else ""
    joined = " ".join(targets)
    r = dex(container, f"cd /testbed && ./node_modules/.bin/bazelisk test {joined} {flag} {BAZEL_FLAGS} --test_output=summary 2>&1 | tail -25")
    txt = r.stdout
    m = re.search(r"Executed (\d+) out of (\d+) test", txt)
    passed = "test passes" in txt or re.search(r"\d+ tests pass", txt) is not None
    failed = "FAILED" in txt or "fails to build" in txt or "FAIL TO BUILD" in txt
    return {"executed": m.group(0) if m else None, "passed": passed, "failed": failed, "tail": txt[-600:]}


def record(rec):
    """Append and persist. A run is hours long: an outcome that is only in
    memory is an outcome a crash costs, and a resumed run would redo it."""
    results.append(rec)
    json.dump(results, open(RESULTS, "w"), indent=2)


def page(n):
    """The dataset rows API caps a page at 100 rows; 170 instances is two."""
    path = f"{SCRATCH}/full{n + 1}.json"
    if not os.path.exists(path):
        os.makedirs(SCRATCH, exist_ok=True)
        with urllib.request.urlopen(ROWS_URL % (n * 100), timeout=120) as r:
            open(path, "wb").write(r.read())
        print(f"fetched {path}", flush=True)
    return json.load(open(path))["rows"]


rows = page(0) + page(1)
by_id = {r["row"]["instance_id"]: r["row"] for r in rows}

# Resume: everything already recorded is kept and skipped. Without this a
# second invocation would replace the file with only its own instances, and
# on a host that can manage two at a time that loses the whole sweep.
results = json.load(open(RESULTS)) if os.path.exists(RESULTS) else []
done = {r["instance_id"] for r in results}

if not IDS:
    IDS = [i for i, r in by_id.items() if r["language"].lower() == LANGUAGE]
pending = [i for i in IDS if i not in done]
print(f"{len(done)} recorded, {len(pending)} to validate -> {RESULTS}", flush=True)

for iid in pending:
    inst = by_id[iid]
    print(f"\n{'='*70}\n{iid}", flush=True)
    await_headroom(iid)
    t0 = time.time()
    rec = {"instance_id": iid}

    p = sh(["docker", "pull", inst["image_name"]], timeout=2400)
    rec["pull_s"] = round(time.time() - t0)
    if p.returncode != 0:
        rec["outcome"] = "PULL FAILED"; rec["detail"] = p.stderr[-300:]
        record(rec); print(rec["outcome"], flush=True); continue
    print(f"  pulled in {rec['pull_s']}s", flush=True)

    c = f"val_{abs(hash(iid))%10000}"
    sh(["docker", "rm", "-f", c])
    # Bazel sizes its own parallelism from the host and will take every core
    # and most of the RAM, which killed a 25-instance run outright. Grading is
    # not the slow part -- the image pull is -- so capping it costs little.
    sh(["docker", "run", "-d", "--memory", MEM_LIMIT, "--cpus", CPU_LIMIT,
        "--name", c, inst["image_name"], "sleep", "infinity"])
    try:
        for name, key in (("test_patch", "test_patch"), ("gold_patch", "patch")):
            open(f"{SCRATCH}/{name}.diff", "w").write(inst[key])
            sh(["docker", "cp", f"{SCRATCH}/{name}.diff", f"{c}:/tmp/{name}.diff"])

        a = dex(c, "cd /testbed && git apply /tmp/test_patch.diff")
        if a.returncode != 0:
            rec["outcome"] = "TEST_PATCH APPLY FAILED"; rec["detail"] = a.stderr[-300:]
            record(rec); print(rec["outcome"], flush=True); continue

        files = [f for f in re.findall(r"^diff --git a/(\S+)", inst["test_patch"], re.M)]
        targets = derive(c, files)
        rec["files"] = files
        rec["targets"] = targets
        print(f"  derived: {targets}", flush=True)
        if not targets:
            rec["outcome"] = "NO TARGET DERIVED"
            record(rec); print(rec["outcome"], flush=True); continue

        # Per target, not aggregated: the fail-to-pass set is what the dataset
        # does not ship, and an aggregate hides a target that passed all along.
        before = {t: run_target(c, [t], nocache=True) for t in targets}
        rec["before"] = {t: ("pass" if v["passed"] and not v["failed"] else "fail") for t, v in before.items()}
        print(f"  before: {rec['before']}", flush=True)

        g = dex(c, "cd /testbed && git apply /tmp/gold_patch.diff")
        if g.returncode != 0:
            rec["outcome"] = "GOLD_PATCH APPLY FAILED"; rec["detail"] = g.stderr[-300:]
            record(rec); print(rec["outcome"], flush=True); continue

        after = {t: run_target(c, [t], nocache=True) for t in targets}
        rec["after"] = {t: ("pass" if v["passed"] and not v["failed"] else "fail") for t, v in after.items()}
        print(f"  after:  {rec['after']}", flush=True)

        f2p = [t for t in targets if rec["before"][t] == "fail" and rec["after"][t] == "pass"]
        regressed = [t for t in targets if rec["before"][t] == "pass" and rec["after"][t] == "fail"]
        rec["fail_to_pass"] = f2p
        rec["regressed"] = regressed
        rec["outcome"] = ("OK f2p=%d" % len(f2p)) if f2p and not regressed else (
            "REGRESSION" if regressed else "NO FAIL-TO-PASS TARGET")
        print(f"  => {rec['outcome']}  f2p={f2p}", flush=True)
    finally:
        sh(["docker", "rm", "-f", c])
        # Pulling 25 of these decompresses ~17 layers each and was enough to
        # exhaust a 13 GB host. Dropping the image between instances keeps the
        # footprint to one at a time, at the cost of re-pulling on a rerun.
        # A `docker image prune` was tried alongside this and removed: it
        # reclaimed 0B every time, because `rmi` on a tagged image with no
        # other references already drops its layers, and a prune is free to
        # take another project's dangling layers on a shared box.
        if os.environ.get("BENCH_RMI") == "1":
            sh(["docker", "rmi", "-f", inst["image_name"]])
    rec["total_s"] = round(time.time() - t0)
    # Written per instance: a run is hours long and a crash must not cost all
    # of it, and a resumed run reads this to skip what is already validated.
    record(rec)
print(f"\n\n{'='*70}\nSUMMARY")
for r in results:
    print(f"  {r['instance_id']:32} {r.get('outcome'):24} {r.get('total_s','?')}s  targets={len(r.get('targets') or [])} f2p={len(r.get('fail_to_pass') or [])}")
