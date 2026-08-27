---
id: 4780
title: "perf-gate: route-c devirtualization has no floor — a 27.8x regression lived on main for 3 days"
status: ready
sprint: current
created: 2026-08-27
priority: medium
horizon: m
feasibility: medium
task_type: infrastructure
area: testing
goal: performance
related: [4775, 3754, 3685, 3683, 4157]
# (2026-08-27) Reserved with `--allow-unscanned` — no `gh` in this container, so
# `claim-issue.mjs`'s open-PR scan degrades unconditionally. The scan was run
# directly against the REST API with curl instead: the 6 open PRs on
# loopdive/js2 (#5056, #5063, #5067, #5069, #5070, #5072) add or modify issue
# files {1691, 3481, 3525, 4770, 4777, 4778}. 4780 is above all of them.
---

# #4780 — nothing gates the devirtualization perf floor

**Proposal only.** This issue records the gap and a measurement method that is
already validated; it does not build the gate.

## The gap

[#4775](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4775-numeric-return-twin-suite-red-on-main)
found a **27.8x** regression on the `method` axis — `recv.m()` on a non-`this`
fnctor receiver stopped devirtualizing entirely — that lived on `main` from
2026-08-24 to 2026-08-27 with **every required check green**. Three separate
safety nets were present and none of them fired:

| net | why it missed |
| --- | --- |
| the six required checks | none runs a perf measurement, by design |
| `tests/issue-3754-numeric-return-twin.test.ts` | correctly went red — but is in no gating lane, so nobody saw it |
| the acorn dogfood corpus | **structurally blind**: its devirtualized sites are all `this.m()` (routes a/b), which never traverse the changed code. Its census is byte-identical with and without the regression |

The third row is the one worth internalising. The census
`sites=3976 trampolines=545 twinFills=516 genericFills=29 legacyFills=0` was
quoted in #4775's own problem statement as evidence the mechanism was healthy,
and it was *true and irrelevant* — a green reading over a path the change does
not traverse (#4157 entry 22). A corpus is only evidence for the routes it
actually exercises, and no artifact says which those are.

## What a floor would need

The three admission routes into the direct-call trampoline machinery
(`tryEmitDirectTwinCall`, `src/codegen/typed-this.ts`) fail independently:

- **(a)** `this.m()` inside a typed twin — heavily exercised by acorn.
- **(b)** `this.m()` inside a pinned generic body — likewise.
- **(c)** `recv.m()` on a proven non-`this` receiver — exercised by acorn
  **not at all**, and the one that regressed.

So a per-route floor, not an aggregate one. The cheapest form is probably not a
timing gate at all but a **shape** gate: assert that a fixture of each route
still emits its `__dc_*` trampoline. That is deterministic, runs in seconds, has
no noise budget, and would have caught this exact regression — `#4775`'s suite
is already such a gate for route (c) and did catch it. Promoting the existing
`tests/issue-37*.test.ts` shape suites into a required lane may be most of the
work.

A timing floor is the stronger but costlier option, and only worth it where a
shape gate cannot express the property.

## The measurement method, if a timing floor is built

Validated during #4775; reuse it rather than re-deriving:

- **Interleave the arms in one container**, alternating A/B/A/B, min-of-5 per
  reading, three rounds. Wall-clock across containers is not comparable.
- **Carry a noise probe** — an axis the change provably cannot touch. #4775 used
  `numeric`, which stayed at 2.42–2.49 ms across all six arms while `method`
  moved 25.7 → 0.92. Without the probe, a 27x delta and a noisy container are
  not distinguishable from the numbers alone.
- **Require matching checksums** on every axis in every round. A faster arm that
  computes something else is not a faster arm.
- `benchmarks/cross-engine/run-js2.mjs` already implements all of this.

## Acceptance criteria

- A decision recorded: shape gate, timing floor, or both — with the reason.
- Whichever is chosen covers route (c) specifically, not just an aggregate.
- If a timing floor: its noise probe is named, and its threshold is justified
  against a measured spread, not guessed.
