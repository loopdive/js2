---
id: 3201
title: "default lane: Array.prototype search + structural generics (indexOf/lastIndexOf/slice/splice/sort/concat/pop) (~312 fails)"
status: done
completed: 2026-07-24
assignee: ttraenkler/dev-opus-search
created: 2026-07-12
updated: 2026-07-24
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: builtin-methods
sprint: 76
horizon: m
umbrella: 3185
related: [3185, 3169, 3180, 2036]
# expando-method slice (fable-b): unknown-method host delegation lives in the
# receiver-method ladder + the shared #3123 emitter; the vec host view's
# sidecar traps live in runtime.ts. NOTE: keep this a block list — the
# gate's parseFrontmatterList does not read multi-line flow arrays.
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/calls.ts
  - src/runtime.ts
origin: "2026-07-12 Fable codebase audit §F2; method-family slice of #3185"
---

# #3201 — default-lane Array search + structural generics (~312)

Method-family slice **C** of **#3185** (default JS-host lane). Covers the
non-callback search + structural family: **splice (63) + lastIndexOf (50) +
indexOf (48) + slice (48) + sort (45) + concat (45) + pop (13) = ~312**
non-pass (baseline 2026-07-12).

## Not overlapping #3169/#3180

#3169/#3180 cover the **seven callback HOF families** on the standalone lane —
this slice's methods (indexOf/lastIndexOf/slice/splice/sort/concat/pop) are
**not** in that set and are on the **default JS-host lane**. Disjoint on both
axes. sort's callback comparator is in-scope here (default lane) but is not a
#3169 HOF family.

## Problem mechanisms (from #3185 §F2 error shapes)

1. **Array-like receivers via `.call(obj, …)`** — `Array.prototype.
   {indexOf,lastIndexOf}.call(arrayLike)` (13 + 12 measured shapes); the host
   externref path (`ARRAY_LIKE_METHOD_SET`, `array-methods.ts:668`) misses
   spec ordering/coverage.
2. **Observable + coercion semantics** — `fromIndex`/`start`/`deleteCount`
   ToInteger coercion, HasProperty-before-Get, `SameValueZero` vs strict
   equality (indexOf/lastIndexOf), length caching.
3. **Result-object fidelity** — `newArr.length` mismatch (28),
   `Object.getPrototypeOf(result)` mismatch (8): length / prototype / species
   of slice/splice/concat results.
4. **Hard traps (30 family-wide, umbrella-priority)** — `illegal cast [in
   test()]` (16) + `array element access out of bounds [in test()]` (14) are
   soundness-adjacent (uncatchable, abort whole tests). Per #3185 §4 these are
   the FIRST priority: every trap in this family's tests must become a spec
   value or a thrown JS TypeError, never a Wasm trap. Coordinate with
   #3179/#3162 mechanism notes.

## Reproduction path (verified anchors)

- Direct real-array impls: `compileArrayIndexOf` (`array-methods.ts:4462`),
  `compileArrayLastIndexOf` (`:9292`), `compileArraySlice` (`:5438`),
  `compileArraySplice` (`:6239`), `compileArraySort` (`:8285`),
  `compileArrayConcat` (`:5550`) / `compileArrayConcatExtern` (`:5680`),
  `compileArrayPop` (`:5100`).
- Array-like `.call` generic path: `compileArrayLikePrototypeCall` (`:763`),
  `ARRAY_LIKE_METHOD_SET` (`:668`).

## Acceptance criteria

1. The 30 trap-class fails (illegal cast / OOB) across this family → 0 traps
   (spec result or thrown JS TypeError). **Land this sub-bucket first.**
2. Root-cause note per mechanism sub-bucket, with the measured test list from
   the baseline jsonl (recompute — main moves).
3. ≥ 150 of the ~312 family records flip to genuine pass on the default lane.
4. Result-object length/prototype fidelity holds for slice/splice/concat.
5. No standalone-lane regressions.

## Coordination (hot file)

`src/codegen/array-methods.ts` is shared with #3199/#3200, epic S3 #3193 /
S6 #3196, and dev-array-hof. Behavioral fixes only; re-anchor by symbol;
re-merge `origin/main` before enqueue.
## Progress — sparse-array read trap-safety (indexOf/lastIndexOf) landed (opus-dstr, 2026-07-13)

