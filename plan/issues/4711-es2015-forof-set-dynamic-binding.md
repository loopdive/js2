---
id: 4711
title: "ES2015 for-of Set dynamic and mutable binding values"
status: in-review
sprint: current
created: 2026-08-25
updated: 2026-08-25
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen, runtime, conformance
es_edition: es2015
language_feature: for-of, Set, mutable-binding
goal: spec-completeness
assignee: codex/4711-es2015-forof-set-dynamic-binding
loc-budget-max-source: 180
related: [4704, 4708, 4702, 4930]
---

# ES2015 `for-of` Set dynamic and mutable binding values

## Exact scope

This issue owns only the dynamic-`any`/mutable-binding defects in:

- `test/language/statements/for-of/set.js`
- `test/language/statements/for-of/set-contract-expand.js`

The change must keep the loop variable's current value observable through the
dynamic assertion/call path after each iteration. It must not implement eager
snapshot replacement or live native Set iteration (#4708), Set `entries`
(#4680), Map iteration, destructuring, async iteration, IteratorClose, or the
generic fresh-binding feature (#4702).

## Exact per-lane baseline from #4704

The #4704 fresh measurement used upstream `main` commit `34b083771` and the
pinned test262 submodule `b363f29d3c`; current upstream `main` (`cd1677bce`)
reproduces the headline `set.js` host failure. Results from that record are:

| Row | Host lane | Standalone lane |
| --- | --- | --- |
| `set.js` | **fail** — `Expected SameValue(«null», «false»)` | **fail** — `Expected SameValue(«null», «false»)` |
| `set-contract.js` (control) | **pass** | **fail** — `Expected SameValue(«1», «0»)` |
| `set-expand.js` (control) | **pass** | **fail** — `Expected SameValue(«1», «2»)` |
| `set-contract-expand.js` | **fail** — `Expected SameValue(«1», «0»)` | **pass** |
| `set-expand-contract.js` (control) | **pass** | **pass** |

The `set.js` and host `set-contract-expand.js` failures occur after Set values
have been yielded: their dynamic assertion closure reads stale mutable state
(`null`/`0`) rather than the current loop value. The standalone pass for
`set-contract-expand.js` is the eager-snapshot behavior documented by #4704,
not evidence that dynamic binding is correct. The two standalone control
failures belong to #4708 and remain negative-scope checks here.

## Focused plan

1. Re-run the two owned rows and the four Set controls in fresh host and
   standalone processes on current main. The Set cursor and loop-body value
   are already correct; the failing dynamic assertion path exposes a stale
   primitive module slot instead of the current iteration value.
2. Trace mutable binding identity through the existing heterogeneous-module
   analysis. A direct assignment such as `third = fourth` was not widening
   `third` when `fourth` was the binding that later received `null`, `undefined`,
   or an object, even though that value flows through the assignment edge.
3. Extend only that analysis with a bounded module-binding dependency graph:
   unwrap identifier RHS expressions, record same-source module binding edges,
   and propagate widening from seeded heterogeneous bindings to their mutable
   consumers. Keep the existing declaration-identity and `with` fallback
   behavior; do not alter Set iterator storage, cursor, or dispatch code.
4. Add focused issue tests for the owned rows and host controls, then rerun the
   exact matrix, array/string controls, both TypeScript lanes, formatting, and
   diff/LOC review. The #4708 live-iterator implementation remains separate;
   its standalone mutation controls are retained as dependency baselines.

## Acceptance

- `set.js` passes in both host and standalone lanes on the current-main
  iterator path.
- `set-contract-expand.js` passes in both lanes on this branch and remains
  green when the #4708 live-iterator source is stacked; its standalone pass is
  not used to claim the separate native Set mutation behavior.
- `set-contract.js`, `set-expand.js`, and `set-expand-contract.js` preserve
  their recorded outcomes; array/string `for-of` controls remain passing.
- No changes to native Set cursor/storage, Map, Set `entries`, destructuring,
  async, IteratorClose, or generic fresh-binding behavior.
- Changed compiler/runtime source is at most 180 lines and the PR contains no
  unrelated worktree changes.

## Test Results

Baseline above is from #4704's fresh current-main run on test262 `b363f29d3c`.
After the binding-analysis fix, the exact Set matrix on current branch
`cd1677bce` is:

| Row | Host lane | Standalone lane |
| --- | --- | --- |
| `set.js` (owned) | pass | pass |
| `set-contract.js` (#4708 control) | pass | fail — `Expected SameValue(«1», «0»)` |
| `set-expand.js` (#4708 control) | pass | fail — `Expected SameValue(«1», «2»)` |
| `set-contract-expand.js` (owned) | pass | pass |
| `set-expand-contract.js` (control) | pass | pass |

The focused `tests/issue-4711.test.ts` suite passes all 7 assertions: both
owned rows in both lanes plus the three host controls. Array and string
controls (`array.js`, `array-contract.js`, `array-expand.js`,
`array-contract-expand.js`, `array-expand-contract.js`, `string-bmp.js`, and
`string-astral.js`) pass in both lanes. TypeScript 5 and TypeScript 7
`--noEmit` checks pass. The compiler source diff is 47 lines, below the 180
line cap; no iterator/storage code changed. A temporary validation worktree
stacked #4708 commit `cd1bf056a` on this commit; all five Set rows then passed
in both host and standalone lanes. The #4708 commit and its files are not part
of this PR. After merging upstream main as `1e47a46d8`, the exact Set matrix
remained unchanged: both owned rows passed in both lanes, both standalone
native-mutation controls retained their expected #4708 failures, and all other
controls passed. Full standalone control closure depends on #4930 (the #4708
live native Set iteration PR).
