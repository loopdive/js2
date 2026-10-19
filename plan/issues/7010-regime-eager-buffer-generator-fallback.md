---
id: 7010
title: "regime: no eager-buffer generator fallback on host-free builds — refuse with #7010"
status: done
sprint: current
created: 2026-10-16
updated: 2026-10-19
completed: 2026-10-19
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: generators
goal: architecture
parent: 5385
related: [680, 6979, 6980, 6984, 1388]
assignee: "ttraenkler/opus-7010-gen"
branch: "issue-7010-regime-eager-buffer-generators"
loc-budget-allow:
  # 2026-10-16 (#7010) +3/+3/+5: one refusal arm (`refuseEagerGeneratorBuffer`)
  # in front of each eager-buffer emit site; the body lives in
  # generator-eager-refusal.ts.
  - src/codegen/class-bodies.ts
  - src/codegen/literals.ts
  - src/codegen/statements/nested-declarations.ts
func-budget-allow:
  # 2026-10-16 (#7010) +2/+2/+4: the refusal arm in front of the eager buffer.
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/literals.ts::compileObjectLiteralForStruct
---

# #7010 — the eager-buffer generator fallback on host-free builds

## Problem

On standalone, WASI and the native regime (`semanticProviders: "native-first"`,
`ctx.standalone` since #5385), a generator that neither the native #680 state
machine nor the async-generator drive (#2906/#3132) claims still fell back to
the eager host buffer. `sourceNeedsGeneratorHostImports` pre-scanned the source
and `addGeneratorImports(ctx, { allowNoJsHost: true })` registered
`__gen_create_buffer` / `__gen_push_*` / `__gen_yield_star` /
`__create_generator` / `__create_async_generator` / `__gen_next|return|throw` /
`__gen_result_*`. No host-free build can satisfy those imports. After S7-b
(#6979) they are the named `regime-gap` class `eager-generator-buffer`. The S7-b
checkpoint lists 7 exposing programs from its 1-in-97 sample, including
`tests/equivalence/issue-1388.test.ts` case #2.

## Measurement (2026-10-16, upstream/main `e64de5cff9`)

The S7-b list is a sample. The full picture:

- **test262 `class/elements/*async-gen*` (224 files, standalone, harness
  assembled as in `runTest262File`)**: 212 compiled with `__gen_*` imports.
  - 144 needed only the readers `__gen_result_value`/`__gen_result_done`.
  - 68 needed the full `__create_async_generator` buffer.
- **1-in-10 sample of all 5,654 test262 files with generator syntax
  (standalone)**, measured on a snapshot of #6980's branch so that group (A)
  below is already excluded: 26 programs still needed a `__gen_*` import. The
  standalone baseline (`test262-standalone-current.jsonl`, 2026-10-15) scores
  24 of them as `compile_error` ("standalone target emitted host imports"); the
  other 2 fail at runtime. So no standalone pass depended on the buffer.

Grouped by the reason the native path refused:

| Group | Reason the native path declined | Exposing programs | Result in this PR |
| --- | --- | --- | --- |
| A | None. All async generators drive natively, but the pre-scan counted every async generator and registered the `__gen_*` readers, so `r.value` / `r.done` routed to `__gen_result_value_f64` (NaN on standalone, a policy rejection under native-first). | issue-1388 #2; `AsyncGeneratorPrototype/throw/throw-suspendedYield-promise.js`; `AsyncFromSyncIteratorPrototype/throw/iterator-result-poisoned-value.js`; 144/224 class/elements rows | **Native.** The readers are no longer registered on host-free builds. #6980 fix 9 (PR #6678, open) narrows the same pre-scan; on a snapshot of that branch these programs compile with 0 gen imports too. This PR deletes the pre-scan, so whichever lands second resolves the conflict by taking the deletion. |
| B1 | `yield* await P`: an rtDelegate operand containing an `await`, rejected by `analyzeAsyncGen`. | 68/224 class/elements `rs-static-async-generator-method-privatename` rows (6/26 of the sample) | **Refused (#7010).** All 68 were already `compile_error` on standalone through their host imports; they stay `compile_error`, now naming #7010. No pass lost. A prototype native lowering on the direct-AST async-gen CFG passed 52/68, but that route is frozen (`plan/method/ir-only-development-freeze.md`), so it was withdrawn; see the IR follow-up below. |
| B2 | A yield nested in an operand (`yield { ...yield, ...yield yield }`, spread forms). Async gens and sync generator methods. | `*/yield-spread-obj.js`, `*/yield-spread-arr-*.js` (9/26) | **Refused (#7010).** The async drive has no expression-level suspension. |
| B3 | `var v = yield* obj` (a delegation completion binding) together with `.throw()`/`.return()` forwarding. | `async-generator/yield-star-async-throw.js` and `yield-star-sync-next.js` families (4/26) | **Refused (#7010).** |
| B4 | A yield inside a loop body (`for await (…) { yield … }`). | `*/yield-promise-reject-next-for-await-of-*.js` (4/26) | **Refused (#7010).** The async-gen CFG is statement-flat. |
| B5 | A yield inside a `try`. | `AsyncGeneratorPrototype/throw/throw-suspendedYield-try-finally-throw.js` (1/26) | **Refused (#7010).** |
| B6 | Delegate/method exclusions: `yield* call()` to a non-drivable or non-top-level async generator, a static method reading `this`, `super`, `arguments`. | `named-yield-star-expr-abrupt.js`, `yield-promise-reject-next-yield-star-async-iterator.js` (2/26) | **Refused (#7010).** |

## Fix

- **No registration on host-free builds.** `addGeneratorImports` returns early
  on `ctx.standalone || ctx.wasi`, and the `allowNoJsHost` option is gone. The
  import collector registers the bundle in the JS-host lane only.
  The `sourceNeedsGeneratorHostImports` pre-scan is deleted, and so is the
  closures.ts late re-registration. `generatorCapturesOuterScope` stays because
  the JS-host candidate gates still call it.
- **Refusal at the emit site.** `refuseEagerGeneratorBuffer` in
  `generator-eager-refusal.ts` reports
  `generator-no-host-free-lowering: … (#7010)` and pushes `ref.null.extern`,
  which has the same stack effect as the buffer epilogue. Each eager-buffer arm
  calls it first: class methods, object-literal methods, function expressions,
  and both nested-declaration arms. Top-level declarations already refused with
  the #680 diagnostic.
- **No new direct-AST lowering.** Under the old direct-AST path development
  freeze (`plan/method/ir-only-development-freeze.md`) this PR only removes the
  retired host path and refuses what it used to catch. `src/codegen/async-cps.ts`
  changes by one comment.
- The JS-host (`gc` host-assisted) lane is unchanged: it still registers and
  emits the buffer.

## Acceptance

- `tests/issue-7010-regime-eager-buffer-generators.test.ts`: 20 cases.
  - (A) issue-1388 #2 under native-first (JS-equal, 0 gen imports) and
    standalone (0 imports).
  - (B) six refused shapes × {standalone, native-first, wasi}: a #7010 error
    and 0 gen imports. The shapes are `yield* await` (function expression and static
    private method), yield inside `for await`, a static method reading `this`,
    nested yields in object-spread operands, and yield inside `try`.
- `tests/equivalence/issue-1388.test.ts` under native-first (scratch copy of
  the helper with `semanticProviders: "native-first"` + `wrapCompiledExports`):
  7/7 pass. On base, #2 fails.
- The same 1-in-10 sample, re-run with the fix: 0 programs carry a `__gen_*`
  import (measured with the withdrawn B1 prototype in place; without it the
  6 B1 rows are #7010 refusals too, as the focused test asserts).
- `node scripts/equivalence-gate.mjs` (run with `--configLoader runner` in the
  sandbox): "22 failing, 1785 passing, 22 known-failures in baseline … ✓ No new
  equivalence regressions."
- `pnpm run check:host-import-policy` passes (on main the `regime-gap` class
  does not exist yet). The S7-b `eager-generator-buffer` probe will find no
  imports once this lands, so S7 should drop that family.
- Re-pinned tests that asserted the old host bail now assert the #7010 refusal:
  `issue-2581` optional param, `issue-3132-s2` (static-this / super /
  arguments / mixed module), `issue-3948` optional param, `issue-4769`
  class-expression yield, `issue-6651` A2.

## Left out

- **IR follow-up (B1–B6):** native async-generator lowering of `yield* await`,
  nested yields in spread / for-await / try, and delegation forwarding. This is
  IR producer work under the freeze, not a direct-AST slice. Until it lands,
  these shapes are #7010 compile errors on host-free builds.
- The HOSTGEN arm of the native iterator runtime (`iterator-native.ts`,
  #3075) is now unreachable on host-free builds, because
  `legacyGenBufferEmitted` can no longer be set there. Deleting it is left to
  S7-c's `ctx.standalone` arm collapse, to keep this diff to the generator gate.
- The local native-first test262 lane fails every async-flagged row with "async
  completion marker not observed", plain `Promise.all` rows included. That is a
  local-runner gap, not a #7010 defect, so native-first acceptance here uses
  direct JS-environment probes.
