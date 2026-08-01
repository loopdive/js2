---
id: 3958
title: "Run React's own unit tests against compiled React, replacing hand-transcribed vectors"
status: done
sprint: current
created: 2026-08-01
updated: 2026-08-01
completed: 2026-08-01
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: test
area: dogfood
language_feature: compiler-internals
goal: dogfood
---

# Run React's own unit tests against compiled React

## Problem

`tests/dogfood/react-upstream-suite.mjs` pinned React's real source tag and
verified its immutable commit — and then ran **five hand-transcribed
"source-attributed public-API vectors"** written by the harness author. The
pin was real; the tests were not React's.

That is the failure mode the dogfood corpus exists to avoid. A harness-authored
vector proves the harness author's mental model of React, at a granularity the
author chose, on the cases the author thought to write. It cannot surface a bug
nobody anticipated, which is the entire point of compiling a real package.
`tests/dogfood/README.md` said so itself, promising to follow "the existing
Acorn/React precedent" — but only acorn actually had one, via
`acorn-official-suite.mjs` running acorn's real ~3,500-case suite.

React is harder than acorn, and that is why it had been deferred. Acorn's
`test/driver.js` is deliberately decoupled from any acorn build: hand it a
`parse` function and it runs. React's suite is welded to Jest,
`internal-test-utils`, ReactDOM and a jsdom `document`; there is no upstream
entry point that can be handed a `React` and asked to run.

## What was done

`tests/dogfood/react-upstream-extract.mjs` reads React's test **files** verbatim
from the verified commit, transpiles their JSX with the classic runtime
(`<div/>` → `React.createElement('div', null)` — exactly what React's own jest
transform does), and lifts each `it(...)` out with its enclosing `describe`
scope and `beforeEach` prelude. Test names, bodies and assertions are
upstream's; nothing is transcribed or reworded.

The pin now names React's **entire** public `packages/react/src/__tests__`
directory (18 files, 273 upstream tests) rather than two hand-picked files.

**Every upstream test runs.** 272 of 273 are compiled and executed; the single
exclusion is one upstream itself marks `it.skip`. That includes async bodies
(140 of them — over half the suite), which compile to async exports and are
awaited on both sides: their `await`s are upstream's, and rewriting them away
would silently change what the test checks. It also includes the tests that
reach for ReactDOM, `act`, `jest.*` or a `document`, which are expected to
fail — a failure that is run and counted is more honest than a test filtered
out before it runs.

Two rules keep the resulting number honest:

1. **What is guarded is the SCORE, not the corpus.** A test the NATIVE oracle
   also fails says nothing about the compiler, so it lands in
   `harness-incompatible` and sits outside the pass rate — 209 tests are there.
   The headline prints all three numbers (run / scored / infra-blocked) so
   neither can hide the other.
2. **The `expect` shim implements only the matchers the admitted tests use.** A
   test using anything outside `SUPPORTED_MATCHERS` is rejected rather than
   scored against an approximation of Jest. The same shim SOURCE is compiled
   into the Wasm module and evaluated for the native oracle, so a divergence is
   always the compiler and never a difference between two hand-written shims.

A test that breaks compilation is quarantined and reported by name, never
silently removed.

### Compilation is per upstream file, and subdivides on validation failure

This is not a packaging detail — it is what makes running the whole suite
possible at all. One invalid function makes `WebAssembly.compile` reject the
**whole** binary, so with every test in a single module one compiler bug costs
every result: at 132 tests the unit reached 537 KB, tripped #3775 in React's own
`startTransition`, and the pass count went 39 → **0**. Nothing had regressed;
nothing could run.

So each upstream file compiles as its own unit, and a unit that fails
VALIDATION is halved and retried recursively. #3775 is triggered by module
size rather than by any single test, so halving recovers everything around it —
the `ReactChildren` batch went from "29 tests lost" to 2 individually
unrunnable tests. 36 batches, 3 invalid, each reported rather than dropped.

That also corrects #3775's own diagnosis: it is **not** the missing-coercion bug
its title claims. Every minimal `if (externrefGlobal)` case validates cleanly;
it appears only past a size threshold, which points at a stale global index.

## Result

|             | before                 | after                             |
| ----------- | ---------------------- | --------------------------------- |
| test source | 5 hand-written vectors | React's own 273 upstream tests    |
| run         | 5                      | **272** (1 is upstream's `.skip`) |
| scored      | 5                      | 55                                |
| passing     | 2                      | **39**                            |

The 39 is after the two compiler fixes this work uncovered (#3959, #3960); the
suite scored 32 before them. 16 scored failures are real and stay enumerated in
the report — most of them one root cause, filed as #3961.

The pass count barely moved when the corpus went 56 → 272, because nearly
everything newly run fails NATIVELY too (it needs ReactDOM / jsdom / jest) and
is therefore not compiler evidence. Scoring the compiler against React's _full_
suite would mean supplying that infrastructure to the oracle — real work, and
deliberately not attempted here.

## Acceptance criteria

- [x] The corpus is React's own test sources at a verified commit, not
      harness-authored vectors.
- [x] Every upstream test that upstream does not itself `.skip` is RUN —
      including async bodies and the ones that need unavailable infrastructure.
- [x] Every upstream test is either scored or rejected with a recorded reason;
      `admitted + rejected == upstreamTestsSeen` is asserted.
- [x] Natively-unreproducible tests are scored in their own bucket, never as
      compiler failures.
- [x] One invalid module cannot cost the whole run: compilation is per file and
      subdivides on validation failure.
- [x] The vitest wrapper enforces a pass FLOOR (regression gate), not a target,
      so the remaining frontier stays visible.
- [x] The obsolete `react-upstream-vectors.mjs` is deleted, not left beside the
      real suite where it could be mistaken for it.

## Permanent test reference

`tests/dogfood/react-upstream-suite.test.ts` — pin/commit assertions run
always; the full run is gated behind `DOGFOOD_REACT_UPSTREAM=1` (36 compiles,
~80s) and enforces `admitted >= 270`, `scored >= 50`, `passed >= 39`. The
`admitted` floor is the one that prevents the failure mode this issue exists to
avoid: quietly filtering a test out to keep the pass rate tidy.

```bash
pnpm run dogfood:react-upstream-suite
DOGFOOD_REACT_UPSTREAM=1 pnpm exec vitest run tests/dogfood/react-upstream-suite.test.ts
```

## References

- `tests/dogfood/acorn-official-suite.mjs` — the precedent, and the contrast:
  acorn ships a build-independent driver, React does not.
- #3959, #3960 — compiler bugs this suite found and this PR fixes.
- #3961 — the dominant remaining failure cluster.
