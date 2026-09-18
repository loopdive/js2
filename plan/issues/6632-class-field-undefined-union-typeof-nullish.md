---
id: 6632
title: "standalone: a `T | undefined` slot (class field / dynamic member-get read) resurrects as `null`, not `undefined`, in two codegen sites"
status: done
assignee: ttraenkler/sendev-s46
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-18
completed: 2026-09-18
---

## Problem

`#5383` S45/S45b reduced two failing test262 rows
(`test/built-ins/Temporal/PlainDate/from/argument-object-valid.js`,
`…/argument-string.js`) to `Test262Error: Expected SameValue(«null»,
«undefined») to be true` inside `TemporalHelpers.canonicalizeCalendarEra`. S45b
fixed a related-but-distinct defect (#6631, the mixed-array-element typeof
tag) and explicitly noted it did **not** close these two rows. S45b's own
probe (`class D { era: string | undefined; … } typeof d.era` → `"object"`)
isolated the mechanism to a single-module, no-provider repro.

Root cause: `resolveWasmType`'s single-kind nullable-union collapse
(`src/codegen/index.ts`, the `tsType.isUnion()` branch around
`nonNullish.length === 1 && tsType.types.length === 2`) gives `string |
undefined` the SAME wasm carrier as `string | null` — a bare `ref_null
$AnyString`. A wasm `ref.null` cannot itself distinguish "the JS value is
`null`" from "the JS value is absent" — only the STATIC declared type at the
read site can. `type-coercion.ts`'s `coerceType` already has the correct
resurrection arm for this (#4741: a null `$AnyString` boxes to the canonical
`undefined` extern, not host `null`), but two OTHER call sites box a
`ref_null $AnyString` slot to externref WITHOUT going through that arm:

