---
id: 4529
title: "jest-get-type: typeof/classification on boxed any returns 'object' for every primitive — 16/32 upstream tests fail"
status: in-progress
sprint: current
created: 2026-08-16
updated: 2026-08-21
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: typeof
goal: npm-library-support
related: [3995, 4367]
files:
  - src/codegen/typeof-delete.ts
  - tests/dogfood/jest-upstream-suite.mjs
---

# jest-get-type: compiled `getType()` classifies every value as "object"

## Problem

Jest's pinned upstream slice runs `jest-get-type` (`getType.test.ts` +
`isPrimitive.test.ts`): **16/32 in Wasm** (32/32 Node), measured 2026-08-16
on `a9b20d4c`, matching the npm-compat card.

Every failure is one defect observed twice:

- `getType(value)` returns `"object"` for number, string, function, boolean,
  symbol, date, bigint inputs (7 failures:
  `toBe: string:object != string:number` …);
- `isPrimitive(value)` returns `false` for null, undefined, numbers, strings,
  booleans, symbols (9 failures: `toBe: boolean:false != boolean:true`).

Upstream `getType` is a chain of `typeof value === '…'` /
`value === null` / `Array.isArray` / `constructor` checks on an untyped
parameter. The test callbacks pass primitives in from the shim through the
dynamic-call ABI, so the parameter arrives as a boxed `any`/externref. Inside
the compiled function, `typeof` on that boxed value answers `"object"`
regardless of what the box holds — the typeof lowering is reading the box,
not the boxed value.

## Reproduction

```bash
node --import tsx tests/dogfood/jest-upstream-suite.mjs --json
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Reduce**: `export function getType(v) { if (typeof v === 'number') return 'number'; … return 'object'; }`
   called dynamically with primitive arguments through the host bridge
   (mirror the harness's `wrapExports` call path — the static-call path is
   probably fine; the defect is the dynamic-arg boxing). Assert each
   primitive classifies correctly. `.tmp/` first, then commit as
   `tests/issue-4529.test.ts`.
2. **Fix in `compileTypeofExpression` / `compileTypeofComparison`**
   (src/codegen/typeof-delete.ts): when the operand is a boxed-any carrier,
   the lowering must dispatch on the *runtime* box kind (number box, string,
   bool, symbol — the runtime already distinguishes these for `any_to_*`
   unboxing; see src/codegen/any-boxing-helpers.ts and the `__extern_typeof`
   host import if present) instead of statically answering `"object"`.
   Check what the host lane does for an `externref` operand today — there is
   likely an existing `typeof` host helper that this operand shape simply
   fails to route into.
3. **Note the date/bigint arms**: `getType` distinguishes `date` via
   `constructor` checks upstream — those may fail for a second reason
   (constructor identity through the bridge). Fix typeof first, re-measure,
   and record what remains rather than chasing both blind.
4. **Validation gates**: reduction test; jest harness re-measured (target:
   the 9 isPrimitive + the 5 pure-typeof getType failures flip; record the
   final number here); test262 typeof family + equivalence green.

## Acceptance criteria

- [ ] `typeof` on a dynamically-passed primitive answers its real tag in
      compiled code.
- [ ] jest-get-type slice ≥ 28/32 Wasm, with the residual (if any) named.
- [ ] Committed reduction test.

## 2026-08-21 checkpoint

jest pinned suite **107/232 → 113/232** (the suite grew from 32 to 232
admitted since this issue was filed); getType.test.ts **7/14 → 13/14**.

Three fixes landed:

1. `staticTypeofForType` no longer folds the empty anonymous object type `{}`
   (TS's narrowing of `unknown` behind nullish guards — it admits every
   non-nullish value) to "object". This was the actual mechanism behind the
   getType failures: the fold turned every `typeof value === '…'` compare
   into constant false.
2. Host `__typeof` unwraps Wasm-native boxed primitive carriers
   (`_nativePrimitiveToHost`) before answering, so a boxed number/boolean/
   bigint no longer reports "object".
3. `Object(v)` on an `any`/`unknown`-typed argument now routes through a new
   `__to_object` host helper (real §7.1.18 ToObject, unwrapping native
   carriers) instead of compiling as identity — `Object(value) !== value`
   (jest's isPrimitive) now distinguishes primitives. Host lane only;
   standalone keeps the identity fallback (follow-up).
4. (With #4530) `inferParamTypeFromCallSites` withdraws a GC-ref narrowing
   when any call site passes an opaque `any` argument.

Regression tests: `tests/issue-4529-typeof-narrowed-unknown.test.ts`.

**Remaining**: isPrimitive.test.ts is still 0/18 in the harness — its values
flow through `test.each([mixed array literal])`, the heterogeneous-array
carrier family (#4531/#4526), not a typeof defect. getType residual 1/14 is
the `date` arm (constructor identity through the bridge, as predicted in the
plan). The date/bigint constructor-identity residual and the each-array
carrier stay open here and in #4531 respectively.
