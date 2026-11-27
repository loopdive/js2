---
id: 7512
title: "tests/equivalence/helpers.ts: compileToWasm repeats instantiateWithRuntime's import merge"
status: done
sprint: current
created: 2026-11-26
updated: 2026-11-26
completed: 2026-11-26
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: test-infra
goal: core-semantics
related: [7462, 7463]
---

# #7512: one import-merge path in the equivalence helpers

## Problem

`compileToWasm` in `tests/equivalence/helpers.ts` carried its own copy of `instantiateWithRuntime`'s body:
- the merge of the manual imports with the runtime ones;
- `string_constants`;
- `setInstance`.

Found by the adversarial review of lane S25's class-M harness PRs (#7462/#7463).

## Change (PR #7467)

`compileToWasm` now compiles, validates, and delegates to `instantiateWithRuntime`. Both paths end in
`jsFacingExports(result, instance)`, so the returned exports are unchanged. Net −18 lines.

## Follow-ups (lane S25, after #7462/#7463 land)

- The 2-line `run()` wrapper copied into the class-M harness files becomes one shared helper.
- The inline `resolve(__dirname, "../test262/…")` paths (#7495 and about 80 existing tests) fold onto
  `TEST262_ROOT` from `tests/helpers/repo-paths.ts` (#7494).
- The inline #6979 compile-error assertions in #7473 fold onto `tests/helpers/removed-host-strings.ts` (#7485).