1. **`compileTypeofExpression`** (`src/codegen/typeof-delete.ts`) — the
   generic ref/ref_null operand branch called `extern.convert_any` directly
   instead of routing through `coerceType`, unlike the f64/`undefSentinel`
   branch immediately above it (#5378), which already does. `typeof (v:
   string | undefined)` on an absent class field therefore answered
   `"object"` instead of `"undefined"`.
2. **The generic dynamic member-get dispatcher**
   (`__get_member_<name>`, `src/codegen/member-get-dispatch.ts`) — used for a
   COMPUTED-key read (`obj[key]`), as opposed to a statically-typed direct
   field access. Its per-candidate box step called
   `coercionInstrs(ctx, fieldType, {kind:"externref"})` with **no**
   `FunctionContext` (this fill runs once at finalize over hand-tracked
   locals, not through the push-style `coerceType` engine that owns the
   #4741 arm), so the arm was unreachable there; the bare
   `extern.convert_any` row in `coercionInstrs` ran instead.

## Fix

Both sites now resurrect a null `ref_null $AnyString` as the canonical
`undefined` extern:

- `typeof-delete.ts`: route the ref/ref_null operand through `coerceType`
  (mirrors the #5378 f64 arm one branch above it).
- `member-get-dispatch.ts`: a new helper `nullableAnyStringResurrectionBox`
  emits the null-check + `canonicalUndefinedExternInstrs` resurrection inline,
  scoped to fields whose type is exactly `ref_null $AnyString`, reusing the
  dispatcher's existing `__any` scratch local (local 1) — safe because by the
  time the box runs, the receiver cast has already been consumed by
  `struct.get`, and each dispatch arm is a mutually-exclusive `if`/`else` leaf
  (no sibling arm observes the overwrite).

Both fixes are scoped exactly to the `ref_null $AnyString` carrier — a
genuinely-`T | null` field is untouched and correctly stays `null`
("object").

## S46 findings

**Reduction and WAT evidence.** Reproduced S45b's single-module probe on
214afd09cc (`.tmp/s46/probe11.mts`, case "class field union"):
`class D { era: string | undefined; constructor(e) { this.era = e; } } const
d = new D(undefined); typeof d.era` → `"object"` (base), `"undefined"` (fix).
WAT evidence (`.tmp/s46/watdump-class.mts` → `/tmp/probe-class.wat`):

```
(type $D (struct (field $__tag i32) (field $era (mut (ref null 6)))))
```

Type index 6 in that dump is `$AnyString` (`ctx.anyStrTypeIdx`), confirming
the field's wasm carrier is exactly the ambiguous `ref_null $AnyString` shape.
`typeof-delete.ts`'s `compileTypeofExpression` compiled the read as
`struct.get … ; extern.convert_any` with no null check — fixed by routing
through `coerceType`.

**A second bug, found while checking `d.era === undefined`** (not just
`typeof`): `compileNullishObservedExpression` → `compilePropertyAccessForNullishObservation`
(`property-nullish-read.ts`) routes a PropertyAccessExpression nullish
comparison through the GENERIC dynamic member-get dispatcher
(`__get_member_era`), not the static struct field type. WAT evidence
(`.tmp/s46/watdump-eq.mts` → `/tmp/probe-eq.wat`, function `$__sget_era`):

```
struct.get 52 1
extern.convert_any
```

— same bare-conversion gap, in `member-get-dispatch.ts`'s
`fillMemberGetDispatch` → `buildGetDispatch`'s box computation
(`coercionInstrs(ctx, cand.fieldType, {kind:"externref"})`, called with no
`fctx`). Fixed with `nullableAnyStringResurrectionBox`.

**Witness.** `tests/issue-6632-class-field-undefined-union.test.ts` (8 cases):
fix-witnesses FAIL on base (`.tmp/s46/fix/{typeof-delete,member-get-dispatch}.ts.base`
file-copy revert, confirmed), PASS on fix; controls (`string | null` field
stays `null`/"object", plain `string` field, `number | undefined` field via
the pre-existing f64 `undefSentinel` path, `=== undefined`/`== null`
semantics, a cross-module getter through the link boundary) all pass on both
trees where expected. `npx vitest run --maxWorkers=2 tests/issue-66*.test.ts
tests/issue-6484-*.test.ts` — 35 files / 211 tests, 0 failed (was 34/203
before this PR).

**Criterion 4 (real corpus rows) — NOT closed by this fix.** Re-ran both named
rows against a freshly rebuilt Temporal provider + quickjs adapter (both
`cacheHit=false`, hashes rotated after the fix) via `.tmp/s46/tworow.mts`:
both STILL fail with the identical `Expected SameValue(«null», «undefined»)`
error. Further reduction (`.tmp/s46/watdump-provider.mts` → `/tmp/provider.wat`,
52 MB, unminified — the polyfill compiles with its original internal names
intact) traced the actual read: `PlainDate.prototype.get era` calls `$Ni(this,
"era")`, whose body is `Qt(this).isoToDate(n, {[t]: true})[t]` — i.e. `date.era`
is NOT a direct struct-field or typed-getter read at all. `Qt(e)` resolves the
date's `Calendar` through a **polymorphic interface reference** (any built-in
or custom calendar), so `.isoToDate(...)`'s return value has static type
`any`, and `[t]` (`t = "era"`, a runtime string, not a compile-time literal)
is read via the fully-dynamic `$Object` property store
(`$__extern_get`/`$__extern_set`, `object-runtime.ts`) — a THIRD site, not
covered by either fix here. `.tmp/s46/probe-dynset.mts` and
`.tmp/s46/probe-objlit.mts` attempted to reduce this exact shape (a
polymorphic-interface method building a dynamic object with a `string |
undefined` field, read back through a computed key) but each reduction hit a
DIFFERENT, unrelated pre-existing crash (a null-pointer trap in interface
method dispatch on an `any`-returning method; "Cannot access property on null
or undefined" on a spread-conditional object literal) rather than reproducing
the SameValue mismatch directly — the synthetic repros do not yet match the
real code's shape closely enough. Time-boxed at ~2.5h per the dispatch brief;
handing back the reduction and hypothesis rather than continuing to guess.

**Battery**: not run. The task's four-family/must-not-move/corpus-byte battery
requires the two named rows to be the acceptance signal, and they are still
red — running the full battery would validate #6631 alone (S45b's own
un-run obligation) but not this PR's fix, and there was no time budget left
to run it after the reduction above. `tests/issue-66*.test.ts` +
`tests/issue-6484-*.test.ts` (211 tests) is the only regression evidence
collected for this PR. A follow-up should either (a) find and fix the
`$__extern_get`/`$__extern_set` site (same `ref_null $AnyString` resurrection,
applied to the dynamic-object property store) and re-attempt both rows, or
(b) route `Ni`'s specific call shape through a narrower fix if the dynamic
store turns out not to be the culprit after all — the WAT evidence above
points there but was not confirmed by a passing minimal repro.

## Implementation Plan

See "S46 findings" above — this IS the implementation plan and its own
record, written after the fact since the fix was small and the investigation
was the majority of the work.
