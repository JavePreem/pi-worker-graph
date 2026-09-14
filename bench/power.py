# Sample-size calculation behind the non-inferiority margin and the budget
# cases in DESIGN.md.
#
# Simulates a bench and reports two things: how often it would correctly
# conclude non-inferiority when the arms are truly equal, and how often it
# would detect a gap when one is really there. A margin whose power is low here
# cannot be claimed at that sample size however the trial comes out — the
# design would be unable to detect equality even when equality holds.
#
# Run: python3 bench/power.py
import math
import random
import statistics as st

# Resolve rate the arms are centred on, and the spread of task difficulty
# around it. Both are placeholders until the first batch measures them.
BASE_RATE = 0.41
TASK_SPREAD = 0.25
# Spread of the task-by-arm interaction: how much the arms' relative standing
# swings from one task to the next. Does not shrink with repetitions.
INTERACTION = 0.15


def batch(tasks, reps, interaction, true_gap, rng):
    """Per-task differences in pass fraction, thinker minus swarm."""
    differences = []
    for _ in range(tasks):
        base = min(0.95, max(0.05, rng.gauss(BASE_RATE, TASK_SPREAD)))
        swing = rng.gauss(0.0, interaction)
        thinker = min(1.0, max(0.0, base + swing / 2 + true_gap / 2))
        swarm = min(1.0, max(0.0, base - swing / 2 - true_gap / 2))
        passed = lambda p: sum(rng.random() < p for _ in range(reps)) / reps
        differences.append(passed(thinker) - passed(swarm))
    return differences


def _beta_cf(a, b, x, iterations=200):
    """Continued fraction for the incomplete beta function."""
    tiny = 1e-30
    c, d = 1.0, 1.0 - (a + b) * x / (a + 1.0)
    d = 1.0 / (tiny if abs(d) < tiny else d)
    result = d
    for i in range(1, iterations + 1):
        m2 = 2 * i
        num = i * (b - i) * x / ((a + m2 - 1.0) * (a + m2))
        d = 1.0 + num * d
        c = 1.0 + num / (tiny if abs(c) < tiny else c)
        d = 1.0 / (tiny if abs(d) < tiny else d)
        result *= d * c
        num = -(a + i) * (a + b + i) * x / ((a + m2) * (a + m2 + 1.0))
        d = 1.0 + num * d
        c = 1.0 + num / (tiny if abs(c) < tiny else c)
        d = 1.0 / (tiny if abs(d) < tiny else d)
        step = d * c
        result *= step
        if abs(step - 1.0) < 1e-12:
            break
    return result


def _betainc(a, b, x):
    """Regularized incomplete beta I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    front = math.exp(
        math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
        + a * math.log(x) + b * math.log1p(-x)
    )
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _beta_cf(a, b, x) / a
    return 1.0 - front * _beta_cf(b, a, 1.0 - x) / b


def t_quantile(p, df):
    """Inverse Student's t, by bisection on its CDF."""
    cdf = lambda t: (
        1.0 - 0.5 * _betainc(df / 2.0, 0.5, df / (df + t * t))
        if t > 0
        else 0.5 * _betainc(df / 2.0, 0.5, df / (df + t * t))
    )
    low, high = -100.0, 100.0
    for _ in range(200):
        mid = (low + high) / 2.0
        if cdf(mid) < p:
            low = mid
        else:
            high = mid
    return (low + high) / 2.0


_QUANTILES: dict[int, float] = {}


def _critical(n):
    """One-sided 95% t critical value. A normal quantile undercovers here: at
    twelve tasks and one repetition the per-task difference takes three values,
    and z=1.645 measures 93.2% coverage against a nominal 95%."""
    df = n - 1
    if df not in _QUANTILES:
        _QUANTILES[df] = t_quantile(0.95, df)
    return _QUANTILES[df]


def upper_bound(differences):
    """One-sided 95% upper bound on the gap."""
    n = len(differences)
    spread = st.stdev(differences) if n > 1 else 0.0
    return st.fmean(differences) + _critical(n) * spread / math.sqrt(n)


def lower_bound(differences):
    n = len(differences)
    spread = st.stdev(differences) if n > 1 else 0.0
    return st.fmean(differences) - _critical(n) * spread / math.sqrt(n)


def repeat(tasks, reps, interaction, true_gap, sims, seed, verdict):
    rng = random.Random(seed)
    hits = sum(
        verdict(batch(tasks, reps, interaction, true_gap, rng))
        for _ in range(sims)
    )
    return hits / sims


