---
id: 2173
title: "standalone: yield* over a general iterable (array / custom {next()}) in native generators (SF-3 slice-2 of #2157)"
status: done
completed: 2026-07-04
assignee: ttraenkler/dev-selfserve-1
blocked_by: []
sprint: current
created: 2026-06-16
updated: 2026-07-04
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

# #2173 — yield\* over a general iterable (SF-3 slice-2 of #2157)

## Problem

#2170 (slice-1) landed `yield* <native-generator-call>` — delegation to an
inner native generator by driving its `__gen_resume_<inner>`. The remaining,
larger case is delegation to an **arbitrary iterable**: an array literal, a
canonical-vec value, or a custom `{ [Symbol.iterator]() { return { next() {…} } } }`.

```ts
function* g() {
  yield* [1, 2, 3];
  yield 4;
} // standalone: #680 CE today
export function test(): number {
  let s = 0;
  for (const x of g()) s += x;
  return s;
} // want 10
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
  imports. The bridge is for the _generic/escaped_ iterable case, not numeric
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

## Re-scope + unblock (fable-gencarrier, 2026-07-04)

**Slice-2a (numeric arrays/vecs via the direct-vec cursor) is NOT #2106-blocked**
— the corrected design above never boxes: the cursor reads `vec.data[idx]` as
f64 directly. Only the GENERIC escaped-iterable arm (custom `{next()}` objects,
whose `value` rides externref and whose "missing value" needs a real undefined
representation) has the #2106 value-rep dependency. Frontmatter unblocked
accordingly; the generic arm is re-sliced as 2b below and carries the
dependency inline.

Fresh context to build against (all landed since the 2026-06-16 note):

- The `yield-star` terminator now carries `bindResultTo` (#2864 R1) — the
  done-arm of a delegation site delivers the completion value into a typed
  spill. The iterable arm's done-arm must do the same (an array's completion
  value is `undefined`; a custom iterator's is the `value` of its
  `done:true` result).
- **Latent-bug guard (#2864 R1)**: the delegation yield-arm re-yields raw f64
  through the OUTER result struct; a string-carrier outer is bailed
  (`elemIsString` gate in `emitYield`) because no fixups.ts repair exists for
  f64→concrete-ref. The iterable arm MUST keep that gate; the boxed-any outer
  works via the f64→externref `__box_number` repair, but prefer an explicit
  conversion over relying on the repair pass for NEW emission.
- The scaffolding described below (delegationKind discriminator) was never
  merged — branch `issue-2173-general-yield-star` predates F1/F1b/F2 and the
  #1916-S3b/#2941 funcIdx-discipline changes. Re-derive the small parts (kind
  tag on `delegationSites`/`delegationSlots`) fresh on current main rather
  than resurrecting the branch.

### Slice 2a contract (numeric array/vec — dispatchable now)

1. Plan: in `emitYield`'s asterisk branch (generators-native.ts), when
   `nativeGeneratorDelegationName` returns undefined, try
   `isNumericIterableDelegate(subject)`: an array literal / identifier whose
   static type resolves to the numeric canonical vec. Tag the site
   `kind: "vec"`.
2. Struct: a vec-site's slot is TWO fields appended like today's deleg slots:
   `ref null $F64Vec` + `mut i32` cursor (offset discipline identical to
   spills — see `delegationSlots` in `buildResumeInfo`).
3. Emit (yield-star arm, vec kind): first entry materializes the vec
   (`compileExpression(subject)` → vec ref) into the slot, cursor=0. Each
   entry: `idx >= vec.length` → done-arm (bindResultTo delivers the f64
   undefined sentinel; document the #2106 residual exactly as R1 did);
   else read `vec.data[idx]`, `idx++` (struct.set), re-yield staying in this
   state. No boxing anywhere; outer f64 exact, any-outer boxes via the same
   seam as R1 (explicit `__box_number` union-native preferred).
4. Tests: `yield* [1,2,3]; yield 4` for-of sum 10 (the B1 probe); vec via
   variable; `const x = yield* [1,2]` binding; zero-length array (straight to
   successor, no suspension from the vec); byte-hash matrix unchanged for
   non-yield\*-programs.

### Slice 2b (generic `{next()}` / escaped iterable — carries the #2106 dependency inline)

Drive the #1320 `__iterator`/`__iterator_next` bridge from an externref slot
as originally designed, but ONLY for subjects that are not native-vec/native-
gen; unbox via the union-native `__unbox_number` (standalone-defined) for f64
outers, pass through for any-outers. `.return()` close forwarding must reuse
the #2864 D2 abrupt-forwarding shape (write mode/error into the inner record,
drive once, discard) — do not invent a second close path. Blocked-by-#2106
only for undefined-observability of the final `value`; everything else is
buildable.

## Slice 2a LANDED (opus-2173, 2026-07-04)

Implemented exactly per the banked vec-cursor contract — the contract held on
contact against current main (no re-derivation needed beyond the fresh
delegation-kind scaffolding, which the note said to re-derive). Standalone
`yield* [1,2,3]` now lowers host-free via a direct vec cursor.

### Design (as shipped)

- The `yield-star` state terminator became a discriminated union
  `delegationKind: "native-gen" | "vec"`. The native-gen arm (#2170 slice-1) is
  **byte-identical** — the vec arm is a new branch keyed off the discriminant.
- `emitYield`'s asterisk branch, when `nativeGeneratorDelegationName` returns
  undefined, tries `isNumericIterableDelegate(subject)` — true iff the subject's
  static type resolves (via `resolveArrayInfo`) to a numeric canonical vec
  (`elemType.kind === "f64"`). Array literals of numbers and `number[]`-typed
  identifiers/params qualify; `arr.values()` iterators and custom `{next()}`
  objects do NOT (they stay slice-2b). Same `elemIsString`-outer bail as R1.
- Per vec site: TWO state-struct fields appended AFTER the native-gen
  delegation slots (so `spillFieldOffset` and native-gen slot indices are
  unaffected — byte-inert for non-vec-delegating generators): `ref null $Vec` +
  `i32` cursor, both resolved/typed once in `buildResumeInfo` and stored on
  `NativeGeneratorInfo.vecDelegationSlots`.
- Runtime arm: first entry materializes the vec (`compileExpression(subject)`,
  evaluated ONCE — GetIterator semantics) into the slot and resets cursor to 0;
  each entry reads `vec.data[cursor]` (already f64, **no box**), `cursor++`,
  re-yields staying in this state; on `cursor >= vec.length` nulls the slot
  (so a `yield*` inside a loop re-iterates), delivers the `bindResultTo`
  completion value (undefined-as-NaN sentinel, #2106 residual — not asserted),
  and transitions to the successor. **Zero host imports** — the #1320
  `__iterator` bridge is deliberately unused (it would leak
  `__box_number`/`__unbox_number`).

### Files

- `src/codegen/generators-native.ts` — union terminator, `vecDelegationSites`
  in the plan, `isNumericIterableDelegate`, vec branch in `emitYield`, vec
  slots in `buildResumeInfo`, vec `struct.new` inits, and the runtime vec-cursor
  arm in `compileState`.
- `src/codegen/context/types.ts` — `NativeGeneratorInfo.vecDelegationSlots`.
- `tests/issue-2173-yieldstar-array.test.ts` — 12 standalone cases, all assert
  zero host imports.

## Test Results (opus-2173, 2026-07-04)

**Measure-first (current main):** standalone `function* g(){ yield* [1,2,3]; yield 4 }`
→ CE #680; wasmgc → host-buffer path (`__gen_*` imports). After: standalone → 0
host imports, for-of sums to 10, `[...].next()`-sequence yields 1,2,3,4.

- **New suite** `tests/issue-2173-yieldstar-array.test.ts` — **12/12 pass**
  (for-of sum, delegation-only, next-sequence, vec-via-variable, vec-via-param,
  two sequential sites, yield\* in a loop, own-yield-before, `const x = yield*`
  binding, zero-length typed vec, element count, plain-numeric regression).
- **Blast radius (no regression, 90 tests):** generators (32), #2170 slice-1 (6),
  #2171 string yields (7), #2864 carrier F1/F1b/F2 (all), #1665 (3), #2079 (all),
  #1017 (all), #2169 spread/destructure/arrayfrom (all), #2172 nested. Plus the
  adjacent-machinery batch (#2157/#2571/#2892/#3032/method-destructuring).
- **Byte-inertness:** js-host (wasmgc) generators are unchanged (the native path
  is gated `noJsHostTarget`); the native-gen delegation arm and numeric/string
  carriers are byte-identical (their regression tests pass).

### Known narrow limitation

An **untyped** empty array literal `yield* []` (TS type `never[]`, no numeric
vec) cleanly bails to the host path (standalone: the #680 refusal — same as
before, no regression). The runtime "straight to successor, no suspension" path
IS exercised and passes for typed empties (`const a: number[] = []; yield* a`
and `yield* ([] as number[])`). Non-numeric-elem iterables (strings, objects,
`.values()` iterators, custom `{next()}`) are slice-2b.

## Slice 2b LANDED (dev-selfserve-1, 2026-07-04)

Generic-iterable `yield*` — a `.values()`/`.keys()`/`.entries()` iterator or a
custom `{ [Symbol.iterator]() { return { next() {…} } } }` object — now lowers
host-free in standalone native generators. The remaining SF-3 gap in the issue's
title is closed.

### Design (as shipped) — drive the native iterator runtime, NOT the JS-host bridge

The banked 2b contract said to drive the #1320 `__iterator`/`__iterator_next`
bridge and unbox via "the union-native `__unbox_number` (standalone-defined)".
Re-grounding against current main clarified the mechanism precisely:

- In standalone the #1320 bridge IS host-free — `ensureNativeIteratorRuntime`
  (`iterator-native.ts`, #2038) registers `__iterator`/`__iterator_next` as
  **emitted Wasm** over a `$__IterRec` GC struct (VEC + USER `{next()}` arms, the
  USER arm filled at finalize over the module's closed-struct dispatchers). So the
  "bridge leaks host box/unbox" caveat from the 2a note applies only to the
  **JS-host** `__iterator` *import*, not the standalone-native runtime.
- The `yield-star` terminator gained a third `delegationKind: "iterable"` (beside
  `"native-gen"` and slice-2a's `"vec"`). The native-gen and vec arms are
  **byte-identical** (verified) — the iterable arm is a new branch keyed off the
  discriminant.
- Per iterable site: ONE `externref` state-struct field (the `$__IterRec`),
  appended AFTER the native-gen and vec slots so no earlier field index or the
  f64 `spillFieldOffset` moves (byte-inert for non-iterable-delegating
  generators). Nulled at construction; materialized lazily on first entry
  (`rec = __iterator(box(subject))`, GetIterator runs once).
- Runtime arm (`compileState`): each resume `(done,value) = __iterator_next(rec)`;
  while not done, unbox `value` (externref) to the OUTER element type — f64 outer
  via `coerceType(externref→f64,"number")` which selects the standalone-native
  `__unbox_number`, boxed-any outer passes through — build `{ value, done:0 }`,
  stay in the state; on done, null the slot, deliver the `bindResultTo` completion
  sentinel, transfer to the successor. STRING-element outers keep the 2a bail
  (concrete-ref `value`, no repair seam).

### Detection

`isGenericIterableDelegate` gates on the subject's TS type carrying a
`__@iterator`-prefixed member (the well-known `[Symbol.iterator]`), so only
genuine iterables are admitted (spec-aligned: `yield*` performs GetIterator).
Ordered AFTER `isNumericIterableDelegate` so numeric arrays keep the 2a vec
fast path.

### Files

- `src/codegen/generators-native.ts` — `"iterable"` terminator variant,
  `iterableDelegationSites` in the plan, `isGenericIterableDelegate`, the iterable
  branch in `emitYield`, iterable slots in `buildResumeInfo`, the null-extern
  struct init, and the runtime iterable arm in `compileState`.
- `src/codegen/context/types.ts` — `NativeGeneratorInfo.iterableDelegationSlots`.
- `tests/issue-2173-yieldstar-generic-iterable.test.ts` — 10 standalone cases,
  all assert zero host imports.

### Proofs

- **Measure-first (current main):** all four target shapes reject with the #680
  native-generator CE. After: compile + run correctly, **zero host imports**, on
  the native generator path (no `__gen_create_buffer`/`__create_generator`).
- **New suite (10/10):** `.values()` for-of sum, delegation-only, custom
  `[Symbol.iterator]` iterable, any-outer pass-through, yield\* in a loop
  (re-iteration), own-yield interleave, two sequential delegations, manual
  next()-sequence, element count, plain-numeric regression.
- **Blast radius (138 tests, no regression):** generators, #2170 slice-1, #2171
  string yields, #2172 nested, #2864 carrier, #1665, #2079, #2169
  spread/destructure/arrayfrom, #2571/#2581 method generators, #2920, #2951/#2952,
  and #2173 slice-2a.
- **Byte-inertness (sha256 identical to origin/main):** plain numeric generator,
  numeric-vec `yield*` (2a), native-gen `yield*` (2170), a for-loop generator, and
  a `.next(v)`-resume generator.

### Still deferred (roll forward — NOT this PR)

- String-element outers (concrete-ref `value`, no fixups repair seam).
- Precise `.return()`/`.throw()` close-forwarding into the iterator (reuse the
  #2864 D2 abrupt-forwarding shape) — the current arm iterates + closes on
  natural exhaustion; abrupt outer `.return()` does not yet forward into a
  mid-flight inner iterator.
- #2106 undefined-observability of the `yield*` completion value (`const x =
  yield* it`) — the done-arm delivers the outer's undefined sentinel (NaN / null-
  extern), not the iterator's actual done-result `value`.