Partial fix for the trap-first sub-bucket (acceptance #1). `compileArrayIndexOf`
and `compileArrayLastIndexOf` looped `0 .. vec.length` (logical length, field 0)
reading `data[i]` with a raw `array.get`, which TRAPS ("array element access out
of bounds") once `i` passes the physical backing length — the case where a
sparse array's logical `.length` was set beyond its WasmGC backing (`a.length =
N`, or a high-index write). Per §23.1.3.14 / §23.1.3.20 (HasProperty-driven)
those absent indices are SKIPPED, so the fix clamps the iteration bound (indexOf:
effective length = `min(logicalLen, array.len(data))`; lastIndexOf: clamp the
reverse-scan start index down to `array.len(data)-1`). Pure-sparse searches now
return the correct `-1` with no trap; dense arrays are byte-unchanged (backing
capacity ≥ length ⇒ clamp is a no-op). Zero array-suite regressions
(`tests/issue-3201.test.ts`, standalone lane; the two pre-existing
`fast-arrays`/`array-oob-bounds-check` fails are unrelated and present on clean
main).

### Remaining trap-class root causes (NOT addressed here — separate follow-ups)

Measured against the 2026-07-13 baseline, most of the family's trap-class fails
are NOT the method-read OOB this slice fixes:

1. **Huge sparse-index WRITE** (`arr[Math.pow(2,32)-2] = v`) — traps on the
   element-WRITE path trying to densely grow the backing to ~4 billion slots
   (`15.4.4.14-5-16/-5-12/-9-9`, `15.4.4.15-5-12/-8-9`, splice/concat variants).
   Needs a sparse representation or a graceful cap/RangeError in the array
   index-write lowering — out of `array-methods.ts` scope. **Dominant remaining
   trap cause.**
2. **`Array.prototype` mutation** (`Array.prototype.length = 0`,
   `Array.prototype[1] = 1`) — `illegal cast` writing the prototype's `length`,
   and prototype-inherited index reads the flat WasmGC vec cannot model
   (`15.4.4.14-2-4`, `15.4.4.15-2-4`, pop/concat `S15.4.4.*_A*`). The read side
   would need prototype-chain index fallback (shared with the #2001-deferred
   hole/prototype-inheritance boundary).
3. **Revoked-Proxy `illegal cast`** (concat/slice `create-revoked-proxy`,
   `is-concat-spreadable-*-revoked`) — Proxy is a deferred feature; the revoked
   handle should surface a TypeError rather than trapping on `ref.cast`.

## Progress — sparse-array structural-copy trap-safety (slice/concat) landed (opus-dstr, 2026-07-13)

Second trap-first slice, following the indexOf/lastIndexOf read-clamp (#2968).
`slice` and `concat` build their result with `array.copy` over the source range
`[start, start+len)`. On a sparse array (logical `.length` beyond the physical
WasmGC backing) that range runs past `array.len(data)` and the `array.copy`
TRAPS ("array element access out of bounds"). Added `emitBackingClampedCopyLen`
— a shared helper that clamps each copy COUNT to `clamp(array.len(data) - start,
0, requestedLen)` while the destination keeps its full logical length (the
beyond-backing tail stays a default-initialised hole, per the spec's skip of
absent indices). Applied to `compileArraySliceFromVecLocal` and all three
`compileArrayConcat` copy sites (0-arg + 1-arg × 2). Pure-sparse `slice()` /
`concat()` now return a correctly-sized result with no trap (pass-flip);
in-backing prefixes preserved; dense arrays byte-unchanged (clamp is a no-op).
Zero array-suite regressions (`tests/issue-3201-slice-concat.test.ts` 8/8; the
one pre-existing `array-oob-bounds-check > destructuring shorter array` fail is
unrelated, present on clean main).

Still open in this family (documented above): huge sparse-index WRITES (trap on
the densely-growing-backing write path), the harness-entangled `Array.prototype`
mutation `illegal cast` cluster (reproduces only through the full test262
preamble — not cleanly bounded), revoked-Proxy casts (deferred, #1355/#1472),
and `includes`/`splice`/`sort`/`pop` sparse reads (includes needs a
bounds-checked read rather than a loop-clamp because §Array.prototype.includes
treats absent indices as `undefined` — a follow-up).

## Progress — sparse-array pop/splice trap-safety + guarded-copy hardening (opus-dstr, 2026-07-13)

Third and final trap-first slice for the sparse-array read/copy family (after
#2968 indexOf/lastIndexOf and #2970 slice/concat):

- **pop** — guarded `data[length-1]` read on `newLen < array.len(data)`; a
  beyond-backing pop yields `undefined` (the absent-index value, §23.1.3.21),
  the length decrement stays unconditional. Numeric-result arrays keep the
  unguarded read (backing covers length; no `undefined` sentinel).
- **splice** — all four `array.copy` sites (delData / head / tail / in-place
  shift) routed through the new `emitBackingClampedArrayCopy`.
- **Hardening** — `emitBackingClampedArrayCopy` clamps the copy count to the
  source backing AND **guards the copy on `count > 0`**. The guard is
  load-bearing, not an optimisation: WasmGC `array.copy` traps when
  `srcOffset + count > array.len(src)` **even at `count == 0`**, so a
  `srcOffset` past the backing (e.g. `slice(2)` on a 1-backed sparse array)
  traps despite a clamped-to-zero count. This also **fixes a latent trap in the
  already-merged #2970 slice/concat** copies (their raw clamp left `srcOffset`
  past the backing for `start > backing`); those sites now use the guarded
  helper too.

Zero array-suite regressions (`tests/issue-3201-pop-splice.test.ts` 9/9; the two
pre-existing `array-oob-bounds-check > destructuring shorter array` and
`fast-arrays > array find` fails are unrelated, present on clean main).

### Family status after this slice

Read/copy sparse traps for **indexOf / lastIndexOf / slice / concat / pop /
splice** are now trap-safe. Still open (documented above, need fresh dispatches
— NOT bounded extensions of the clamp pattern):
- **sort** — the numeric Timsort / insertion-sort helpers read the logical
  length; a numeric `number[]` with `.length = N` beyond its backing still
  traps. Fixing needs clamping inside the shared sort helpers (or fixing the
  `.length` setter to grow a numeric backing). Not a copy-site clamp.
- **includes** — needs a bounds-checked READ (absent index ⇒ `undefined`),
  not a loop-clamp, because §Array.prototype.includes finds `undefined` at
  absent indices (a loop-clamp would wrongly miss `includes(undefined)`).
- **huge sparse-index WRITES** (`arr[2**32-2] = v`) — write-path rework.
- **`Array.prototype`-mutation `illegal cast`** — harness-entangled (reproduces
  only through the full test262 preamble); needs preamble bisection.

## Progress — sparse-array sort/includes trap-safety landed (opus-3201b, 2026-07-13)

Third trap-first slice, following the indexOf/lastIndexOf read-clamp (#2968)
and the slice/concat structural-copy clamp (#2970). On a SPARSE array (logical
`.length` set beyond the physical WasmGC backing) both methods read/write
`data[i]` past `array.len(data)` and TRAP ("array element access out of
bounds"), aborting the whole test262 program.

- **sort** — all three sort lowerings read to the LOGICAL length: the default
  numeric Timsort (`__timsort_<k>` thunk in `timsort.ts`), the default ToString
  insertion sort (`compileArrayDefaultToStringSort`), and the comparator
  insertion sort (`tryCompileComparatorSort`). Added `emitSortLenBackingClamp`
  (a shared `len = min(len, array.len(data))` helper in `array-methods.ts`) at
  each site; the Timsort thunk got the same clamp inline (it has no fctx). Per
  §23.1.3.30 SortIndexedProperties the beyond-backing indices are holes that
  sort to the END, so sorting only the physical defined prefix and leaving the
  holes in place is spec-correct AND trap-free.
- **includes** — the SameValueZero scan bound is clamped to the physical backing
  (`effLen = min(len, array.len(data))`, mirroring the merged indexOf clamp).
  A beyond-backing hole reads as `undefined` (§23.1.3.16 Get), which can never
  SameValueZero-match a number/string search value, so the loop-clamp is
  spec-correct for the numeric/string element arrays that actually hit the trap.
  (The task-flagged `includes(undefined)` beyond-backing sub-case only concerns
  externref/`any[]` element arrays — and there the length-setter GROWS the
  backing rather than leaving a beyond-backing gap, so there is no trap and no
  clamp divergence to fix; a structural post-loop `undefined` check was
  prototyped and REMOVED as dead code on realistic inputs. Standalone
  externref-element includes remains separately broken by the `$Object`
  native-string value-read substrate gap — out of scope here.)

Dense arrays are behaviourally unchanged (backing capacity ≥ length ⇒ the clamp
is a runtime no-op). Dedicated tests: `tests/issue-3201-sort-includes.test.ts`
(11/11, standalone lane). Zero array-suite regressions — the pre-existing
`issue-2036` S6 "refuse-loudly" fails, `array-capacity` `string_constants`
host-import fails, and `array-oob-bounds-check > destructuring shorter array`
fail are all present on clean `origin/main` (verified by swapping in the
origin/main compiler).

Still open in this family (documented above, left `ready`): huge sparse-index
WRITES (trap on the densely-growing-backing write path), the harness-entangled
`Array.prototype`-mutation `illegal cast` cluster, revoked-Proxy casts
(deferred, #1355/#1472), and `splice`/`pop` sparse reads.

## Progress — expando-method dispatch (Sputnik getClass cluster, ~75 files) landed (fable-b, 2026-07-17)

Root cause of the single largest remaining coherent cluster (65 "result is
Array object. Actual: null" + 10 getClass-value fails across
splice/slice/concat `S15.4.4.*`): the Sputnik classifier idiom
`arr.getClass = Object.prototype.toString; arr.getClass()` silently produced
`null` — an UNKNOWN method on a statically-typed struct/vec receiver had no
arm in the receiver-method ladder and fell to the calls.ts graceful
drop+null fallback. Three coordinated fixes (JS-host lane only; standalone
untouched per acceptance #5):

1. `call-receiver-method.ts` — end-of-ladder arm delegates unknown methods on
   ref/ref_null receivers to the generic `__extern_method_call` (#799 WI3 /
   #3123 machinery).
2. `calls.ts emitFnctorSubclassDynamicMethodCall` gains `rawStructReceiver`:
   the receiver marshals as the RAW wasm ref, not coerceType's
   `__make_iterable` COPY — the `_wasmStructProps` expando sidecar is keyed
   by raw struct identity, so a copy never finds the stored method.
3. `runtime.ts _wrapVecForHost` — the vec's array-backed host view surfaces
   sidecar expandos in get/has (own expando shadows Array.prototype, spec
   lookup order), callable-wrapping raw closure structs at read time
   (module-init writes run before setExports, so write-time wrapping can't
   resolve exports).

Validated: 13/14 sampled cluster files flip fail→pass via runTest262File
(the 14th is a different mechanism — expando `splice` on array-like, still
open); tests/issue-3201-expando-method.test.ts 5/5; array-methods /
object-literals / object-methods / getters-setters / prior #3201 trap-safety
suites all green (anon-struct's 3 fails pre-exist on clean main).

Still open in this family: coercion/observable semantics (fromIndex
ToInteger, HasProperty-before-Get, SameValueZero), array-like `.call`
receivers, sort string-order cluster (14), result species/prototype
fidelity, huge sparse-index writes, Array.prototype-mutation casts,
revoked-Proxy casts (deferred).

## Progress — inherited-length array-like `.call` cluster: `__extern_length` unsound probe (fable-e, 2026-07-17)

Mechanism-1 slice (array-like receivers via `.call(obj, …)`). Root cause found
by live instrumentation: `__extern_length`'s struct arm resolved own `length`
with a raw `__sget_length` try/catch probe. On a fnctor instance struct
(`var Con = function(){}; Con.prototype = {length: 2}; new Con()`) the probe
CAST-SUCCEEDS via structural canonicalization on some registered
`__sget_length` getter and reads a **zero-initialized unrelated slot** —
returning own length 0 (a non-null, non-throwing wrong answer, so no
null-check gate can catch it) and SHADOWING the inherited `length` that
`_fnctorProtoLookup` (#3139) resolves correctly one line below. This is the
`#1629` unsound-`__sget_*`-probe anti-pattern.

Fix: resolve own `length` through the #1629-safe `_readOwnDescriptor` (vec
live length via `__vec_len`, sidecar, shape-gated struct field via
`_getStructFieldNames`), then the fnctor prototype chain. Flips the
`15.4.4.14-2-{6,8,9}` + `15.4.4.15-2-{6,8,9}` inherited-length clusters
(6 verified per-process flips on the 97-test indexOf/lastIndexOf
baseline-fail sample); also feeds every array-like borrow loop (forEach/map/
filter etc. — #3200's families).

**Coordination (agreed with fable-2, 2026-07-17):** the SAME unsound-probe
class exists in `__extern_get_idx` (wrong-shape null served as a real
element, masking inherited indices) and `__extern_has_idx` (`return 1` on
any non-throwing probe visits holes as own) — those two arms are **fable-2's**
(branch issue-3200-array-iteration-generics); `__extern_length` is this
branch. The remaining ~19 `.call`-cluster fails in this family hinge on
those two arms plus the element-kind mechanisms.

Suites: `issue-3201-inherited-length` 5/5 (new), `issue-1360` +
`issue-3138` + `issue-3116` + `issue-1629-S1` + `issue-3139` + `issue-1629`
+ `issue-1629a` 76/76, tsc clean.

## Progress — len==0 before ToInteger(fromIndex) (fable-e, 2026-07-17, same PR)

Mechanism-2 slice, same PR (#3194). §23.1.3.14/.20 step 3: on an empty array,
`return -1` precedes step 4's `ToIntegerOrInfinity(fromIndex)`, so a throwing
`valueOf` on the fromIndex object must not be observed
(`{indexOf,lastIndexOf}/length-zero-returns-minus-one.js` — both flip to
pass). `compileArrayIndexOf`/`compileArrayLastIndexOf` compiled the fromIndex
coercion (whose f64 path embeds ToPrimitive → `valueOf`) unconditionally;
now the coercion+clamp instrs are compiled into the main body then spliced
into a `len != 0` guard arm (safe: nested `then`/`else` arms ARE walked by
`flushLateImportShifts`' recursive `shiftBody`, so no detached-array funcIdx
staleness — only never-embedded arrays are hazardous, per the #2001
pre-ensure note). len==0 arms: indexOf iTmp=0 (loop bound 0 → -1);
lastIndexOf iTmp=-1 (same as the empty default `len-1`).

Suites: `issue-3201-inherited-length` 8/8 (3 new ordering tests incl. the
positive valueOf-IS-observed control), the five issue-3201* suites +
`issue-1360` + `array-prototype-methods` 91/91, tsc clean.

## Progress — 2026-07-24 re-measurement + re-scope + slice undefined-end fix (dev-opus-search)

Full **fork-per-file** re-measurement of the default gc/"honest" lane (the
in-process harness was unfaithful — the compiled wasm's host glue mutates the
OUTER realm's intrinsics, e.g. `Object.prototype[i]=v` / `Array.prototype[i]=v`
tests, which poisons Node's async_hooks for every subsequent file; discarded).
Method: CI baseline jsonl (`fetch-baseline-jsonl.mjs`) for the pass/fail map +
one-process-per-file re-run for error strings. Cross-check: **0 flips** — every
jsonl-fail still fails on origin/main HEAD (no submodule drift).

**Measured map (default gc lane, 2026-07-24)** — pass/total (nonpass):
indexOf 151/201 (50) · lastIndexOf 145/198 (53) · slice 47/71 (24) · splice
50/81 (31) · sort 8/54 (46) · concat 23/69 (46) · pop 7/23 (16). **TOTAL
431/697, 266 nonpass** (the issue's 312 predates the trap-safety / expando /
inherited-length / len==0 PRs above).

**Re-scope (substrate vs feature vs contained).** The raw residue is dominated
by two masses that are NOT contained dev slices, now SPLIT OUT:
- **species / @@isConcatSpreadable (~42, concat/splice/slice)** → **#3575**
  (ArraySpeciesCreate + @@isConcatSpreadable; ES2015 observable-ctor feature,
  architect-scale).
- **indexed accessors + prototype-chain index + hole→undefined read (~34+)** →
  recorded on the substrate epic **#3251** (array-descriptor overlay) as its
  shared host-lane consumer. Same flat-`$Vec` wall as the standalone lane; not
  fixable in `array-methods.ts`.
- **array-like `.call` receiver value+OOB-traps** → hinge on the shared
  `__extern_get_idx`/`has_idx` arms + prototype-chain index (overlaps #3200 /
  the overlay).

So the **≥150-flip acceptance target (#3) is not reachable** in the current
substrate — it assumed the residue was contained slices; measurement shows it
is mostly substrate + feature. The contained remainder is small.

**Contained fix LANDED this PR — slice explicit-`undefined` end (§23.1.3.25
step 6).** `x.slice(3, undefined)` returned an EMPTY slice: an explicit
`undefined` end compiled to `f64.const NaN` → `i32.trunc_sat` = 0, i.e.
`slice(3,0)`. Spec: an `undefined` end is equivalent to an OMITTED end
(`relativeEnd = len`), NOT `ToIntegerOrInfinity(undefined)` = 0. (undefined
START already coerces correctly to 0 = the default.) Fix in `compileArraySlice`:
a statically-`undefined` end (literal or the `undefined` global, no side
effects) is treated as "no end". Measured on the full slice dir via fork-per-
file: **47→49 pass, +2 flips (`S15.4.4.10_A1.5_T1`, `S15.4.4.10_A2_T6`), 0
regressions.**

The other contained sort candidates were ceded/blocked: `ESSymbolLike` in
`isKnownNonCallable` (Symbol comparefn → TypeError, `comparefn-nonfunction-
call-throws`) is being landed by **#3200** (dev-c-1's flatMap non-callable arm
needs the identical line — coordinated, not duplicated); the sort undefined/
hole placement (A1.*) is substrate-blocked (`new Array(2)` holes read as `null`,
per #3251/#2001), and the `any[]` ToString sort (A2.*) needs a runtime
any→string step on the shared default-sort path (deferred as a separate
guarded follow-up).
