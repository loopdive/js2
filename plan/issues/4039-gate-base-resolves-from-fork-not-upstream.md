---
id: 4039
title: "Gates resolve their diff base from `origin/main` — which is the FORK's stale main, so they blame files the branch never touched"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
related: [4002]
---

# Gates resolve their diff base from the fork's stale main

Implements the fix for the defect filed as **#4002** (that issue records the
diagnosis and the four field confirmations; this one carries the change).

## Problem

In an agent checkout `origin` is the **fork** (`ttraenkler/js2`), not upstream
(`loopdive/js2`). The fork's `main` lags — **139 commits** when this was
written. Several gates compute "what did this branch change?" by diffing against
`origin/main`, so **every commit upstream landed since the fork last synced
looks like part of your change-set**.

Confirmed **four times across three independent agents** in one session:

- `check:oracle-ratchet` reported `getTypeAtLocation +2, ctxChecker +3` in
  `array-length-define.ts` and `unresolvable-assign.ts` — **two other agents'
  files**, in a branch that never opened either.
- `check:issue-ids:against-main` reported **6 phantom id collisions**.
- `changed-root-tests` selected **14 root test files instead of 1**. Each is a
  cold vitest process (~90–140 s of transform+collect before any assertion), so
  a ~20 s gate cost **~40 minutes** — and it failed a commit three times on
  another agent's test file with **31/31 tests passing**, the exit 1 coming from
  a reporter RPC timeout under load.

**The dangerous outcome is not the noise.** It is that an agent reads "gate
blames file X", opens X — which it has never touched — and "fixes" someone
else's code to silence a phantom. The gate then goes green, so nothing catches
it.

**It is invisible to CI.** In Actions `origin` *is* upstream, so all of these
pass there. No CI check can ever detect this class; it only fires locally.

## Fix

One resolver, `resolveMainRef()` in `scripts/lib/change-scope.mjs`, used by all
three sites:

| site | gates it covers |
| --- | --- |
| `scripts/lib/change-scope.mjs` (`resolveChangeBase`) | loc-budget, oracle-ratchet, func-budget, pushraw, coercion-sites, trap-growth, done-status |
| `scripts/check-issue-ids.mjs` (2 call sites) | `--against-main`, `--against-open-prs` |
| `scripts/hooks/changed-root-tests.sh` | the pre-commit changed-root-test gate |

Detection compares **normalised remote URLs** rather than merely preferring an
`upstream` remote — plenty of checkouts have no `upstream`, and some have one
pointing at the same repo as `origin`. Normalisation folds scp-style
(`git@host:owner/repo`), `ssh://`, a trailing `.git` and trailing slashes.

Env overrides (`LOC_GATE_BASE`, `GATE_BASE`, `CHANGED_ROOT_TESTS_BASE`) still
win, so existing CI invocations and emergency overrides are untouched.

Every gate now **prints the base it used** (`base: merge-base(upstream-remote(origin-is-a-fork))`),
so a wrong base becomes visible instead of silent.

## ⚠ CI cannot regression-test this

In Actions `origin` **is** upstream, so the buggy and fixed resolvers agree
there **by construction**. A test that runs only in CI would be vacuous. The
verification below therefore builds a throwaway fork-shaped repo.

### The first lab was vacuous — worth recording

Branching the test repo from the **fork's** main produced *identical* output
from both arms: `merge-base` is naturally robust in that shape. The bug only
appears when the branch is cut from **upstream/main**, which is the actual
workflow (agents are told to branch from `upstream/main`). Rebuilt that way it
reproduces exactly:

```
origin/main..upstream/main = 3 commits of divergence

BUGGY (origin/main base) — files this branch is blamed for:
    mine.ts  u1.ts  u2.ts  u3.ts     <- three it never touched
FIXED (upstream/main base):
    mine.ts
```

### Resolver verified in three states

| state | resolves to | |
| --- | --- | --- |
| `upstream` remote present, differs from `origin`, ref fetched | `upstream/main` | ✓ |
| no `upstream` remote | `origin/main` | ✓ fallback |
| `upstream` remote exists but its ref is not fetched | `origin/main` | ✓ safe fallback |

The third was hit by accident and is the important one: removing a remote
deletes its `refs/remotes/*`, and the `rev-parse --verify` guard makes the
resolver degrade rather than error.

### Against the real repo, with NO env override

Both of these previously false-failed here:

```
[oracle-ratchet] OK — no net checker-usage growth across 0 changed src/codegen file(s)
                 (getTypeAtLocation +0, ctx.checker +0;
                  base: merge-base(upstream-remote(origin-is-a-fork)))
LOC budget gate: OK — no unallowed growth in 0 changed src file(s)
                 (base: merge-base(upstream-remote(origin-is-a-fork)), net +0 LOC)
```

## Note on the env-var names

`LOC_GATE_BASE` reads as "the LOC gate's base" but silently controls the oracle
ratchet and the function budget too. An agent staring at an oracle-ratchet
failure has no reason to reach for a variable named after a different gate —
one reason this kept recurring even for agents who knew #4002 existed. The
names are kept for compatibility; the fix removes the need to know them.
