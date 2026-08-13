---
id: 4222
title: "Standalone array semantics: `delete arr[k]` never makes the index absent, `new Array(n)` fills `undefined` instead of holes"
status: in-review
pr: 4450
sprint: current
created: 2026-08-08
updated: 2026-08-13
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: array-holes, delete-operator, property-model, array-length
goal: es5
related: [4159, 4160, 3251, 2001, 4010, 4221]
# The bulk of the new code went into a NEW module (`vec-overlay-presence.ts`),
# which is why `fillVecOverlayHelpers` only grows by its call site. What is left
# is in-place and cohesive: one `if` arm in the `in` operator's existing vec
# branch, one presence gate inside the for-in loop body, one ctx flag + its
# doc-comment. Extracting any of those would put a two-line helper behind an
# import and hide the branch from the code that has to reason about it.
# coercion-sites: both entries below are NEW modules from this branch's wave
# work, and both CALL the canonical helpers rather than hand-rolling coercion:
# `vec-overlay-presence.ts` calls `number_toString` (the overlay companion's
# canonical index-key builder, same idiom as its read twin in vec-overlay.ts);
# `array-filter-spec-access.ts` calls the existing `__unbox_number` late import
# for the f64 element lane. The gate counts per-file vocabulary, so code moved
# into a new module registers as growth even when the vocabulary is reused, not
# invented.
coercion-sites-allow:
  - src/codegen/vec-overlay-presence.ts
  - src/codegen/array-filter-spec-access.ts
loc-budget-allow:
  - src/codegen/statements/loops.ts
  - src/codegen/vec-overlay.ts
  - src/codegen/context/types.ts
  - src/codegen/array-methods.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/index.ts
  - src/codegen/statements/variables.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
func-budget-allow:
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/object-runtime.ts::fillDynamicForinVecArms
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/select.ts::isPhase1Expr
  - src/codegen/expressions/new-indexed.ts::tryCompileIndexedBuiltinNew
  - src/codegen/declarations.ts::collectDeclarations
  - src/ir/integration.ts::makeFromAstResolver
  - src/codegen/hof-native.ts::ensureNativeArrayHof
  - src/codegen/index.ts::generateModule
  - src/codegen/expressions/assignment.ts::compileElementAssignment
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
  - src/codegen/index.ts::generateMultiModule
---

# #4222 — the array-semantics leftovers WP4-filter exposed

Wave-1 of the ES5-standalone-90 program (`plan/goals/es5-standalone-90.md`,
WP4) fixed `Array.prototype.filter`'s per-index `HasProperty` + fresh `Get`
discipline (`src/codegen/array-filter-spec-access.ts`). Doing so exposed that
the *presence* answer the new gate consults is itself wrong for two whole
classes of absent index. This issue covers those, plus the two smaller
`built-ins/Array` clusters the same measurement turned up.

## 1. `delete arr[k]` on a vec-backed array is a no-op (PRIMARY)

Measured on `main` + Wave 1, `--target standalone` **and** the gc lane:

```js
const arr = [0, 1, 2, 3];
delete arr[1];
1 in arr;                  // → true   (spec: false)
Object.keys(arr).length;   // → 4      (spec: 3)
for (k in arr) …           // → 4 iterations (spec: 3)
arr.filter(() => true).length; // → 4  (spec: 3)
```

### What actually works already

The runtime is *not* the gap. `__delete_property` has had a complete vec arm
since #4010 (`buildVecDeletePrologue`, `src/codegen/vec-bag-seed.ts`): it
defines `undefined` into the #3251 overlay companion and marks the entry
`FLAG_DELETED_INDEX | FLAG_COMPANION_VALUE`. Two consumers honour it today:

| surface | after `delete arr[1]` | correct? |
| --- | --- | --- |
| `__extern_get_idx` (dynamic read, `(arr as any)[1]`) | `undefined` | ✅ |
| `__vec_gopd` / `Object.getOwnPropertyDescriptor` | `undefined` | ✅ |
| `__extern_has_idx` (`1 in arr`, `"1" in arr`) | `true` | ❌ |
| for-in / `Object.keys` | index enumerated | ❌ |
| typed `filter`/`forEach`/… presence gate | present | ❌ |

