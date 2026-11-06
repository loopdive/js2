---
id: 7277
title: "IR: adopt legacy's refined parameter slot (string / f64) instead of refusing `param-dynamic-carrier-diverges-from-legacy`"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [2949, 4612, 7119, 7258, 7260]
assignee: "ttraenkler/c-r7"
loc-budget-allow:
  # 2026-11-06: +3 lines in the implicit-param resolver (one import and the
  # two-line projection call). The projection itself lives next to its
  # sibling in fnctor-typed-instances.ts.
  - src/codegen/index.ts
---

# IR: adopt legacy's refined parameter slot instead of refusing it

## Problem

`param-dynamic-carrier-diverges-from-legacy` is the largest refusal family on
main. Wrapped stride-40 standalone ledger, main `d28280a0` (lead's count):

| param | count |
| --- | --- |
| `msg` | 278 |
| `desc` / `options` / `value` | 126 each |
| `name` | 15 |
| `s0` | 14 |
| `string` | 11 |
| `type` | 10 |

The refusal (`src/ir/select.ts`, `dynamicCarrierDivergesFromLegacy` =
`makeIrDynamicCarrierDivergenceProbe` in
`src/codegen/fnctor-typed-instances.ts`) fires for an unannotated parameter
with a lattice unknown/dynamic type whose legacy slot is already refined. A
`dynamic` claim there would be a guaranteed post-claim ABI-parity
withdrawal.

## Measurements (step 1, main `8b349439`)

The probe was instrumented under a temporary env flag, then reverted. Over
the first 300 files of the wrapped stride-40 corpus (standalone), these are
the slots that diverge:

| param | function | legacy slot | inferred from | body use |
| --- | --- | --- | --- | --- |
| `options` | `verifyPrimordialCallableProperty` | `ref_null __anon_1`, an object-literal struct | call sites (`{…}` literals) | property reads |
| `desc` | `verifyPrimordialAccessorProperty` | `ref __anon_2`, a non-null struct | call sites | property reads |
| `value` | `verifyEqualTo` | `f64` | call sites (numbers) | `isSameValue(obj[name], value)`, message concat |
| `msg` | `__consolePrintHandle__` (doneprintHandle.js) | `ref $AnyString`, non-null | call sites (strings) | printed |
| `name` | `verifyEqualTo` / `verifyWritable` / `verifyNotWritable` / `verifyNotConfigurable` | `ref $AnyString`, non-null | call sites (string literals) | element key, message concat |
| `val` | `PoisonedValueOf` | `f64` | call sites | — |

Counts in that 300-file sample: options 52, desc 52, value 49, msg 10,
name 11, val 1. None came from the fnctor-instance branch.

The IR already names two of these kinds with exactly legacy's ABI:
- `string` lowers to the non-null native carrier `(ref $AnyString)`
  (`IrType` `string`, `src/ir/core/types.ts`);
- `f64` lowers to `f64`.

The implicit-param resolver (`makeIrImplicitParamTypeResolver`,
`src/codegen/index.ts`) already projects a call-site-inferred
`ref $AnyString` to `string`, but only for parameters whose uses match its
"supported shape" candidate list. `msg`/`name`/`value` are not candidates, so
they fall through to the divergence refusal.

## Implementation Plan

- `src/codegen/fnctor-typed-instances.ts`: `legacyParamSlotProjection(ctx, p)`
  returns the IR `string` type for a non-null `ref $AnyString` slot, `f64`
  for an `f64` slot, and nothing otherwise. It is a sibling of
  `legacyParamSlotIsExternref` and reads the same `legacyParamSlot`.
- `makeIrImplicitParamTypeResolver`: an implicit-any parameter whose legacy
  slot is such a kind projects that kind before the candidate check. The
  selector (`resolveImplicitParamType`, consulted before the divergence
  refusal) and the IR override map (`resolveIrOverrideParamType`) read the
  same resolver, so they share the mapping by construction.
- The parameter is concrete, not a dynamic carrier, so the #2949 carrier
  contract does not change. Every use is scanned as a `string` / `f64`
  value by the normal selector rules. A body that needs it as a dynamic
  value, e.g. a string `name` passed to a dynamic parameter, is refused at
  its own rule.
- Not admitted: the anonymous struct slots (`options`, `desc`). The IR's
  `object` shape is not guaranteed to resolve to legacy's `__anon_N`
  struct, so they keep the refusal.

Code-quality acceptance: one predicate next to its sibling, one branch in
the existing resolver; no new import, no selector change.

## Acceptance criteria

- No claim-then-demote. The ledger shows no new `abi-signature-parity` or
  build-stage demote rows.
- Typed corpus byte-identical on gc/standalone/wasi.
- Wrapped ledger A/B: 0 invariants, compileOk not lower, and the
  zero-legacy / ir-route delta listed.
- Standalone test262 A/B, 300 random + 200 harness-heavy files (100
  propertyHelper includers, 100 async/doneprintHandle files): no pass→fail,
  no new trap.
- A vitest test pins the projection and runtime parity.

## Results (2026-11-06; base = main `8b349439`, head `b6c06be1`)

- **Wrapped ledger** (stride 40, standalone, SHAPE_DIAG), compileOk and
  invariants unchanged:

  | | base | head |
  | --- | --- | --- |
  | compileOk | 1118 | 1118 |
  | invariants | `{}` | `{}` |
  | route `legacy` | 4750 | 4621 (−129) |
  | route `both` | 8561 | 8684 (+123) |
  | route `ir` | 1137 | 1143 (+6) |

  `select:param-type-not-resolvable` falls 978 → 650. Every
  `param-dynamic-carrier-diverges-from-legacy` row for a string/f64 slot is
  gone: `msg` −278, `value` −126, `name` −15, `s0` −14, `string` −11,
  `type` −10, `n` −9, `prop` −7, `tag0` −7. Those units move to their next
  refusal:
  - `__consolePrintHandle__` → `external-call` (+139), and its sibling
    `move-only[concrete]` on the `'Test262:AsyncTestFailure:' + …` concat
    (+139);
  - template literals → `template-substitution-unsupported` (45 → 84);
  - a string `name` passed to a dynamic parameter → `move-only[dyn]` (+9).

  No new `abi-signature-parity` row and no build-stage demote: every change
  is a select-stage refusal or a route gain.
- **Standalone test262 A/B**, 493 files (300 seeded random, 100
  propertyHelper includers, 94 async/doneprintHandle files):
  `{ pass: 341, fail: 113, compile_error: 28, skip: 11 }` on both sides, with
  the same non-pass set row for row.
- **Typed corpus:** 264/264 byte-identical to main (gc/standalone/wasi).
- **Test:** `tests/issue-7277-ir-param-legacy-refined-slot.test.ts`.
  verifyEqualTo is IR-emitted, its throw path keeps legacy's messages
  (including `-0`), and `built-ins/Boolean/prop-desc.js` passes.
- **Gates** (bare, also vs `origin/main`): green.
- **Equivalence gate:** running; the result will go on the PR.

## CI fix (2026-11-06, PR #7143 run 42306438300)

**`quality`: import-cycles.** `fnctor-typed-instances.ts` value-imported
`irVal` from `../ir/nodes.js`, which added one codegen→ir two-way edge
(302 → 303). It now imports only the `IrType` type and writes the `f64`
literal inline. The gate passes against the merge base.

**`equivalence-gate`: 14 regressions** in
`tests/equivalence/issue-7242-ir-new-compiled-function-constructor.test.ts`,
gc and standalone. In `check(x, msg)` and `make(m)` every call site passes a
string, so the new projection typed the parameter `string`. But
`legacyCallerAbiIsProjected` (`planIrOverlay`) certified only `f64`/`dynamic`
implicit projections as a stable non-fast ABI. A string-projected function
with a legacy caller (`inner`) therefore lost its claim to the standalone/wasi
caller-direction closure (`call-graph-closure`).

A `string` projection is the non-null native string slot legacy registered
(the same `ctx.nativeStrings` / `anyStrTypeIdx` carrier #3518 certified for
annotated positions), so it now counts as non-fast stable as well. The
#7242 file passes 30/30 again, and the typed corpus is still 264/264
byte-identical.
