---
id: 6963
title: "standalone: `x[i] = v` on an untyped array receiver stringifies the index and stores through the descriptor overlay, making every later indexed read a string-keyed hash lookup (Octane navier-stokes 2 s/rep vs node 8 ms)"
status: ready
sprint: current
goal: standalone-gap
area: compiler
priority: high
horizon: m
feasibility: medium
# 2026-10-11 (Stage 1): the fast path belongs next to the overlay WRITE
# prologue it short-circuits (vec-overlay.ts) and the numeric vec arm it
# falls through to (object-runtime.ts fillExternSetVecArms); a new module
# would be outside the files this change was scoped to.
loc-budget-allow:
  - src/codegen/vec-overlay.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/assignment.ts
func-budget-allow:
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/object-runtime.ts::fillExternSetVecArms
---

# Problem

Octane **navier-stokes** on `--target standalone` is correct but takes
**~2.0 s per rep** (node: **8 ms/rep**, ~250x). Node calibrates 30 reps → 60 s;
with the fix below it should fit the 180 s budget comfortably, but parity needs
the follow-up in "Stage 2".

`node --cpu-prof` on `.tmp/navier-stokes.raw.wasm` (3 reps, 5.9 s):

| incl. % | self % | function | role |
|---|---|---|---|
| 44.3 | 31.6 | `__extern_get_idx` | dynamic indexed read (`x[currentRow]` in `lin_solve`) |
| 28.8 | 8.1 | `__extern_set` | dynamic indexed write |
| 20.4 | 3.2 | `__vec_dp_value` | descriptor-overlay define, called from `__extern_set` |
| 15.9 | 15.8 | `__sh_num_toString_radix` | **index → string** (via `number_toString`) |
| 8.5 | 4.3 | `__defineProperty_value` | from `__vec_dp_value` |
| 6.8 | 3.4 | `__obj_find` (+`__obj_hash`, `__strexo_hasown`, `__str_equals`) | string-keyed hash lookups |
| 8.3 | 8.3 | GC | boxed indices/values + strings |
| 5.7 | 5.7 | `lin_solve` | the arithmetic |

Hot paths (prof-paths): `__sh_num_toString_radix <- number_toString <-
__extern_get_idx <- lin_solve` (520 ms) and `__obj_find <- __vec_dp_value <-
__extern_set <- lin_solve`. The arrays are `new Array(size)` created in
`FluidField.reset()` and held in closure cells; `lin_solve(b, x, x0, a, c)`
receives them as untyped `externref` params, so every element access is
dynamic.

Reproduced in isolation (`.tmp/ns-probe.js`, `runB`: `[]`+push-built array,
1M iterations of `x[i] = x0[i] + 1.5; s += x[i]` through untyped params:
~800 ms, i.e. ~250 ns per element access; the same profile shape:
`__sh_num_toString_radix <- __to_property_key <- loop`, `__vec_dp_value <-
__extern_set <- loop`, `number_toString <- __extern_get_idx <- loop`). Holes
are irrelevant (`new Array(n)`, `[]`+push and `Float64Array` all behave the
same).

# Root cause (three links in one chain)

1. **Call site stringifies the numeric key.** The computed-store emitter
   (`src/codegen/expressions/assignment.ts` ~L6560–6600) evaluates the key to
   externref (boxing the f64 index to i31/`$box_number`) and then calls
   `emitToPropertyKeyOnce` → `__to_property_key`. `__to_property_key`
   (object-runtime.ts, body visible in `.tmp/ns-probe.full.wat`) turns an
   i31/boxed number into a **string** (`number_toString(__unbox_number(k))`).
   The same happens for compound stores (operator-assignment.ts L3585,
   computed-member-reference.ts L88). Reads use `__extern_get_idx(obj, f64)`
   and do NOT stringify.
2. **`__extern_set` misses its numeric vec fast arm.** `fillExternSetVecArms`
   (object-runtime.ts L578–880) is the fast path (`__unbox_number(key)` →
   in-bounds `array.set`), but it is only reached for a numeric key. The
   string key instead hits the overlay WRITE prologue spliced in front of it
   (vec-overlay.ts L2221–2630): `parseIndex(keyLocal)` recognises the canonical
   index string and, with no companion entry, calls
   `__vec_dp_value(recv, "123", v, SEED_FLAGS)` (L2568–2622 — the `(#2668)`
   comment there literally describes `var a = []; a[0] = 101`). That is a
   full `defineProperty`: `__vec_overlay_ensure` (linear table scan),
   `__defineProperty_value`, `__obj_find`/hash insert on the companion
   `$Object`, plus the write-through to the backing array (`.tmp/sp7.js`
   confirms typed reads see the value, so this is perf-only).
3. **The first such store poisons every indexed read in the module.**
   `__vec_dp_value` with a numeric key sets the overlay core's
   `numericFlagGlobalIdx` (vec-overlay.ts L236–246). From then on the
   `__extern_get_idx` read prologue (L2664–2833) does, for EVERY vec read:
   `__vec_overlay_lookup` (linear scan of the companion table) and, on a hit,
   `__obj_find(comp, number_toString(idx))` — a string allocation + hash
   lookup per read. (The flag exists precisely to keep the regexp result-array
   companions from taxing reads; the stringified-key store defeats it.)

## Implementation Plan

### Stage 1 — numeric keys take the numeric arm (fixes links 1–3; est. 3–5x)

**File: `src/codegen/expressions/assignment.ts`** (~L6560), and the twin
sites `operator-assignment.ts` ~L3585 / `computed-member-reference.ts` ~L88
(share one helper):