def power_equal(tasks, reps, margin, interaction=INTERACTION, sims=4000, seed=7):
    """P(concluding non-inferiority at `margin`) when the arms are equal."""
    return repeat(tasks, reps, interaction, 0.0, sims, seed,
                  lambda d: upper_bound(d) < margin)


def power_gap(tasks, reps, true_gap, interaction=INTERACTION, sims=6000, seed=3):
    """P(concluding swarm is worse at all) when it is worse by `true_gap`."""
    return repeat(tasks, reps, interaction, true_gap, sims, seed,
                  lambda d: lower_bound(d) > 0)


def bound(tasks, reps, interaction=INTERACTION, sims=4000, seed=5):
    """Median "no worse than" the run can conclude when the arms are equal."""
    rng = random.Random(seed)
    return st.median(
        upper_bound(batch(tasks, reps, interaction, 0.0, rng))
        for _ in range(sims)
    )


# Spread of task size on a log scale, shared by every arm because they run the
# same task, and the residual spread of one arm's spend around it.
TASK_SIZE_SPREAD = 0.8
ARM_SPEND_SPREAD = 0.4


def cost_ratio_interval(tasks, true_ratio, rng):
    """95% CI on the thinker-to-swarm cost ratio, paired across tasks."""
    logs = []
    for _ in range(tasks):
        size = rng.gauss(0.0, TASK_SIZE_SPREAD)
        thinker = size + rng.gauss(0.0, ARM_SPEND_SPREAD)
        swarm = size - math.log(true_ratio) + rng.gauss(0.0, ARM_SPEND_SPREAD)
        logs.append(thinker - swarm)
    half = _critical(tasks) * st.stdev(logs) / math.sqrt(tasks)
    return math.exp(st.fmean(logs) - half), math.exp(st.fmean(logs) + half)


MARGIN_CASES = ((28, 1), (28, 3), (28, 5), (56, 3), (112, 3))
BUDGET_CASES = ((12, 1), (24, 1), (28, 1), (28, 3))


def margin_table():
    """Which non-inferiority margins are reachable. DESIGN.md, Power."""
    print("Power to conclude non-inferiority when the arms are truly equal")
    print(f"{'margin':>7}  " + "  ".join(
        f"{tasks}x{reps}".rjust(8) for tasks, reps in MARGIN_CASES))
    for margin in (0.05, 0.075, 0.10, 0.15, 0.20):
        print(f"{margin * 100:6.1f}%  " + "  ".join(
            f"{power_equal(tasks, reps, margin):8.2f}"
            for tasks, reps in MARGIN_CASES))


def budget_table():
    """What each budget case can say. DESIGN.md, Budget case."""
    print("\nDetecting a real quality gap, and the bound when the arms are equal")
    print(f"{'gap':>6}  " + "  ".join(
        f"{tasks}x{reps}".rjust(8) for tasks, reps in BUDGET_CASES))
    for gap in (0.20, 0.30, 0.40):
        print(f"{gap * 100:5.0f}%  " + "  ".join(
            f"{power_gap(tasks, reps, gap):8.2f}"
            for tasks, reps in BUDGET_CASES))
    print(" equal  " + "  ".join(
        f"{bound(tasks, reps) * 100:7.1f}p" for tasks, reps in BUDGET_CASES))


def cost_table(sims=2000, seed=2):
    """How many tasks the cost claim needs. DESIGN.md, What the saving is.

    The saving is what sets this, and it is far smaller than the 20x price gap
    between the models: the swarm arm still runs an expensive parent and an
    expensive reviewer. A small ratio needs more tasks to establish, not fewer.
    """
    print("\nTypical 95% CI on the cost ratio, by true saving and task count")
    print(f"{'true':>6}  " + "  ".join(f"{n} tasks".rjust(14) for n in (3, 6, 12, 24)))
    for ratio in (1.15, 1.5, 2.3, 5.0):
        cells = []
        for tasks in (3, 6, 12, 24):
            rng = random.Random(seed)
            lows, highs = zip(*(
                cost_ratio_interval(tasks, ratio, rng) for _ in range(sims)
            ))
            cells.append(f"{st.median(lows):.2f}-{st.median(highs):.2f}x".rjust(14))
        print(f"{ratio:5.2f}x  " + "  ".join(cells))


if __name__ == "__main__":
    margin_table()
    budget_table()
    cost_table()
