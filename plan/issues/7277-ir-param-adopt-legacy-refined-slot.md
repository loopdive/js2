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
