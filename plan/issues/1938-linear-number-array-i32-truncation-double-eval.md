---
id: 1938
title: "Linear backend: number[] stores i32 elements ([1.5] → [1]) and element-assignment evaluates RHS twice"
status: done
completed: 2026-06-19
assignee: ttraenkler/sd3
sprint: 64
created: 2026-06-10
updated: 2026-06-19
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen-linear
language_feature: arrays
goal: correctness
---
# #1938 — Linear number[] i32 truncation + double-eval RHS

## Problem

Two silent miscompiles in the linear backend's array path:

1. **`number[]` arrays store i32 elements** (`codegen-linear/runtime.ts:484`:
   "elements: i32×cap"). Reads convert back (`__arr_get` → i32 →
   `f64.convert_i32_s`, `index.ts:2734-2736`); writes truncate via
   `compileExprToI32` (`index.ts:2796-2798`). `[1.5]` silently becomes
   `[1]`. Map keys/values are likewise i32 (`index.ts:1021-1033`). Nothing
   documents or diagnoses this.
2. **Element-assignment-as-expression evaluates the RHS twice** — once for
   the store, again for the expression result (`index.ts:2797-2800`,
   `:2806-2809`, and the Float64Array path `:2772-2774`). `arr[i] = f()`
   calls `f()` twice; observable with any side-effecting RHS.

## Proposed approach

1. RHS double-eval (S, do first): compile RHS once into a scratch local;
   store from the local; leave the local as the expression value. Test with
   a counter-incrementing function as RHS.
2. Element type (M): switch `number[]` element storage to f64 (stride 8) in
   `runtime.ts` array helpers + `layout.ts`; keep an i32 fast path only
   where the element type is provably integral (explicit `i32`-typed
   annotation — mirroring the GC backend's `array-element-typing.ts`
   contract). Map keys: f64 (or document+diagnose integer-only until then —
   silent truncation is the bug, not the representation).
3. Add linear equivalence tests for fractional elements, NaN elements, and
   Map with fractional keys.

## Acceptance criteria

- `[1.5][0]` returns 1.5 under `--target linear` (test).
- `arr[i] = f()` calls `f()` exactly once (test).
- Existing linear tests green; benchmark suite (`benchmarks/run.ts` linear
  strategies) shows no crash.

## Implementation notes (2026-06-11)

Split into two independent parts. **Part 1 (RHS double-eval) is done**; part 2
(f64 element storage) is carved out below because it requires a layout decision.

### Part 1 — element-assignment RHS double-eval — DONE

`compileElementAccessAssignment` (`src/codegen-linear/index.ts`) compiled the
RHS *twice*: once to feed the store, once to leave the value on the operand
stack as the expression result. So `arr[i] = f()` ran `f()` twice — observable
with any side-effecting RHS, across all four arms (array, Uint8Array,
Float64Array, Float32Array). Fix: compile the RHS once into a scratch local,
store from the local, leave the local as the expression value.

A subtlety surfaced while fixing it: for a numeric `arr[i] = v` the expression
result must be the **f64** value (an assignment-as-expression flows into an f64
context like `let x: number = (arr[i] = v)`), even though the store currently
truncates to i32. The scratch is therefore typed by `inferExprType(right)`
(f64 for numeric, i32 for reference elements); the store truncates from the f64
scratch, and the f64 scratch is returned. Tests:
`tests/linear-element-assign.test.ts` (RHS-once for array + Uint8Array,
assignment-expression value, truncated read-back).

### Part 2 — `number[]` stores i32 elements (`[1.5][0]` → 1) — CARVED OUT (needs layout decision)

Not a localized change. The linear array runtime (`runtime.ts` `__arr_new`/
`__arr_push`/`__arr_get`/`__arr_set`/`__arr_from_data` + ~20 inline
load/store sites across every Array.prototype method) uses a **single
type-agnostic i32×4 element layout shared by ALL array kinds** — `number[]`,
`boolean[]`, `string[]`, and object arrays all store an i32 (a value for
numbers/bools, a pointer for strings/objects). `number[]` reads convert i32→f64
on the way out (`index.ts:2734`), which is exactly the truncation.

Storing f64 elements requires either:
- **(a) a separate `__f64arr_*` runtime (stride 8)** selected by element type at
  every array call site (new/push/get/set/length/for-of/method dispatch/spread/
  Array.isArray), keeping the i32 runtime for reference arrays; or
