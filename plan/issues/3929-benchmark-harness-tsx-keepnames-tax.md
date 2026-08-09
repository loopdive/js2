---
id: 3929
title: "perf-bench: the harness runs under `npx tsx`, whose --keep-names transform taxes closure allocation ~30-118× — the published host-call column is overstated 2.3-3.6×"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: performance
sprint: current
horizon: m
es_edition: n/a
related: [3898, 3903, 1949]
---

# #3929 — the benchmark harness measures its own loader's closure tax

## Status: open — **independently reproduced three times**

## Problem

Every number on `https://js2.loopdive.com/benchmarks/performance.html` is
produced by `npx tsx benchmarks/run.ts`. `tsx` transpiles with esbuild's
**`keepNames`**, which wraps every function literal in an
`Object.defineProperty` (`__name(...)`) helper. That makes closure allocation
enormously more expensive, and the benchmark lanes do not allocate closures
equally — so the tax is **lane-selective** and distorts the comparison.

Measured by the coordinator on an identical closure-in-loop probe
(`.tmp/kn/probe.ts`, node v22.22.2):

| build | ns/iter |
| --- | --- |
| plain esbuild, node | **19.23** |
| esbuild **`--keep-names`**, node | **557.69** |
| `npx tsx` | **514.32** |

`--keep-names` alone reproduces it, so this is the **transform**, not the
loader. The #3898 agent measured the same effect on its own probe at
4.61 → 543.72 → 524.54 ns/iter (a 118× ratio on a tighter loop body), and
confirmed `hot.toString()` shows the `__name(...)` wrapper.

## The impact is lane-selective, which is what makes it a correctness problem

Re-running the strings suite bundled with the existing
`build:compiler-bundle` recipe under plain node (3 runs), against the
committed tsx run:

| lane | speedup when the tax is removed |
| --- | --- |
| `js` | 0.83–2.12× |
| `gc-native` | 0.99–1.57× |
| **`host-call`** | **2.35–4.72×** |

**The published `host-call` column is overstated by 2.3–3.6×.** Corrected
examples: `string/substring` host-call is really **30.67×** slower, not the
109.42× published; `indexOf` **10.27×**, not 35.75×.

This is a plausible partial explanation for #3903's whole subject — the
host-call lane's apparent per-crossing cliff. #3903 should re-derive its
per-crossing costs from a bundled run before attributing the remainder to the
boundary. It does **not** explain all of it (the DOM lane's 8.7–9.1× and
`matrix-multiply`'s 9× still need accounting), but it is a confound that has
to come out first.

## What is NOT affected — the gc-native headline holds

The **gc-native-vs-JS** ratio drifts at most **1.60×** between tsx and bundled
runs, which is **below the 1.8× noise floor** #3898 established empirically
from benchmarks it never semantically changed. The `js` and `gc-native` lanes
both speed up under the bundle but move *together*, so the ratio survives:

- `string/substring` still reverses (3.63× → 3.19× faster)
- `string/case-convert` stays ~100× (96.6 → 113.2×)
- `indexOf` / `includes` stay near parity

So #3898's corrected baselines stand, and the #3899 / #3900 / #3901 results
measured against them stand.

## Scope

1. Rewire the benchmark harness to run from an **esbuild bundle without
   `keepNames`** instead of `npx tsx`. Mechanically small — swap the
   `npx tsx benchmarks/run.ts` invocation for a bundle step — but it is
   **CI-facing**: it changes how `benchmark-refresh.yml` invokes the suite.
2. **Re-baseline every `host-call` number on the public page.** They are all
   wrong by 2.3–3.6× today.
3. Check whether anything else in the repo benchmarks under `tsx` and inherits
   the same tax.
4. Consider a guard: if the harness can detect it is running under a
   `keepNames` transform, it should refuse to publish rather than silently
   emit distorted numbers. Same principle as #3898's implausibility floor.

## Acceptance criteria

1. The published suite runs without the `keepNames` transform.
2. `benchmarks/results/latest.json` is regenerated from a bundled run and the
   host-call column is trustworthy.
3. `benchmark-refresh.yml` works with the new invocation.
4. The issue records the corrected host-call figures against the old ones.
5. A guard exists, or the issue documents why detection is impractical.

## Provenance and why this was escalated rather than done inline

Found by `issue-3903-host-boundary` while investigating per-crossing costs,
independently verified by `issue-3898-bench-validity` (which bundled the
harness and quantified the lane-selective tax), and reproduced a third time by
the coordinator before filing.

The #3898 agent **declined to make the change unilaterally** despite being
asked to by a peer, on the correct grounds that its brief was scoped no-PR and
that a peer's technical report does not expand an agent's remit — re-baselining
every host-call number on a public page is not a side effect of a benchmark-
validity fix. That judgement is why this is a separate, properly-scoped issue
rather than an unreviewed CI change buried in another PR.

**Note for whoever takes this**: #3898 also corrected its own earlier statement
that the host-call lane "is unaffected" — true of the LICM fix, but it read as
an endorsement of numbers that are bad for this unrelated reason. The
host-call column in that issue is now marked do-not-use.