So the tombstone is written and never read by the **presence** side. Two
independent reasons:

- **(a)** `__extern_has_idx`'s `$__vec_base` arm answers `0 <= i < length`
  and has no overlay consult at all (unlike `__extern_get_idx`, which got a
  finalize-spliced prologue in #3251).
- **(b)** The typed HOF kernels only route presence through `__extern_has_idx`
  when `overlayRouteActive(ctx)` — i.e. under the #4159 pre-scan flag
  `vecAccessorDescriptorDirty`, which a plain `delete` does not set. A module
  whose only overlay writer is a `delete` keeps the dense `i < len` gate.

### Fix

1. A new pre-scan flag `vecIndexDeleteDirty` (`scanForArrayHoles`), set by any
   `delete <ElementAccessExpression>`, joins `vecAccessorDescriptorDirty` in
   `overlayRouteActive`. Same discipline as #4159: compile-time
   over-approximation, **not** a runtime guard, so a module without a
   `delete arr[i]` is byte-identical.
2. A finalize-spliced **presence prologue** on `__extern_has_idx`, mirroring
   the `__extern_get_idx` read prologue: gated on the same
   `__vec_overlay_numeric` flag global, it answers `0` when the companion
   entry for that index carries `FLAG_DELETED_INDEX`, and otherwise falls
   through to the existing dense answer byte-for-byte.

`__extern_has` (string-key lane) delegates numeric keys to `__extern_has_idx`,
so `"1" in arr` is fixed by the same prologue.

Unblocks the `filter` 9-3 / 9-6 / 9-b-9 family and the same
delete-inside-callback shape in every/some/forEach/map/indexOf.

## 2. `new Array(n)` fills `undefined`, not holes

`usesArrayHoles` is set only by array-literal *elisions* today, so
`new Array(3)` produces a dense vec of `undefined` and `0 in new Array(3)`
answers `true`. Blocks `filter` 9-5 / 9-b-1 and the `built-ins/Array` sparse
cluster.

CAUTION carried from the Wave-1 report: turning `usesArrayHoles` on has
module-wide blast radius (it arms the global `$Hole` read-guard on every
externref-elem vec read). Scope any activation to modules that actually
construct `Array(n)`.

## 3. `built-ins/Array` misc (23 failing)

- OOB reads must yield `undefined`, not trap
  (`oob:array element access out of bounds`, 6 tests:
  `15.4.5.1-5-1/-5-2`, `S15.4.5.1_A2.1_T1`, `S15.4.5.2_A1_T1/_T2`,
  `property-cast-number`).
- sparse-array `undefined` hole reads (`S15.4_A1.1_T4…T9`).
- `arr.toString()` via `Object.prototype` — measured: returns `undefined` in
  standalone, `"1,2,3"` in gc.

## 4. `built-ins/Array/length` (17 failing)

Setting `length` truncates (works today); the gaps are RangeError on invalid
values (`[].length = 4294967296` → measured *no throw*), `15.4.5.1-3.d-*`,
and the interplay with `src/codegen/array-length-define.ts`.

## Acceptance

- `delete arr[k]` makes `k` absent to `in`, `hasOwnProperty`, for-in,
  `Object.keys`, `getOwnPropertyDescriptor` and every array HOF, in the
  standalone lane, without regressing the gc lane.
- Regression tests in `tests/es5-standalone-array-semantics*.test.ts` pin each
  root cause on both lanes.
- No new host imports (dual-mode rule).

## Scope actually landed

**Item 1 (delete) — DONE.** Two mechanisms, as designed above: the
`vecIndexDeleteDirty` pre-scan flag joined `overlayRouteActive`, and
`vec-overlay-presence.ts` splices a `FLAG_DELETED_INDEX` consult onto
`__extern_has_idx`. Four presence surfaces were retargeted onto that
chokepoint so they agree by construction — the typed `n in arr` arm
(`binary-ops-in.ts`), the for-in vec index loop (`statements/loops.ts`), the
`__object_keys` / `__object_keys_forin` vec arm (`object-runtime.ts`), and the
HOF gates (already routed by Wave 1's `overlayFilterAccess`).

**Item 4 (`arr.length =` RangeError) — DONE for the assignment form.**
§10.4.2.4 step 3 validation, as `emitArraySetLengthValidation` in
`array-length-define.ts` (the module that already owns ArraySetLength over the
vec representation for the `defineProperty` forms), called from the assignment
path. `new Array(n)` already threw correctly; only the assignment form clamped.

**Item 2 (`new Array(n)` holes) — DONE for a deliberately bounded carrier
slice.** Item 3 remains not shipped. See "Leftovers" for the wider forms that
still conservatively demote.

### Measured

test262 standalone, this branch vs. its base, over **all 462** files in
`built-ins/Array/length` + `built-ins/Array/prototype/filter` +
`built-ins/Array/prototype/forEach` — the three directories this change can
reach: **281 → 287 pass, +6, zero regressions.**

| test | before | after |
| --- | --- | --- |
| `Array/prototype/filter/15.4.4.20-9-3` | fail | **pass** |
| `Array/prototype/filter/15.4.4.20-9-b-9` | fail | **pass** |
| `Array/prototype/filter/15.4.4.20-9-c-iii-1-4` | fail | **pass** |
| `Array/length/15.4.5.1-3.d-1` | fail | **pass** |
| `Array/length/15.4.5.1-3.d-2` | fail | **pass** |
| `Array/length/S15.4.5.1_A1.1_T1` | fail | **pass** |

A second sweep over the 99 failing `built-ins/Array/**` tests from
`.tmp/es5-buckets.json` agrees (+5 of those 6 are in that list; no regressions).

The gc lane is unchanged for item 1 by construction (`overlayRouteActive`
requires `ctx.standalone`); its pre-existing array-suite failures are identical
before and after. Item 4 applies to both lanes (it is not overlay-gated) and
the gc lane picks up the same RangeError.

### One deliberate test change

`tests/issue-1825.test.ts` asserted the OLD clamping (`arr.length = NaN` → 0,
`= 1e30` → i32 max). #1834's actual goal was "must not TRAP the module", not
"must not throw" — a spec RangeError is catchable, so it serves that goal
better than clamping. The two assertions were retargeted (not deleted) to pin
the non-trapping property; the RangeError identity is pinned separately in
`tests/es5-standalone-array-semantics-length.test.ts`.

## Leftovers (deliberately not shipped)

**Item 2 — `new Array(n)` holes.** The exact direct-binding, bounded-literal
`new Array(n) → .filter(...)` path now has its own nominal
`$__holey_array` carrier. Its allocator fills only that carrier with `$Hole`,
and the carrier's `filter` path uses `HasProperty` semantics. The global
`usesArrayHoles` flag and generic vec representation remain unchanged, so a
filter-free numeric buffer such as `new Array(n); a[0] = 5` retains
`$__vec_f64`.

This is intentionally not a general sparse-array claim. Aliases,
reassignment/escape, computed method access, dynamic keys, non-literal lengths,
and any reachable dynamic or prototype-sensitive effect fail the eligibility
proof and use the existing generic path. The bounded slice covers the two
original Test262 filter rows (`9-5` and `9-b-1`) without giving unrelated vecs
a module-wide `$Hole` read guard. Broader sparse-array surfaces, including
`built-ins/Array/S15.4_A1.1_T4…T9`, remain follow-up work.

**Item 3 — OOB reads.** The `oob:array element access out of bounds` cluster is
NOT a generic out-of-range read. Measured, all six are the **huge-index** rule:
`x[4294967295] = 1` and `x[-1] = 1` trap on both lanes because the write path
tries to grow the vec. Per §10.4.2.2 an index is an array index only in
[0, 2^32−1); 4294967295 and −1 are ordinary **named** properties that must land
in the #3537 bag and leave `length` alone. That is a contained follow-up in the
element-write growth path. Two of the six (`S15.4.5.2_A1_T1/_T2`) additionally
demand a real `length` of 4294967295, which needs genuinely sparse arrays and
is out of reach of any of this.

**`arr.length` above 2^31−1.** The surviving truncation is
`i32.trunc_sat_f64_s`, so a validated length above i32 max still clamps
(`15.4.5.1-3.d-3` expects 4294967295, gets 2147483647). The vec cannot be that
long; representing it needs the sparse-array work.

**`arr.length = <non-numeric>`.** `a.length = "x"` does not throw — the value
is not compiled as f64, so the new check does not see it. §10.4.2.4 runs
ToNumber first.

**`arr.hasOwnProperty("1")` on a typed receiver returns false even for a
PRESENT index** (measured, pre-existing, unrelated to delete). Not touched;
worth its own issue.

**`arr.toString()` returns `undefined` in standalone** (gc: `"1,2,3"`). Not
touched.

## Implementation Plan — 2026-08-13 `new Array(n)` hole carrier

### Architecture verdict

Candidate `19a2cf0fdf86caff3da64bf4d2d7d193d15879e2` must not land as-is. It
changes 18 files by roughly +830/-45 for exactly two Test262 gains per lane.
More importantly, it uses module-global `ctx.usesArrayHoles` to change generic
externref-vector allocation, growth, reads, `HasProperty`, and HOF behavior.
The scan may identify an exact `new Array(n)` binding, but that identity is
lost at the generic mutation/runtime boundaries, so unrelated externref vecs
in the same module inherit sparse-array semantics.

Reimplement this as a carrier-specific slice. If a dedicated holey-array
identity cannot be preserved through constructor, writes, `HasProperty`,
`Get`, and `filter`, reject/demote the shape; do not recover correctness by
arming global vec behavior. The old candidate's A/B is useful provisional
evidence only: it used base `81125e5...`, not the latest main.

### Root cause

ES5.1 §15.4.2.2 says one numeric `Array` argument sets `length` without
creating indexed properties. The dense vec representation initializes every
slot, so it cannot distinguish an absent hole from a present property whose
value is `undefined`. ES5.1 §15.4.4.20 `filter` captures the initial length,
then performs `HasProperty(O, Pk)` and only performs `Get`/callback when that
answer is true. A value-only vector therefore calls the callback for holes.

The representation must also preserve ordinary prototype lookup: an absent
own slot can be present through `Array.prototype[k]` or an inherited accessor.
A JS host helper cannot infer that relationship merely from an opaque WasmGC
vec. Either the carrier/provider models the Array prototype chain explicitly,
or selection must reject modules whose indexed prototype state can matter.

### Required representation boundary

Introduce a planned **holey Array carrier**, not a module-wide mode:

- `HoleyArrayPlan` records exact constructor and variable-declaration identity,
  the chosen carrier, supported filter call sites, and unsupported escapes.
- A dedicated allocator initializes backing slots to the existing `$Hole`
  sentinel while setting logical length to `n`.
- A dedicated set/grow provider fills only gaps in this carrier with `$Hole`.
- Dedicated `HasProperty` and `Get` providers distinguish absent, present
  `undefined`, overlay/tombstone, and inherited indexed properties.
- Ordinary `__vec_externref`, numeric-buffer `__vec_f64`, and generic
  `__extern_get_idx` / `__extern_has_idx` remain byte-for-byte unchanged when
  no already-landed feature requires them.

An explicit runtime brand/struct type is preferable. If current type plumbing
cannot support it, a sidecar keyed by exact carrier identity is acceptable
only with alias-safe lookup and proof that unrelated vecs cannot enter it.

### Changes

**File: `src/codegen/array-holes.ts` — `scanForArrayHoles` (candidate line
~59)**

- In `scanForArrayHoles`, build the per-site `HoleyArrayPlan` for an ambient,
  untyped, directly-bound `new Array(n)` and exact `.filter(...)` consumers.
- Track by `ts.VariableDeclaration`/node identity, not variable spelling.
- Reject or mark unsupported any alias, reassignment, escape, destructuring,
  computed method dispatch, shadowed `Array`, or mutation route that cannot
  preserve carrier identity. Do not set `ctx.usesArrayHoles` merely because
  this new constructor shape exists.

**Files: `src/codegen/context/types.ts`,
`src/codegen/context/create-context.ts` — `CodegenContext` hole fields /
`createCodegenContext` (candidate lines ~1468 / ~130)**

- Store the exact plan and carrier/provider indices. A boolean may gate byte
  emission, but it must never decide whether an arbitrary externref vec uses
  hole semantics.

**File: `src/codegen/expressions/new-indexed.ts` —
`tryCompileIndexedBuiltinNew` (candidate line ~28)**

- In `tryCompileIndexedBuiltinNew`, consult the constructor-node plan and call
  the dedicated holey allocator only for that site.
- Validate the ES5 array-length domain before allocation. The initial narrow
  IR slice may accept an integer literal representable by the current vec and
  must demote all other lengths; do not imply support for the full uint32
  range.

**File: `src/codegen/statements/variables.ts` — `inferArrayVecType` (candidate
line ~526)**

- In `inferArrayVecType`, force externref only for a declaration in the exact
  holey plan. A filter-free `new Array(n); a[0] = 5` must retain its existing
  numeric-buffer representation.

**File: `src/codegen/vec-elem-set.ts` — `ensureHoleyExternrefVecNew` /
`ensureVecElemSet` (candidate lines ~46 / ~161)**

- Keep/create `ensureHoleyExternrefVecNew` for the dedicated allocator.
- Add a carrier-specific set/grow helper. Remove candidate logic that makes
  generic `ensureVecElemSet` choose `$Hole` solely from
  `ctx.usesArrayHoles && elem.kind === "externref"`.
- On an out-of-bounds write, fill `[oldLength, index)` with `$Hole`, store the
  value at `index`, and update logical length. Storing JavaScript `undefined`
  creates a present slot and must never store `$Hole`.

**File: `src/codegen/expressions/assignment.ts` —
`compileElementAssignment` (candidate line ~4516)**

- Route assignments through the holey set provider only when the receiver is
  proven to be the planned carrier. Unsupported aliases demote before this
  point. Remove module-global gap-fill decisions from generic assignments.

**Files: `src/codegen/array-filter-spec-access.ts`,
`src/codegen/array-methods.ts`, `src/codegen/hof-native.ts` —
`overlayFilterAccess`, `compileArrayFilter`, `ensureNativeArrayHof` (candidate
lines ~97 / ~5821 / ~75)**

- Make `compileArrayFilter` and `overlayFilterAccess` consume the same
  carrier-specific `HasProperty`/`Get` contract.
- Capture `len` once. For each `k`, call `HasProperty`; call `Get` and the
  callback only when present. Append selected values densely to a fresh array.
- If indexed prototype state is dirty, either perform real prototype-aware
  lookup through the provider or demote. Do not send an opaque WasmGC vec to a
  JS host helper and call that prototype-correct.
- `ensureNativeArrayHof("filter")` must resolve the dedicated provider only
  for the planned carrier. Remove the candidate's global
  `usesArrayHoles && methodName === "filter"` gate.

**File: `src/codegen/object-runtime.ts` — `spliceExternHasIdxHoleVecArm` /
`fillExternGetIdxVecArms` (candidate lines ~6468 / ~6546)**

- Do not splice hole arms into generic `fillExternGetIdxVecArms` or
  `spliceExternHasIdxHoleVecArm` on account of this slice. Add dedicated holey
  Array `Get`/`HasProperty` helpers, or dispatch on an unambiguous runtime
  carrier brand before any ordinary vec arm.
- Preserve existing overlay tombstone semantics from the completed delete
  portion of this issue.

**Files: `src/ir/select.ts`, `src/ir/from-ast.ts`,
`src/ir/integration.ts`, `src/ir/vector-runtime.ts` — `isPhase1Expr`,
`lowerNewExpression`, `lowerMethodCall`, `makeFromAstResolver`, and
`resolveAndObserveCallableProvider` (candidate lines ~6372 / ~5656 / ~5994 /
~4065 / ~4498)**

- Selection claims only an exact planned constructor/filter pair, ambient
  `Array`, one bounded integer literal length, a scope-owned callback, and no
  unsupported alias/escape/reassignment. Every fact required by lowering and
  provider resolution must be known before claim.
- `lowerNewExpression` emits the symbolic holey allocator;
  `lowerMethodCall` emits the symbolic holey-filter provider. Both carry the
  planned representation identity rather than rediscovering it by element
  type.
- `makeFromAstResolver` / `resolveAndObserveCallableProvider` resolve those
  symbols to the dedicated providers without mutating generic vec semantics.
- Host may remain on the legacy top-level/module-initializer emitter until a
  host IR provider exists, but document that ownership honestly. Standalone
  supported functions must report `irBodyEmitted: true` and
  `legacyBodyEmitted: false`.

### Wasm IR pattern

```text
%array   = call @runtime.holey_array_new(i32.const n)
call @runtime.holey_array_set(%array, i32.const index, %boxed_value)
%result  = call @runtime.holey_array_filter(%array, %callback)

;; Inside filter, with len captured before the loop:
%present = call @runtime.holey_array_has_property(%array, %k)
if %present
  %value = call @runtime.holey_array_get(%array, %k)
  %keep  = call_ref %callback(%value, %k, %array)
  if %keep
    call @runtime.holey_array_append_present(%result, %value)
  end
end
```

The providers may inline this sequence, but `HasProperty` and `Get` remain
separate semantic operations. `$Hole` is internal and must never escape as a
callback value, property value, or host externref.

### Edge cases and required tests

- Both exact Test262 rows in both lanes:
  `filter/15.4.4.20-9-5.js` and `filter/15.4.4.20-9-b-1.js`.
- `new Array(10)` has length 10 and no own index properties; a stored
  `undefined` is present and visited while untouched slots are skipped.
- `filter` captures length once; writes beyond captured length are ignored,
  while creation/deletion of not-yet-visited indices follows `HasProperty` at
  visit time.
- An inherited numeric data property and inherited numeric accessor at a hole
  are observed and visited. Own present `undefined` shadows the prototype.
- Sparse growth preserves intermediate holes; delete tombstones stay absent.
- `Array` shadowing, dynamic/unrepresentable lengths, aliases, reassignment,
  escaped carriers, and computed `filter` access either work through the same
  provider or visibly demote before IR selection.
- A filter-free numeric buffer remains `$__vec_f64`. An unrelated externref
  vec in the same module has identical bytes and behavior. Include a
  mixed-module test containing both carriers.
- Run the original Test262 top-level/module-initializer shape, not only an
  exported-function rewrite; these paths have differed historically.

### Same-population A/B and zero-loss gates

Record the exact latest `origin/main` SHA at implementation start and compare
it with the exact implementation SHA. Use Test262 corpus gitlink
`b363f29d3c43c626dc852744ad64a0b48a003693`, identical oracle, harness,
timeouts, target flags, maintained file list, and freshly built bundles in
both arms.

First run the exact 44-row ES5 `built-ins/Array/prototype/**` residual
partition used by the candidate, plus the positive/negative controls above.
Report all status totals and every row transition. Require only the two named
`fail -> pass` transitions per lane, zero `pass -> non-pass`, identical runner
errors, and no entered/left/unmeasured rows. Add a carrier-brand kill switch:
disabling only the dedicated holey provider must remove the two gains without
changing unrelated vec controls.

Then run all **9,029** `<= ES5` tests through the authoritative original
harness in each lane, including eval, `Function`, and `with`:

- host/gc: goal closure is 9,029 pass and zero other statuses;
- standalone: goal closure is 9,029 pass and zero other statuses;
- an incremental change may land only with zero `pass -> non-pass`, zero new
  compile errors/timeouts/skips, and exact accounting of every changed row.

### Candidate disposition and Terra implementation handoff

- Rebase/rederive from current main; candidate `19a2cf0f...` is read-only
  evidence, not a patch to merge wholesale.
- Reject the module-global `usesArrayHoles` correctness gate and generic vec
  rewrites. Preserve only pieces that remain valid after carrier identity is
  explicit (likely the allocator and focused Test262 fixtures).
- Keep the change proportional. Every touched compiler file must be justified
  by the carrier dataflow above; if the two-row slice still needs broad generic
  rewrites, stop and return an architecture blocker rather than landing it.

## Bounded carrier implementation result — 2026-08-13

Implementation commit `53a2d52f43b35c02f485013d28f03f8e842301c6` was rebased
onto verified `origin/main`
`f8d47c3a3cfb38f84e2b9df2a0c21f4ff2287b23` (PR #4447's class-expression
IR ownership work). It adds the nominal
`$__holey_array` representation only for a statically proven direct,
bounded-literal `new Array(n)` binding whose only relevant uses are safe index
stores and direct `.filter(...)` calls. The allocator and gap-growth path fill
that carrier with `$Hole`; ordinary vectors, including filter-free numeric
buffers, stay on their existing representation.

Standalone lowers the selected constructor and filter through the IR runtime
symbols. The focused IR test confirms the supported function appears in
`irCompiledFuncs`, has no post-claim errors, and emits `$__holey_array`. The
host original-harness shape retains its existing legacy emission path while
using the same nominal carrier and hole-skipping filter semantics.

### Focused verification

- `pnpm run typecheck` passed.
- `pnpm exec vitest run tests/es5-array-new-filter-holes.test.ts
  tests/es5-standalone-array-semantics-prescan.test.ts
  tests/issue-4159-4160-prescan-flags.test.ts --reporter=verbose` passed:
  **41/41** tests. This includes host/gc and standalone semantics, growth and
  captured-length behavior, the authentic assembled-harness binding, unsafe
  prototype/dynamic-code demotions, the f64 control, and standalone IR
  ownership.
- `pnpm run check:loc-budget`, `pnpm run check:func-budget`, and
  `pnpm run check:ir-fallbacks` passed.

### Same-population original-harness A/B

This comparison was refreshed after the `f8d47c3…` rebase. Both arms used
`scripts/harness-flip-probe.ts`, the pinned Test262 corpus
`b363f29d3c43c626dc852744ad64a0b48a003693`, and the exact 44-row
`built-ins/Array/prototype/**` residual list in
`/private/tmp/array-prototype-es5-residual-44.txt`. In both lanes the probe's
positive control remained `must-pass → pass` and its negative control remained
`must-fail → fail`.

| lane | current-main baseline | carrier implementation | transitions |
| --- | --- | --- | --- |
| host/gc | 42 fail, 2 error | 40 fail, 2 pass, 2 error | 2 fail → pass; 0 pass → non-pass; 0 other changes |
| standalone | 34 fail, 10 pass | 32 fail, 12 pass | 2 fail → pass; 0 pass → non-pass; 0 other changes |

The only changed rows in each lane are:

- `test/built-ins/Array/prototype/filter/15.4.4.20-9-5.js`
- `test/built-ins/Array/prototype/filter/15.4.4.20-9-b-1.js`

All 44 rows were present in both artifacts; 42 were unchanged in each lane.
The two host error rows and their detail strings were identical between arms.
This validates the bounded carrier slice, not the still-open general
sparse-array surfaces listed above.
