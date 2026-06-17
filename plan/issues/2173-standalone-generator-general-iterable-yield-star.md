---
id: 2173
title: "standalone: yield* over a general iterable (array / custom {next()}) in native generators (SF-3 slice-2 of #2157)"
status: blocked
blocked_by: [2106]
sprint: 63
created: 2026-06-16
updated: 2026-06-16
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: iterators-generators
goal: standalone-mode
parent: 2157
depends_on: [2170, 1320]
---

# #2173 — yield* over a general iterable (SF-3 slice-2 of #2157)

## Problem

#2170 (slice-1) landed `yield* <native-generator-call>` — delegation to an
inner native generator by driving its `__gen_resume_<inner>`. The remaining,
larger case is delegation to an **arbitrary iterable**: an array literal, a
canonical-vec value, or a custom `{ [Symbol.iterator]() { return { next() {…} } } }`.

```ts
function* g(){ yield* [1, 2, 3]; yield 4; }   // standalone: #680 CE today
export function test(): number { let s = 0; for (const x of g()) s += x; return s; } // want 10
```

`buildNativeGeneratorPlan` still bails on a `yield*` whose subject is not a
native-generator call (slice-1's `nativeGeneratorDelegationName` returns
undefined → `fail()`).

## Approach — drive the #1320 standalone iterator bridge from the yield-star state

#1320 already provides a no-host iteration protocol as emitted Wasm:
`__iterator(subject) -> ref $__IterRec`, then `__iterator_next(rec) -> {value:
externref, done:i32}` (the canonical-vec + USER `{next()}` arms, #2038). The
native generator's `yield-star` terminator (#2170) already self-suspends and
persists an inner across host re-entries via a typed delegation slot. Slice-2
generalizes that slot to hold a `$__IterRec` (externref) and drives
`__iterator_next` per resume instead of `__gen_resume_<inner>`:

1. **Plan builder**: extend the `yield*` branch in `emitYield` — when the subject
   is NOT a native-generator call but its TS type is iterable (array / vec /
   custom iterable), still emit a `yield-star` terminator, tagged
   `kind: "iterable"` (vs slice-1's `kind: "native-gen"`), recording the subject
   expression for emit-time `__iterator` construction.
2. **State struct**: the delegation slot for an iterable site is an `externref`
   (the `$__IterRec`), nulled at construction; reuse the #2170 `delegationSlots`
   machinery with a per-slot kind tag.
3. **Runtime (yield-star arm, iterable kind)**: on first entry, materialize the
   `$__IterRec` (`compileExpression(subject)` boxed to externref →
   `__iterator(...)`) into the slot. Each entry: `__iterator_next(rec)`; if
   `done==0`, **unbox** `value` (externref) to the generator's result elem type
   (`info.elemValType` — f64 via `__unbox_number`/`any.convert_extern`+cast for
   the numeric path; #2171's native-string for the string path) and re-yield it,
   staying in THIS state; if `done==1`, null the slot, transition to `next`.

## Slice boundary

- **Slice-2a (this issue, numeric)**: `yield* <iterable-of-numbers>` (array
  literal, vec, numeric custom iterable) — unbox each `__iterator_next` value to
  f64. Covers the dominant `yield* [..]` test262 pattern.
- **Deferred**: string/object element iterables (need #2171 elem path threaded
  through the unbox), `x = yield* it` return-value binding, `.return()`/`.throw()`
  forwarding into the iterator's `__iterator_return`.

## Acceptance criteria

- `function* g(){ yield* [1,2,3]; yield 4; }` → `[...g()]`/for-of sums to 10,
  standalone, **zero host imports**.
- `yield*` over `arr.values()` (canonical vec) and a custom numeric `{next()}`
  iterable both iterate.
- Slice-1 (`yield* nativeGen()`) unregressed; non-iterable `yield*` still bails.

## Source

Follow-up of #2170 (sdev3, slice-1). Builds on #2170's `yield-star` terminator +
delegation-slot machinery in `generators-native.ts`.

## CRITICAL design correction (2026-06-16, sdev3) — DON'T use the #1320 bridge for numeric arrays

Implementation investigation found the original "#1320 `__iterator`/
`__iterator_next` bridge" framing is **wrong for the numeric-array case** (the
dominant `yield* [1,2,3]`), and would regress the zero-host-import invariant:

- The #1320 bridge represents iterator values as **externref** (boxed). Unboxing
  externref→f64 needs `__unbox_number`, and boxing for `__iterator` needs
  `__box_number` — both are `ensureLateImport` HOST imports
  (`type-coercion.ts:197`, `array-methods.ts:604`). Driving the bridge from the
  yield-star arm would emit those host imports → **breaks standalone**.
- Confirmed by WAT: standalone `for (const x of [1,2,3])` does **NOT** use
  `__iterator`/`__iterator_next` at all (0 mentions) — it uses a **direct array
  fast-path** that iterates the native vec's f64 `data` array directly, zero host
  imports. The bridge is for the *generic/escaped* iterable case, not numeric
  arrays.

**Corrected approach (slice-2a, numeric arrays/vecs):** the yield-star
"iterable" arm should drive the inner like the **array for-of fast-path**, not
the bridge: resolve the subject to its native vec (`{length, data: array f64}`),
persist the vec ref + an i32 cursor across re-entries (the delegation slot
becomes `{vec ref, idx i32}` — two fields, or a tiny `$__YieldStarVecCursor`
struct), and per resume read `vec.data[idx]` (already f64 — no unbox), re-yield,
`idx++` until `idx >= vec.length`. Reuse the for-of fast-path's vec-resolution
helper (find it in `declarations.ts` for-of / `array-methods.ts`). The #1320
bridge stays ONLY for the genuinely-generic escaped-iterable case (a later
slice), where the host box/unbox is unavoidable anyway (or needs the native
i31/anyref number rep — ties into #2104/#2106 value-rep work).

## Scaffolding already built (sdev3, partial — on branch issue-2173-general-yield-star)

Stacked on #2170's slice-1 (PR #1502). DONE: the `yield-star` terminator gained
a `delegationKind: "native-gen" | "iterable"` discriminator; `delegationSites` /
`delegationSlots` / `NativeGeneratorInfo.delegationSlots` carry the kind;
`emitYield` routes a numeric-iterable `yield*` to the iterable kind
(`isNumericIterableDelegate` + `elementTypeOfIterable`); the struct builder types
an iterable slot as `externref` and `compileNativeGeneratorFunction` nulls it
with `ref.null.extern`. NOT DONE: the runtime yield-star "iterable" arm — must be
written per the corrected direct-vec approach above (the externref slot should
become a vec-ref + cursor instead, since the bridge is out). The native-gen arm
(slice-1) is complete and unchanged.

**Recommendation:** this is bigger than a half-day once the bridge is off the
table (needs the direct-vec drive + a 2-field/cursor slot). Best landed as its
own focused pass on top of merged #1502 with the corrected design. The
scaffolding compiles but the iterable runtime arm is unimplemented.
