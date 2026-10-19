---
id: 7040
title: "ir: claimed bodies that hard-fail the compile — untyped invariants where a typed demotion belongs (#7014 traps/CE slice)"
status: done
sprint: Backlog
assignee: "ttraenkler/wave15-traps-ce"
created: 2026-10-17
updated: 2026-10-17
completed: 2026-10-17
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: multiple
goal: ir-full-coverage
related: [7014, 7041, 7051, 305, 2853, 2201, 2598, 2161, 1313, 5165, 4178, 3214, 2900]
requested_by: ttraenkler/wave15-traps-ce
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
---

# #7040 — IR claims that fail the whole compile (#7014 traps/CE slice)

Part of the [#7014](7014-issue-tests-detector-red-since-july.md) backlog. Every
item below is a program the IR path CLAIMED and then could not lower, failing
the compile with an untyped invariant (or emitting invalid Wasm) where the
contract is a typed demotion to the legacy path. Each was bisected on the
first-parent history of upstream main (a `src/` snapshot per candidate, the
issue test's own source as the probe).

## Root causes and fixes

| Tests | Culprit (bisected) | Root cause | Fix |
| --- | --- | --- | --- |
| `issue-305` "reassigning one variable does not affect the other", `issue-2853` bug A | 7e0180ea63 (#5163) | `let a = { x: 1 }; …; a = { x: 2 }` — a mutated binding with no slot representation (object shape) was bound as an SSA `local`; the later write threw the untyped "assignment to non-slot binding" invariant. Reachable once #5163 let the selector claim mutating expression statements. | `lowerVariableDeclaration` demotes (`body-shape-rejected`) instead of binding a local it promised would be a slot. |
| `issue-2201` (6 tests, both lanes) | 163eb5bc5c (#5289) | `let a: any = 1; a &&= function () {}; a.name` — #5289 admitted `any` module bindings, so the IR claimed the read and emitted a runtime `dyn.member_get`; §13.15.2 NamedEvaluation for `&&=`/`\|\|=`/`??=` is a legacy STATIC fold (#2201) — no lane stamps the name on the closure, so it read `undefined` (and the host lane failed with "`__dyn_member_get` not registered"). | `src/ir/logical-assignment-name-targets.ts`: a `.name` read of such a target demotes. |
| `issue-4178` "a const chain … poisons the numeric fold", "a numeric const chain still folds" | 163eb5bc5c (#5289) | `const a: any = x` (x a numeric const) is NARROWED to `f64` storage by the #4178 const-chain trace; #5289 assumed the dynamic carrier and the module-init agreement check threw `abi-type-index-mismatch`. | A dynamic binding whose legacy slot was narrowed demotes the module-init (`module-init-legacy-coupling`). |
| `issue-2598-2599` "includes(number)", "includes(/regexp/)", "indexOf(/regexp/)" | 084cf798b8 (#4663) | `"a1b".includes(1)`: the search argument was lowered with a `string` HINT that does not convert, so the native helper got an `f64` (invalid Wasm); a RegExp argument reached integration as a host-only carrier. | A non-`string` argument to a string-search method demotes; ToString / IsRegExp stay with the legacy argument coercion. |
| `issue-2161` (4 tests) | e567b755cc (#5511) | `g = (/ab/gi).toString()` — #5511 made the body claimable (string module binding); the selector's host-free RegExp refusal named only `.test`/`.exec`, so `.toString` was claimed and hit from-ast's `assertNotDeferred` capability violation. | The selector refuses every other method on a RegExp receiver in a host-free lane, as the `.test`/`.exec` arm's comment already intended. |
| `issue-1313` (5 tests), `issue-1727` "Promise<void> async fn consumed as value", `issue-5165` "try whose arms both return — THROWING" | 3bcad2e9b2 (#5482) | An await-free `async function inner(): Promise<string>` has no async plan and keeps the direct async lowering. The prepared-async adapter census treated it as a half-attached owner and threw "has no valid async plan owner"; the census only ran when a runtime manifest froze, and since #5482 any string literal freezes one. | `collectPreparedAsyncRuntimeRequests` skips a function with neither plan nor runtime (still throws on a HALF attachment). |
| `issue-3214` "seeds a reassigned live function …", `issue-2900` "deferring emits exactly one __module_init" | 944643dcde (#5598) | A source whose only executable top-level semantics are live seeds (a reassigned top-level function) has no module-init terminal; `buildIrModuleInitPlan` records that as its typed `missing-module-init-unit` gap, but the multi-module census treated it as a lost terminal and failed the compile. | The census accepts the plan's declared gap (`executable` already excludes a null-unit plan). |

`issue-3214` "rejects an imported overload set before claiming" is stale:
41e4840f7d (#5300) admits a compatible overload set by design; the test now
pins no post-claim error and the right answer (42).

## Measured

Per test file, upstream main 0727e2985b, one file at a time
(`node node_modules/vitest/vitest.mjs run <file>`); "red" counts only tests
not already in the July `issue-tests` baseline.

| File | before | after |
| --- | --- | --- |
| issue-305 | 1 red | 0 |
| issue-2853 | 1 red | 0 |
| issue-2201 | 6 red | 0 |
| issue-2598-2599-string-arg-tostring | 3 red | 0 |
| issue-2161-regex-tostring | 4 red | 0 |
| issue-1313 | 5 red | 0 |
| issue-1727 | 1 red | 0 (its other failure is a July-baseline known failure) |
| issue-5165-tail-control-flow | 1 red | 0 |
| issue-3214-imported-hof | 2 red | 0 |
| issue-4178 | 3 red | 1 (see residuals) |
| issue-2900 | 2 red | 1 (see residuals) |

Scoped standalone test262 (base vs fix): see the PR.

## Probes

The measured test files are the permanent repros:

- `tests/issue-305.test.ts`
- `tests/issue-2853.test.ts`
- `tests/issue-2201.test.ts`
- `tests/issue-2598-2599-string-arg-tostring.test.ts`
- `tests/issue-2161-regex-tostring.test.ts`
- `tests/issue-1313.test.ts`
- `tests/issue-1727.test.ts`
- `tests/issue-5165-tail-control-flow.test.ts`
- `tests/issue-3214-imported-hof.test.ts`
- `tests/issue-4178.test.ts`
- `tests/issue-2900.test.ts`

## Residuals (left red, not in this change)

- `issue-4178` "exact mixed primitive ternary … #5092 IR owner": the IR now
  fails with "dynamic/externref returned into a native 'string' result needs a
  checked conversion" (unpatched slot after the legacy body was skipped).
- `issue-2900` "the target test passes — and fails without the defer": the
  no-defer CONTROL now passes too (returns `null`, not the old
  "sameValue is not a function"), i.e. the defer is no longer load-bearing for
  that row. Needs the owner to confirm before the control is rewritten.