- When the key expression's static type is `f64`/`i32` (or the compiled
  `keyResult` is a number before boxing), **do not call `__to_property_key`**.
  ToPropertyKey of a Number has no observable side effects, so evaluation order
  (§13.15.2) is preserved. Pass the boxed number (i31 when integral — the
  existing box sequence already does this) straight to `__extern_set`; its
  numeric vec arm (`fillExternSetVecArms`) then does `unbox → bounds →
  array.set` without touching the overlay, and `numericFlagGlobalIdx` is never
  set in a module like this one. Non-vec receivers (`$Object`, closures,
  TypedArrays) already accept a numeric key in `__extern_set` (the body
  ToPropertyKeys the key itself at the string-keyed table — see the comment in
  `ensureDynMemberSet`, dyn-read.ts L884–888: that comment is the reason the
  call-site canonicalisation was added; verify the "receiver-specific early
  dispatch arms" it worries about by running the test262 `S15.4*`/`A15.4*`
  element-store families and `tests/issue-2666*`/`issue-2668*`).
- Better still, add `__extern_set_idx(externref obj, f64 idx, externref v)`
  mirroring `__extern_get_idx` (object-runtime.ts registers the trio; the doc
  at L789 already names `__extern_set_idx` as if it existed — it does not), so
  the key is never boxed at all; fall back to `__extern_set` with
  `__box_number(idx)` for non-vec receivers inside the helper.

**File: `src/codegen/vec-overlay.ts`** L2568–2622 (defence in depth): when
`parseIndex` yields an in-bounds canonical index on a vec whose companion has
no entry for it and `descriptorDecisionAvailable` is false, **fall through**
to the numeric arm instead of `__vec_dp_value(SEED_FLAGS)` — an ordinary set of
an existing dense element must not create a descriptor. Keep the dp_value
route for `i >= len` (new property / growth) and for deleted-index tombstones.

Also keep `__to_property_key`'s contract as is (many consumers assume a
string); do not change it.

### Stage 2 — typed carriers for numeric arrays reaching untyped params (parity; separate issue)

Even with Stage 1 every access is `externref` box/unbox + a `ref.test` ladder
(~100–150 ns). Node is 8 ms/rep because the arrays are f64 element stores.
Options, in order of leverage: (a) infer `__vec_f64` for `new Array(n)` whose
only writes are numbers (reset()'s fill loop) and specialise `lin_solve`/
`advect`/`project` on their vec param types (the fnctor/closure-cell param
inference from #6958 is the hook); (b) an `__extern_get_idx_f64`/`set_idx_f64`
pair that returns/takes raw f64 and only boxes on a non-numeric element. File
as a follow-up with its own measurement; expected to bring the rep to
~50–100 ms.

### Acceptance (Stage 1)

- `.tmp/ns-probe.js` `runB`/`runG` profile shows no `number_toString`,
  `__vec_dp_value` or `__obj_find` under `loop`; time ≤ 300 ms (from ~800).
- `node .tmp/run-raw.mjs .tmp/navier-stokes.raw.wasm 3` ≤ 600 ms/rep (from
  ~2000 ms).
- `pnpm run -s benchmark:octane -- --only navier-stokes --lanes node,standalone
  --timeout 600` → standalone `ok` at node-calibrated reps (30 × ≤ 0.6 s ≪
  180 s).
- No change in `tests/equivalence/` and the #2666/#2668 regression tests;
  gc lane byte-identical (standalone-only paths).

## Regression fix (2026-10-12): shortcut fired for carriers with no store arm

The merge queue parked #6643 (and #6650, #6639 and #6643's re-run, whose groups
all contained this branch) with the same 28 standalone test262 regressions,
bucket signature `f6493c3664245200`. Every row was an `assertion_fail`.

**Rows:** the standalone Temporal provider is the `@js-temporal/polyfill`
compiled by this compiler. 22 of the 68 baseline-passing
`built-ins/Temporal/**/order-of-operations.js` rows fail on the merge group
`f515aa8a80` and pass on main `a87e4b905a`, for example
`PlainDate/from/order-of-operations.js`. The run used the same QuickJS eval
provider and a freshly prewarmed standalone Temporal provider on both sides.
These rows read the property bag in source order rather than sorted order,
because `PrepareCalendarFields` does `const a = n.concat(r, i); a.sort();` and
the sort had no effect.

**Root cause:** `Array.prototype.concat` on an untyped receiver returns a
`$ObjVec`. `allowedCarriers` lists `$ObjVec` and `__regexp_match_vec`, so the
overlay WRITE prologue accepts them. Both #6963 shortcuts (the i31 fast set and
the two plain-overwrite fall-throughs) then `br` out to
`fillExternSetVecArms`'s numeric arm. That arm has `array.set` cases only for
the `ctx.vecTypeMap` carriers, so for a `$ObjVec` the store was silently
dropped. The runtime sort writes elements back through `__extern_set(arr, i31,
v)`, so the array stayed unsorted. The bug shows only when the module arms the
inherited-set descriptor decision, which the polyfill does.

**Fix:** `fillExternSetVecArms` records the carriers it gave a store arm
(`recordExternSetStoreCarriers`). `valueFitsCarrierInstrs` answers 0 for any
other carrier, which keeps them on the pre-#6963 `__vec_dp_value` path.
`__elem_store_key` keeps a numeric key only for those same carriers.
Regression rows: `tests/issue-6963-element-store-numeric-key.test.ts`, which
uses a tagged template to arm the gate. Two of those rows fail on the old head
and pass with the fix.
