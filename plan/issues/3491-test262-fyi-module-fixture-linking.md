---
id: 3491
title: "Test262 FYI original-harness lane must link static _FIXTURE module graphs"
status: done
sprint: 73
created: 2026-07-20
updated: 2026-07-21
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: test262-runner
goal: test262-conformance
lane: A
related: [2932, 3370, 3473, 3489]
files:
  - scripts/test262-fyi-reader.mjs
  - scripts/run-test262-fyi.mjs
  - scripts/test262-worker.mjs
  - scripts/compiler-pool.ts
  - tests/issue-3491-test262-fyi-module-fixtures.test.ts
---

# #3491 — Test262 FYI original-harness lane must link static `_FIXTURE` module graphs

## Problem

After rebasing the FYI runner onto current main, the complete 3,472-path
standalone project-pass/FYI-fail rerun recovered 3,469 tests. Two remaining
failures are #3489. The third is a separate, deterministic multi-file module
gap:

```text
language/module-code/instn-star-props-circular.js
```

The test imports two Test262 fixture modules which re-export each other:

- `instn-star-props-circular-a_FIXTURE.js`
- `instn-star-props-circular-b_FIXTURE.js`

The standalone project runner passes this test after #2932 hoists `_FIXTURE`
imports out of its synthetic test-function wrapper and compiles the fixture
graph. The FYI lane already receives the unmodified imports at Module top
level, but it sends only the assembled entry source through its source
executor. The dependency graph is not represented equivalently, so the
literal lane fails during module initialization instead of testing the
namespace cycle.

At the time this issue was implemented, the current `gc` project runner had a
separate multi-source initialization frontier: its graph-linked compile reached
the harness but trapped `unreachable`. #3493 subsequently preserved the
cross-module setup and filled the reserved multi-source member dispatchers, so
the same honest graph now passes in both `gc` and standalone.

## Evidence (2026-07-20)

- Current-main targeted standalone batch: **3,469/3,472 pass**.
- Path-exact standalone rerun with a fresh one-test worker: deterministic FAIL,
  `wasm exception during module init`.
- Path-exact graphless FYI `gc` rerun: deterministic FAIL, `a is not defined`.
- Before #3493, path-exact graph-linked project `gc` failed with
  `RuntimeError: unreachable` during module initialization.
- After #3493, path-exact FYI reruns pass **1/1** in both `gc` and standalone.
- The entry test is `flags: [module]` and contains two static namespace imports
  to `_FIXTURE.js` files.
- The two fixtures exist at the pinned Test262 revision and form a circular
  `export *` graph with bindings `fromA` and `fromB`.
- This is not a module-goal false positive: the test is genuinely a Module and
  remains a failure after correct module classification.
- Eleven official resolution-negative module tests in the bidirectional gap
  (ambiguous-export-bindings, import-attributes, and `instn-named-err*`) also
  depend on static `_FIXTURE` graphs. Without those graphs FYI can false-pass on
  an unrelated missing-module rejection instead of reporting the project's
  honest `expected resolution SyntaxError but compiled with no diagnostic`
  failure.

## Acceptance criteria

- The FYI reader/executor supplies the complete reachable static
  `_FIXTURE.js` dependency graph while preserving test262.fyi's literal entry
  harness assembly.
- Resolve fixture specifiers relative to the original Test262 test path; never
  copy from an unpinned checkout or rewrite import names to host-specific paths.
- Support circular `export *` graphs without infinite recursion and preserve
  Module namespace live-binding/identity behavior required by the test.
- Keep fixture files excluded as standalone test records and from totals.
- Do not inline or wrap fixture modules in ways that turn Module declarations
  into Script/function declarations.
- The exact circular-star test passes in FYI `standalone`, matching the project
  runner.
- The FYI `gc` and standalone verdicts both pass after executing the real
  circular graph, never the graphless `a is not defined` result.
- A missing fixture or missing-module diagnostic never satisfies a
  resolution-negative test's expected `SyntaxError`.
- Add focused controls for one-level imports, transitive imports, missing
  fixtures, and circular fixture graphs.
- Project-runner verdicts and ordinary single-file FYI tests remain unchanged.

## Validation

- Run `tests/issue-3491-test262-fyi-module-fixtures.test.ts`.
- Run the exact path through FYI `gc` and `standalone` with fresh workers;
  compare the `gc` signature and standalone pass with the project runner.
- Run a small module-code sample containing fixture-free, one-level, transitive,
  and circular fixture cases and compare with the project runner.

## Follow-up resolution

#3493 closed the graph-linked `gc` frontier by preserving top-level
`globalThis` setup and filling the reserved multi-source member set/get
dispatchers. No harness exception or source rewrite is needed.

## Implementation summary

- `test262-fyi-reader.mjs` now recognizes static fixture imports/re-exports,
  resolves them relative to each pinned Test262 importer, and walks the graph
  with a visited set. It attaches only the separate virtual fixture sources;
  the literal FYI entry assembly remains unchanged.
- `FyiSourceExecutor` and `CompilerPool` transport the virtual entry path and
  fixture map through the shared-worker IPC contract. The worker selects
  `compileMulti` only when a fixture graph is present and otherwise retains the
  existing single-source path.
- Missing fixtures fail during reader discovery. Resolution-negative fixture
  tests cannot treat a thrown graph-link compiler failure or missing-module
  diagnostic as their expected `SyntaxError`.
- Focused coverage exercises fixture-free record accounting, one-level,
  transitive, missing, and circular graphs; literal assembly preservation; the
  exact standalone and gc passes; and a representative official
  resolution-negative anti-false-pass case in both targets.