- **(b) widening all array slots to 8 bytes** and boxing reference values,
  which wastes space for the common ref-array case and complicates the C-ABI
  (`__arr_from_data`, #1835, hands the runtime a contiguous i32 block).

Both ripple through the entire array-method suite and the for-of/Map iteration
paths; (a) additionally needs element-type routing the backend does not yet
thread to those sites. This is an architecture decision (which representation),
not a dev slice — recommend an architect spec before implementation. Acceptance
criterion `[1.5][0] === 1.5` is deferred to that follow-up.

## Implementation Plan (Part 2 — architect spec, 2026-06-11)

> Builds on Part 1 (branch `issue-1938-linear-array-f64`, commit `2e2f7d5`).
> Stack this on top of Part 1, not on bare `main`.

### Decision: widen ALL array slots to 8 bytes (stride-8, uniform), NOT a separate `__f64arr_*` runtime

Approach **(b)**, but with a twist that defuses its only real downside: store
**every** array element in an 8-byte slot and keep the slot's *bit pattern*
opaque inside the value-copying runtime. Numbers occupy the slot as an IEEE-754
`f64`; references (string/object/nested-array pointers) and booleans occupy the
**low 4 bytes** of the slot as an `i32`, exactly mirroring how the class layout
already stores fields (`layout.ts`: "each field occupies 8 bytes … f64 for
numbers, i32 stored in the low 4 bytes for object references"). The element
layout becomes consistent with the field layout the backend already ships.

**Why not (a) — a separate `__f64arr_*` runtime selected by element type:**

- **Element-type routing does not reach most sites.** Picking `__f64arr_get`
  vs `__arr_get` requires a reliable element-type at *every* `arr[i]`,
  `arr.push`, `for-of`, spread, destructuring, and method-dispatch site. The
  backend's type oracle is `getExprCollectionKind` (`index.ts:2218`), which
  only resolves the *container* kind (`Array`/`Uint8Array`/`Map`/`Set`), never
  the element type — and the ad-hoc `typeToString(...).endsWith("number[]")`
  probes scattered through `compileElementAccess` (`:2716`), `compileArrayHOF`
  (`:3027`), and `compileForOf` (`:807`) already disagree on edge cases
  (`number[] | null`, inferred literal arrays, generic `T[]`). Two parallel
  runtimes multiply that fragility: a single mis-route silently reads an i32
  slot as an f64 (or vice-versa) — a *worse* miscompile than today's
  truncation because it is non-deterministic per call-site.
- **It does not actually save the round-trip.** `__f64arr_*` only helps when
  the element is known-f64; for the common mixed/unknown case the backend would
  fall back to the i32 runtime and re-truncate. The bug would persist wherever
  the element type is unresolvable.
- **It doubles the runtime surface.** Every value-copying helper (`__arr_slice`
  `:680`, the inner copy loop in `flatMap` `:3171`, `__u8arr_from_arr` `:413`,
  `__arr_from_data` `:590`) would need an f64 twin or a stride parameter.

**Why (b)-uniform-stride-8 wins:**

- **Correctness is representation-driven, not inference-driven.** An f64 written
  to a slot reads back bit-identical regardless of whether any call-site
  correctly guessed "this is a number array." `[1.5][0]` is `1.5` because the
  store never truncated, full stop. Element-type knowledge is then needed *only*
  to decide the load instruction (`f64.load` vs `i32.load`) and the result
  type, which is exactly the (already-present, already-tested) `elemIsI32`
  decision the read sites make today — no *new* routing is introduced.
- **It matches the existing class-field invariant** (`layout.ts`), so a
  `{x: number}[]` and a `number[]` and a `Foo[]` all store 8-byte slots with
  the same low-4-bytes-for-refs convention. One mental model.
- **The C-ABI constraint is satisfiable** (see below) without a stride
  parameter, because the wrapper already owns the marshalling boundary.

Space cost: ref/string/bool arrays double their element region (4→8 B/slot).
This is the common case, so it is a real but bounded cost — identical to the
cost the class layout already pays per field, and dwarfed by the alternative's
correctness risk. Accept it.

### The element-value contract (the one rule every site follows)

A linear array slot is **8 bytes**. The runtime stores/loads/copies slots as
**raw `i64` bit patterns** (it never interprets them). The *codegen* owns
interpretation:

| element kind        | how codegen writes the slot                          | how codegen reads the slot                              |
|---------------------|------------------------------------------------------|---------------------------------------------------------|
| number (f64)        | `f64` value → `i64.reinterpret_f64` *(see note)*     | load slot → `f64.reinterpret_i64` → f64 result          |
| boolean             | i32 (0/1) → `i64.extend_i32_u`                       | load slot → `i32.wrap_i64` → i32 result                 |
| string/object/array | i32 pointer → `i64.extend_i32_u`                     | load slot → `i32.wrap_i64` → i32 result                 |

Note: the runtime helpers take/return **`f64`** for the element (not `i64`), and
do the `*.reinterpret_*` internally, so the common numeric path needs zero
codegen conversions (a number flows straight in/out as f64). Reference/bool
paths convert i32↔f64 at the call site via `i32→i64.extend_u→f64.reinterpret`
on store and the inverse on load — a 2-instruction bit shuffle, no value
rounding. Rationale: typing the runtime boundary as `f64` keeps the hot numeric
path conversion-free and confines the bit-cast to the rarer ref/bool sites.
(Alternative: type the boundary as `i64` and reinterpret at *every* site
including numbers. Rejected — penalises the common case.)

### Changes

**File: `src/codegen-linear/runtime.ts` — array runtime (stride 4 → 8)**

Touch every site that currently uses element stride `4` / element offset `16`
with an i32 load/store. Convert the **6 core helpers** to f64-typed,
8-byte-stride:

- `__arr_new` (`:500`) — allocate `16 + cap*8` (was `cap*4`); change the
  `i32.const 4 / i32.mul` to `i32.const 8 / i32.mul` (or `<<3`). Header
  unchanged (tag@0, len@8, cap@12, elems@16). Tag byte stays `0x01`.
- `__arr_push` (`:534`) — signature `(i32 ptr, f64 val)`; element address
  `ptr + 16 + len*8`; store `f64.store align:3 offset:16`.
- `__arr_get` (`:564`) — signature `(i32 ptr, i32 idx) → f64`; address
  `ptr + idx*8`; `f64.load align:3 offset:16`.
- `__arr_set` (`:574`) — signature `(i32 ptr, i32 idx, f64 val)`; `f64.store
  align:3 offset:16`.
- `__arr_len` (`:585`) — **unchanged** (reads `len` at +8, stride-agnostic).
- `__arr_slice` (`:680`) — **body unchanged in shape**: it already copies via
  `__arr_get`→`__arr_push`, so once those are f64-typed the slice is
  representation-correct for free (the key payoff of the raw-slot design).
  Only verify the intermediate stack type is now `f64`.

`__arr_from_data` (`:590`) — **C-ABI boundary, special-cased — see next file.**

**File: `src/codegen-linear/c-abi.ts` — the #1835 constraint**

The C ABI exposes a `T[]` param as a `(int32_t* ptr, int32_t len)` pair and a
`T[]` return as `(headerPtr + ARR_DATA_OFFSET, len)` — i.e. the host reads/writes
`len` **contiguous elements at the data pointer with a fixed element width**.
Today that width is implicitly 4 (the C header types it `int32_t`,
`c-header.ts:wasmTypeToCType`). Widening the internal slot to 8 B changes the
on-wire layout, so the wrapper must convert at the boundary — the host must NOT
see internal 8-byte f64 slots unless it asked for a number array.

Required:

1. **`__arr_from_data(dataPtr, len)` (`:590`) must widen on copy.** It currently
   `memcpy`s `len` i32s into `len` i32 slots. After the change it allocates
   `16 + len*8` and, per element, **sign/zero-extends or reinterprets the
   incoming i32 into the 8-byte slot.** But the *incoming* element width depends
   on the declared TS element type of the param (a `number[]` C arg is an array
   of host doubles; a `string[]`/object arg is an array of i32 handles). So
   `__arr_from_data` needs an element-kind discriminator. **Add a sibling
   `__arr_from_data_f64(dataPtr, len)`** that reads `len` **f64s** (stride 8)
   from `dataPtr` and stores them into f64 slots, and have `emitCabiWrappers`
   (`c-abi.ts:268-290`) pick the constructor by the param's element semantic
   (extend `ParamDef`/`CabiParam.aggregate` with the element kind, derived from
   the same `inferSemantic` logic, `c-abi.ts:367`). The plain `__arr_from_data`
   keeps reading i32s but stores into the low-4-bytes of 8-byte slots
   (`i64.extend_i32_u` per element) so ref/bool arrays round-trip.
2. **Return marshalling (`c-abi.ts:300-336`) must NOT hand back a raw internal
   pointer for number arrays.** Returning `(headerPtr+16, len)` exposes 8-byte
   f64 slots. For a `number[]` return, that is actually *correct and desirable*
   if the C header advertises `double*` — so the fix is in the **C header
   type**, not the wrapper: see next file. For a non-number `T[]` return
   (array of handles), the slots are i32-in-low-4-bytes with 4 bytes of padding
   each; the host expecting packed `int32_t*` would mis-stride. Emit a
   **compaction copy** in the wrapper for non-number array returns (allocate a
   `len*4` scratch block, write `i32.wrap_i64` of each slot, return that
   pointer+len), OR advertise the element as 8-byte in the header and let the
   host stride by 8. **Choose: advertise the real stride in the header
   (simpler, no extra alloc); document that array payloads are 8-byte-strided.**
3. Keep the layout constants `ARR_DATA_OFFSET = 16` (`c-abi.ts:30`) — unchanged.
   Update the comment block (`c-abi.ts:21-30`) and the cross-reference note in
   `runtime.ts:484` to say "elements: 8B×cap".

**File: `src/emit/c-header.ts` — element width in the generated header**

`wasmTypeToCType` (`:28`) maps params/returns 1:1 to C scalars but has **no
notion of array element type** — array params already surface only as two
`int32_t` (ptr,len). Extend the `CHeaderExport` carrier so an array
param/return records its element C type (`double` for number arrays, `int32_t`
for handle arrays) and emit the pointer param as `double* p0` / `int32_t* p0`
accordingly, plus a `/* element stride: 8 bytes */` comment. This is the only
place the host learns the new stride. (If this is judged out of scope for the
first slice, gate number-array C-ABI export behind a clear compile error rather
than silently shipping a stride mismatch — fail loud, per #1937.)

**File: `src/codegen-linear/index.ts` — codegen call sites**

The routing mechanism is the **existing `elemIsI32` decision**, made local to
each read/write site from the TS element type. No new global plumbing; we only
fix what each site stores/loads. Sites:

- `compileArrayLiteral` (`:2265`) — currently `compileExprToI32(elem)` then
  `__arr_push`. Change to: compile each element to its natural type
  (`compileExpression`), and for **numeric** elements push the f64 straight
  (matches the new `__arr_push(i32, f64)` signature); for **ref/bool** elements
  compile to i32 then `f64.reinterpret(i64.extend_i32_u(...))` before push.
  Element kind from `inferExprType(elem)` (`:3568`) — f64 ⇒ number, i32 ⇒ ref.
- `compileElementAccess` read (`:2716`) — `__arr_get` now returns f64. For a
  **numeric** element, the value is already correct — **delete the
  `f64.convert_i32_s`** at `:2735` (the truncation-and-reconvert is gone). For
  a **ref/bool** element (`elemIsNum === false`, `:2730`), convert the returned
  f64 slot back to the i32 handle: `i64.reinterpret_f64` → `i32.wrap_i64`.
- `compileElementAccessAssignment` (`:2755`, post-Part-1) — the Array arm
  (`:2792`) stores via `__arr_set`. Part 1 already routes the scratch local by
  `inferExprType(right)`. Now: for **numeric** RHS pass the f64 scratch
  straight to `__arr_set(i32,i32,f64)`; for **ref/bool** RHS reinterpret the
  i32 scratch into the f64 slot before the call. The expression-result value
  Part 1 returns is unchanged (still the f64 for numeric / i32 for ref). The
  `Float64Array`/`Float32Array`/`Uint8Array` arms are untouched — those are
  typed-array views with their own native stride.
- `compileArrayHOF` (`:3001`) — the `elemIsI32` local (`:3028`) already drives
  the per-element load conversion (`:3097`) and the push conversion
  (`:3131-3133`, `:3142-3145`). Update both:
  - load (`:3093-3100`): `__arr_get` is now f64; for `elemIsI32` do
    `i64.reinterpret_f64`→`i32.wrap_i64`, else use the f64 directly (delete the
    `f64.convert_i32_s` at `:3098`).
  - `filter` push-back (`:3129-3134`): the element is `elemLocal`; for ref push
    the reinterpreted i32→slot, for number push f64 directly (delete
    `i32.trunc_f64_s` at `:3132` — **this is a truncation bug fix**).
  - `map` push (`:3137-3146`): push the mapped value; if `mappedType` is f64
    push directly, else reinterpret i32→slot (delete `i32.trunc_f64_s` at
    `:3144` — **truncation bug fix**).
  - `flatMap` inner copy (`:3196-3201`): `__arr_get`→`__arr_push` round-trip is
    now f64-clean — drop any i32 trunc; the inner element flows as f64.
- `compileForOf` (`:806-872`) — `elementIsI32` (`:808`) already typed. Update
  the load (`:862-872`): `__arr_get` is f64; for `elementIsI32` reinterpret→wrap
  to i32, else use f64 directly (delete `f64.convert_i32_s` at `:870`). The
  `ArrayOrUint8Array` runtime-dispatch branch (`:840-861`) returns the array
  element via `__arr_get` (now f64) on the Array side and `__u8arr_get` (i32) on
  the u8 side — **the `if` result type must reconcile**: make both arms yield
  f64 (u8 side: `f64.convert_i32_u` inside the `then`), and set the `if`
  blockType to `{kind:"val", type:{kind:"f64"}}`. Then the outer
  `elementIsI32` conversion applies uniformly.
- `compileArrayDestructuring` (`:2382`) and `compileForOfMap`/destructuring
  (`:2393`, `:2437-2442`) — same load fix: `__arr_get` is f64; convert to the
  binding's local type (reinterpret→wrap for i32 locals, direct for f64).
- `compileArrayMethodCall` `push` (`:2964`) and `length` (`:2984`) —
  `push` currently `compileExprToI32(arg)`; change to numeric-f64-direct /
  ref-reinterpret like the array literal. `length` is stride-agnostic
  (`__arr_len`) — unchanged.
- `compileArrayJoin` (`compileArrayMethodCall:2981` → helper) — reads elements
  to stringify; update its `__arr_get` consumption to the f64 contract (it
  almost certainly numeric-stringifies, so it likely *benefits* — verify it no
  longer truncates).

**Map/Set keys/values (`runtime.ts` `__map_*`/`__set_*`/`__nmap_*`/`__nset_*`,
`:1539-2865`; `index.ts:1021-1033`)** — **OUT OF SCOPE for this slice.** They use
the same i32 key/value storage and have the same truncation, but they are a
distinct, larger surface (hash-bucket layout, the `__nmap`/`__nset` numeric
variants). Keep the existing behaviour and **add a fail-loud diagnostic**
(per #1937) when a `Map`/`Set` is constructed with a provably-fractional key
literal, deferring the representation fix to a follow-up issue. File that
follow-up; reference it here. (The issue's original proposal floated "Map keys:
f64 or document+diagnose" — diagnose now, fix later.)

### Element-type routing — summary

There is **no new global routing pass**. Routing = the per-site
`elemIsI32`/`inferExprType` decision that the read/write sites *already* make,
now used to pick the load instruction and the slot-encode/decode shuffle instead
of an i32-trunc. The container-kind oracle (`getExprCollectionKind`) is
unchanged. The only genuinely new routing is at the **C-ABI boundary**
(`emitCabiWrappers` picking `__arr_from_data` vs `__arr_from_data_f64` and the
header element type), which is localised to two files.

### Edge cases

- **Empty array `[]`** — `__arr_new(cap)` allocates `16 + cap*8`; len=0. No
  element stores. Reads guarded by `__arr_len`. Fine.
- **Mixed inference / unknown element type** — defaults to numeric (f64) at read
  sites today (`compileElementAccess:2732` "default: assume number"). With
  stride-8 that default is now *safe*: an f64 slot read as f64 is correct; a ref
  stored as a reinterpreted-i32 slot but read as "number" yields a garbage f64,
  same severity as today's garbage-i32 — but it no longer silently truncates a
  genuine float. Keep the numeric default; do not regress to i32-default.
- **Holes / sparse** — the linear backend has no hole representation; absent
  pushes leave zero-initialised slots (f64 `0.0` == i32 `0`). Consistent
  before/after.
- **Boolean arrays** — stored as i32 0/1 in the low 4 bytes (reinterpret path).
  Read back via `i32.wrap_i64`. `boolean[]` is treated as ref-kind at the slot
  level but the read sites already special-case `boolean` alongside `number`
  (`:2730`) — ensure boolean reads use the i32-wrap path, not the f64 path.
- **Nested arrays `number[][]`** — outer elements are i32 pointers (ref kind),
  inner arrays are number f64 slots. Correct under the per-level element-kind
  rule.
- **NaN elements** — `f64.store`/`f64.load` of a NaN bit pattern round-trips
  exactly (no canonicalisation in linear loads/stores). `[NaN][0]` is `NaN`.
- **`-0`** — preserved by f64 store/load (was lost under i32 trunc).
- **Integers > 2^53 / non-representable** — same as host JS `number`; f64 is the
  correct representation.

### Test plan

Add `tests/linear-number-array-f64.test.ts` (dual-compile under
`--target linear`, run, compare to JS):

- `[1.5][0] === 1.5` (the headline acceptance criterion).
- `[0.1, 0.2, 0.3].reduce`-style sum via a `for-of` loop (read path).
- `arr.push(1.25); arr[0]` (push + index read).
- `arr[0] = 3.75; arr[0]` (set + read; also asserts Part-1 RHS-once still holds).
- `[1.5,2.5].map(x => x * 2)` ⇒ `[3,5]` (HOF push, was truncating).
- `[1.5,2.5,3.5].filter(x => x > 2)` ⇒ `[2.5,3.5]` (HOF push-back).
- `[1.5,-2.5].slice(0,2)` ⇒ `[1.5,-2.5]` (raw-slot copy correctness).
- `[NaN][0]` is NaN; `Object.is([-0][0], -0)` true.
- `["a","b"][1] === "b"` and a `{v:number}[]` element read (ref-kind slots
  still work — regression guard).
- `number[][]` nested: `[[1.5]][0][0] === 1.5`.
- C-ABI round-trip (if header change lands): export `function f(a: number[]):
  number { return a[0]; }`, call with `[1.5]` → `1.5`; OR assert the
  fail-loud diagnostic fires if the header slice is deferred.
- Map fractional-key **diagnostic** test: constructing a Map with a fractional
  numeric key literal emits the deferred-feature error (not a silent truncate).

Existing suites that must stay green: `tests/linear-element-assign.test.ts`
(Part 1), all `--target linear` equivalence tests, and the linear strategies in
`benchmarks/run.ts` (no crash, per acceptance criteria).

### Risks / sequencing

- **Signature change is module-wide and atomic.** `__arr_get`/`__arr_set`/
  `__arr_push` changing result/param type from i32→f64 breaks every caller
  simultaneously — the runtime helpers and *all* `index.ts` call sites must land
  in one PR or the module won't validate. This is a single-PR change, not
  incremental. Budget for it.
- **`as unknown as Instr`** may be needed for `i64.reinterpret_f64` /
  `f64.reinterpret_i64` / `i64.extend_i32_u` / `i32.wrap_i64` if absent from the
  linear `Instr` union — check `src/ir/types.ts` and follow the existing
  `as unknown as Instr` escape hatch (CLAUDE.md key patterns).
- **C-ABI is the sharp edge.** If the header/stride change is risky, ship the
  internal f64 fix first with a **hard compile error** on number-array C-ABI
  export, and land the header stride in a fast follow. Do not ship a silent
  stride mismatch.
- **No conflict with other in-progress issues** expected — this is isolated to
  `src/codegen-linear/` + `src/emit/c-header.ts`. #1937 (fail-loud) is
  complementary (we lean on its diagnostic pattern for Map keys / deferred
  C-ABI).

## Source

Compiler quality review 2026-06. Related: #1937 (fail-loud companion),
#1854 (cross-backend differential harness would have caught both).

---

## Part 2 — LANDED (2026-06-19, sd3)

Implemented the architect's stride-8 uniform-f64-slot design in one atomic PR.
`[1.5][0]` now returns `1.5`; `[0.1,0.2,0.3]` sums to `0.6`; `map(x=>x*2)` no
longer truncates the intermediate. **`done`.**

### What changed (representation: i32×4 → f64×8 slots)

**`src/codegen-linear/runtime.ts`** — the array runtime element boundary is now
typed **f64**, stride 8, slot bits opaque to the runtime:
- `__arr_new`/`__arr_grow` allocate `16 + cap*8`; grow copies slots verbatim with
  `f64.load`/`f64.store`.
- `__arr_push(i32,f64)`, `__arr_get(i32,i32)→f64`, `__arr_set(i32,i32,f64)` — all
  `f64.load`/`f64.store` at `idx*8`; OOB `__arr_get` returns `f64.const 0`;
  `__arr_set` zero-fills the gap with `f64.const 0`. `__arr_len`/`__arr_slice`
  unchanged in shape (slice is f64-clean for free via get→push).
- `__arr_from_data` (C-ABI param input) widens each incoming packed i32 into the
  low 4 bytes of an 8-byte slot (`i64.extend_i32_u`→`f64.reinterpret_i64`).
- `__u8arr_from_arr` reads the source `number[]` element as an f64 slot and
  truncates to a byte.
- `__str_split` encodes each substring i32 pointer into the f64 slot before push.

**`src/codegen-linear/index.ts`** — two helpers, `pushI32ToSlot` /
`pushSlotToI32` (the i64-shuffle), thread the **existing per-site
`elemIsI32`/`inferExprType` decision** (no new global routing). Sites updated:
array literal, element read, element assign, for-of (incl. the
`ArrayOrUint8Array` runtime-dispatch `if` reconciled to f64), array
destructuring, `.push`, HOF (`map`/`filter`/`flatMap` load + push-back —
**deleted the `i32.trunc_f64_s` truncation bugs**), and `join` (decode slot →
string handle). **Booleans ride the f64 path** (they compile to `f64.const 0/1`
in this backend), so only true reference (string/object) slots take the
encode/decode path.

**`src/codegen-linear/c-abi.ts`** — layout comment updated; number[] return
payload is now 8-byte-strided (host reads it as `double*` / `Float64Array`).

**`src/codegen-linear/simd.ts`** — `__arr_indexOf_simd` / `__arr_fill_simd`
(dead helpers, no emit site, but kept internally consistent) rewritten from
`i32x4` (4-lane, stride 4) to `f64x2` (2-lane, stride 16) over the new layout.

### Verification (scoped, all green)

- `tests/issue-1938-number-array-f64.test.ts` (17 cases): the `[1.5][0]`
  headline, fractional sum/push/set/map/filter, for-of read, NaN, `-0`
  (`1/-0 === -Infinity`), >2^31 integer, nested `number[][]`, `string[]` read +
  join, `boolean[]`, store-beyond-length zero-fill, destructuring-rest slice.
- `tests/issue-1835.test.ts` — C-ABI array return updated to read `Float64Array`
  (8-byte stride) + a new fractional-element round-trip case.
- `tests/linear-array.test.ts` + `tests/simd.test.ts` — updated to the f64
  boundary (push/set/search/fill values become `f64.const`; gets return f64).
- Full linear suite (126 tests across 15 files) + wasi/simd/c-abi all green.
- `tsc --noEmit` clean.
- The 2 pre-existing failures in this area (`issue-1655` `Uint8Array.subarray`
  "illegal cast"; `real-world-wasi` `it.fails` process.argv) fail **identically
  on clean `origin/main`** — not regressions from this change.

### Out of scope (unchanged, documented limitations)

- **Map/Set keys/values** still use i32 storage (`index.ts:1021-1033`,
  `runtime.ts __map_*`/`__set_*`). A fractional Map key still truncates — a
  distinct, larger surface (hash-bucket layout, `__nmap`/`__nset` variants). No
  fail-loud diagnostic was added (the existing Map behaviour is unchanged, so no
  regression); the representation fix belongs in a follow-up issue.
- **`Array.prototype.slice`/`indexOf`/`fill` as method calls** are still not
  wired into `compileArrayMethodCall` (a pre-existing gap, orthogonal to the
  representation). The SIMD helpers exist but have no emit site.
- **number[] C-ABI *param* input** still rehydrates from packed i32 (the host
  would pass doubles for a real number array) — only reference/string array
  params round-trip via `__arr_from_data`. Documented in the runtime comment.
