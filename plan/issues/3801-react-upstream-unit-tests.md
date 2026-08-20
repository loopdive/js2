---
id: 3801
title: "Run React's own upstream unit tests against compiled React, and make them pass"
status: ready
created: 2026-07-31
priority: high
horizon: xl
feasibility: hard
task_type: feature
area: dogfood
goal: compilable
sprint: current
related: [1033, 1576, 3835, 3843, 3840]
---

# #3801 — dogfood React with React's OWN test suite

## Why

We currently validate compiled React with **vectors we wrote ourselves**
(#3835 added upstream API vectors; #3843 fixed element APIs; #3840 bound host
data bridges). Self-authored vectors share the author's blind spots: they assert
what we already believed worked. React's own unit tests were written by people
who knew where React is fragile, and they encode behaviour we would never think
to check.

This is the same argument as the test262 de-inflation (#3603): a suite we
control can silently drift toward vacuity, and only an **external, adversarial**
suite tells us where we actually are.

## Scope

Take the unit tests from the upstream repository (`facebook/react`, matching the
React version already vendored for the dogfood harness — pin the exact tag) and
run them against **React compiled by js2wasm**, not against stock React.

Out of scope for this issue: making all of them pass. The deliverable is an
honest, running, **non-vacuous** harness plus a measured baseline. Fixes follow
as child issues.

## The vacuity trap — read before reporting any number

React's tests use Jest (`expect`, `jest.mock`, `act`, custom matchers, snapshot
serializers). Every one of those is a place a test can **appear** to pass while
asserting nothing:

- a test whose `expect` never executes because setup threw and was swallowed
- a suite that reports 0 tests but exits 0
- a snapshot that silently writes a NEW snapshot instead of comparing
- an `act()` wrapper that no-ops so effects never flush

Before any pass count is quoted, prove the harness can **fail**: deliberately
break an assertion and confirm the run goes red. Report `passed / attempted /
total-discovered` with all three denominators, never a bare percentage. See
`reference_verifyproperty_vacuous_both_lanes_two_root_causes` and #3592.

## Steps

1. Pin the upstream tag and vendor (or submodule) the test sources; record the
   exact commit sha in this issue.
2. Stand up a runner that resolves `react` / `react-dom` to the **js2wasm-compiled**
   build. Decide explicitly whether Jest itself runs on node (recommended first
   step — isolates "does compiled React behave" from "can we compile Jest").
3. **Prove non-vacuity** (see above) before recording anything.
4. Record the baseline: discovered / attempted / passed, plus a bucketed failure
   census by root cause, not by test name.
5. File child issues per failure cluster above a threshold.

## Acceptance

- Upstream React tests execute against compiled React, from a pinned sha.
- A deliberately-broken assertion turns the run red (non-vacuity proven, and the
  proof is committed as a permanent check per #2093).
- A committed baseline with all three denominators.
- Failure clusters filed as child issues.

## Notes

- Expect a large initial failure count. That is the point — it is a **measurement**,
  not a regression. Do not tune the harness to make the number look better.
- Coordinate with #1033 (compile React to Wasm) and #1576 (React Tier 1 survey);
  this issue is the acceptance instrument those two lack.

## Host infrastructure follow-up (2026-08-20)

The shared React host has since been expanded so the native oracle and compiled
lane resolve the production ReactDOM/client/server and test-renderer entries
against the exact pinned React peer. It also installs jsdom, JSX runtimes,
`create-react-class`, `internal-test-utils`, a DOM-backed noop renderer, web
streams, and the Node stream capability used by the Fizz lanes. This removes
the previous production/dev renderer peer mismatch and lets all admitted tests
reach either the native oracle or the compiled call.

The current exact run admits and executes **272/273** tests, has zero
compile-quarantined batches, and scores **92/178** against compiled Wasm. The
remaining 94 native-oracle-incompatible tests are recorded rather than
silently omitted; they are dominated by production warning expectations,
renderer semantics, and opaque compiled component closures at the
Wasm/host boundary. Making those tests green is still open work.
