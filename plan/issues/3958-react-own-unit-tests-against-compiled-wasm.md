---
id: 3958
title: "Run React's own unit tests against compiled React, replacing hand-transcribed vectors"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
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

**Every upstream test is accounted for.** 272 of 273 are admitted; the single
exclusion is one upstream itself marks `it.skip`. Of those, 264 execute and
eight are compile-quarantined by exact name. That includes async bodies, whose
`await`s are upstream's and are awaited on both sides rather than rewritten
away. It also includes tests that reach for ReactDOM, `act`, `jest.*` or a
`document`; those execute but are classified outside the compiler score when
the native oracle cannot reproduce them.

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
| admitted    | 5                      | **272** (1 is upstream's `.skip`) |
| executed    | 5                      | **264** (8 compile-quarantined)   |
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
- [x] Every upstream test that upstream does not itself `.skip` is accounted
      for as executed or compile-quarantined — including async bodies and tests
      that need unavailable infrastructure.
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
always; the full run is gated behind `DOGFOOD_REACT_UPSTREAM=1` and now enforces
`admitted >= 270`, `executed >= 264`, `scored >= 64`, `passed >= 64`. The
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

## Follow-up result (2026-08-09)

The same pinned corpus now scores **64/64** passing compiled-Wasm tests. It
admits 272/273 upstream tests and executes 264; eight are explicitly
compile-quarantined. Two generic fixes account for the move:

- the shared oracle/Wasm source now receives React's lexical production build
  constant (`__DEV__ = false`), exactly as React's Jest transform does; this
  makes nine additional original tests natively scoreable without changing
  their bodies;
- #4298 makes `Object.keys` enumerate descriptor-less dynamic properties on a
  WasmGC object, closing the final `ReactElementClone` divergence.

The other 200 admitted tests remain `harness-incompatible` because the native
oracle also lacks their Jest/renderer infrastructure. They are still executed
and counted, not filtered from the corpus.
