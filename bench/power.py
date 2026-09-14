# Sample-size calculation behind the non-inferiority margin in DESIGN.md.
#
# Simulates a bench in which `swarm` and `thinker` are truly equal on average,
# and reports how often it would correctly conclude non-inferiority at a given
# margin. A margin whose power is low here cannot be claimed at that n, however
# the trial comes out: the design would be unable to detect equality even when
# equality holds.
#
# Run: python3 bench/power.py
import random, math, statistics as st

def bench(n, reps, sd_inter, rng):
    """Per-instance pass fractions for two truly-equal-on-average arms.
    sd_inter = SD of the instance-by-arm interaction on the probability scale."""
    diffs = []
    for _ in range(n):
        p = min(0.95, max(0.05, rng.gauss(0.41, 0.25)))   # instance difficulty
        dt = rng.gauss(0, sd_inter)
        pt = min(1.0, max(0.0, p + dt / 2))
        ps = min(1.0, max(0.0, p - dt / 2))
        ft = sum(rng.random() < pt for _ in range(reps)) / reps
        fs = sum(rng.random() < ps for _ in range(reps)) / reps
        diffs.append(ft - fs)
    return diffs

def noninferior(diffs, margin):
    n = len(diffs)
    m = st.fmean(diffs)
    sd = st.stdev(diffs) if n > 1 else 0.0
    return m + 1.645 * sd / math.sqrt(n) < margin

def power(n, reps, sd_inter, margin, sims=4000, seed=7):
    rng = random.Random(seed)
    return sum(noninferior(bench(n, reps, sd_inter, rng), margin)
               for _ in range(sims)) / sims

for sd_inter, label in ((0.0, "no instance-by-arm interaction"),
                        (0.15, "moderate interaction (sd 0.15)")):
    print(f"\nGraded outcome = per-instance pass fraction -- {label}")
    print(f"{'margin':>7}  " + "  ".join(f"n={n},R={r}".rjust(9)
          for n, r in ((28,1),(28,3),(28,5),(56,3),(112,3))))
    for margin in (0.05, 0.075, 0.10, 0.15, 0.20):
        row = [f"{power(n, r, sd_inter, margin):9.2f}"
               for n, r in ((28,1),(28,3),(28,5),(56,3),(112,3))]
        print(f"{margin*100:6.1f}%  " + "  ".join(row))
