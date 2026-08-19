---
id: 3791
title: "IR standalone native RegExp test bridge"
status: done
completed: 2026-07-30
sprint: 78
created: 2026-07-30
updated: 2026-08-18
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir
es_edition: multi
language_feature: regexp
goal: ir-full-coverage
depends_on: [3790]
related: [2949, 3507, 3780]
assignee: ttraenkler/codex-ir-regexp
branch: codex/3791-ir-native-regexp-test
files:
  - src/codegen/index.ts
  - src/codegen/regexp-runtime-contract.ts
  - src/codegen/regexp-standalone.ts
  - src/ir/backend/legality.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/select.ts
  - tests/issue-3791-ir-native-regexp-test.test.ts
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/select.ts
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/select.ts::isPhase1Expr
---

# #3791 — carry standalone native RegExp tests through IR

## Problem

After #3790, Acorn's exact runtime-dynamic standalone build emits 23 of 43
reachable functions through IR. `isIdentifierStart` and `isIdentifierChar`
remain direct-codegen functions because their non-ASCII branches call `.test`
on stable top-level native RegExp carriers. Their
`isRegExpIdentifierStart`/`isRegExpIdentifierPart` wrappers then remain out by
call-graph closure.

The native RegExp engine and its `$NativeRegExp`-first carrier helper already
exist. The missing piece is a narrow IR bridge to the real module-global
carrier, without reconstructing the RegExp, adding a host import, or bypassing
the existing brand semantics.

## Scope

- Admit only one-argument `.test(subject)` on a checker-resolved, stable
  top-level RegExp initialized from compile-time strings.
- Exclude reassigned bindings and global/sticky carriers whose shared
  `lastIndex` state would require wider IR modeling.
- Restrict bridged globals to `var` declarations until the IR read carries
  the module lexical TDZ guard.
- Load the real legacy-allocated externref module global and call the existing
  in-module `__regexp_test_carrier` helper.
- Preserve native-string representation by externalizing the subject at the
  helper ABI boundary; add no JS host import.
- Represent the newly exposed stable numeric-array module globals only as
  exact direct-call vec arguments. Reject reassigned and alias-initialized
  bindings, and require the allocator-owned global ValType to match the
  callee's planned vec ABI.
- Require a selector-visible numeric-vec callee ABI and keep this bridge off
  in fast-array configurations. Target or ABI mismatches remain ordinary
  pre-claim fallbacks.
- Do not touch the direct-backend Acorn performance files.

## Baseline and newly exposed dependency

The #3790 parent measures 23/43 emitted, checksum 422, zero imports, and zero
post-claim withdrawals.

The RegExp bridge first passed its focused 4/4 emission and runtime test, but
the exact Acorn census stayed at 23/43. Removing the RegExp refusal exposed a
second selector barrier in both leaf bodies:
`astralIdentifierStartCodes`/`astralIdentifierCodes` were exact module numeric
vecs passed to the already-emitted `isInAstralSet`, but the IR could not read
those module globals. The direct-call-only numeric-vec projection in this slice
represents that dependency without making module arrays general IR values.

## Result

- The unchanged runtime-dynamic standalone Acorn driver emits 27 of 43
  reachable functions through IR.
- Newly emitted: `isIdentifierStart`, `isIdentifierChar`,
  `isRegExpIdentifierStart`, and `isRegExpIdentifierPart`.
- One exact runtime iteration returns checksum 422 with zero Wasm imports and
  zero post-claim withdrawals.
- The bridge uses the existing native RegExp carrier and helper; it does not
  cache or precompute the benchmark result.

## Acceptance criteria

- [x] Focused standalone execution covers two static native RegExp carriers
      and all four identifier helpers.
- [x] Focused fallback coverage keeps reassigned and global/sticky RegExp
      carriers on direct codegen.
- [x] Destructuring assignment, for-of destructuring, object-rest assignment,
      lexical TDZ, WASI, and fast-array configurations stay on direct codegen.
- [x] Focused coverage admits only an exact stable numeric-array module global
      at a proven numeric-vec direct-call boundary and rejects any-parameter,
      reassigned, and alias-initialized shapes.
- [x] Exact Acorn measurement reaches 27/43 with checksum 422, zero imports,
      and zero withdrawals.
- [x] Typecheck, IR fallback ratchet, formatting, function budget, and focused
      tests pass.
