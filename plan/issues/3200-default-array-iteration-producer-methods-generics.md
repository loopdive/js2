---
id: 3200
title: "default lane: Array.prototype iteration/producer generics (forEach/map/filter/flatMap) over real + array-like receivers (~204 fails)"
status: ready
created: 2026-07-12
updated: 2026-07-24
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/array-methods.ts
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: builtin-methods
sprint: current
horizon: m
umbrella: 3185
related: [3185, 3169, 3180, 3015, 3170]
origin: "2026-07-12 Fable codebase audit §F2; method-family slice of #3185"
---

# #3200 — default-lane Array iteration/producer generics (~204)

Method-family slice **B** of **#3185** (default JS-host lane). Covers the
callback iteration/producer family: **map (69) + filter (68) + forEach (53) +
flatMap (14) = ~204** non-pass (baseline 2026-07-12).

## Not overlapping #3169/#3180

#3169 (done) / #3180 (residual) cover map/filter/forEach on the
**`--target standalone`** lane. This slice is the **default JS-host lane** —
disjoint by construction. flatMap is NOT in the #3169 seven-family set at all,
so it is untracked on both lanes; keep the flatMap fix host-lane here and file
a standalone follow-on if it diverges.

## Problem mechanisms (from #3185 §F2 error shapes)

1. **Observable semantics on real arrays** — callbackfn arg/return
   (`testResult !== true`), accessor/get observation order (`accessed`), hole
   skip-vs-visit, `callCnt` under mutation-during-iteration, length caching.
2. **Result-object fidelity** — `newArr.length` mismatch (28),
   `Object.getPrototypeOf(result)` mismatch (8): length / prototype / species
   of the map/filter/flatMap result arrays.
3. **Array-like receivers via `.call(obj, …)`** — the host externref path
   (`ARRAY_LIKE_METHOD_SET`, `array-methods.ts:668`; thisArg `:996-1020`)
   misses spec coverage for these methods.
4. **Hard traps** — any `illegal cast` / OOB `[in test()]` under these methods
   must resolve to spec value or thrown TypeError, never a Wasm trap
   (umbrella trap-first mandate, #3185 §4).

## Reproduction path (verified anchors)

- Direct real-array impls: `compileArrayMap` (`array-methods.ts:7205`),
  `compileArrayFilter` (`:7116`), `compileArrayForEach` (`:7715`),
  `compileArrayFlatMap` (`:9561`).
- Array-like `.call` generic path: `compileArrayLikePrototypeCall` (`:763`),
  `ARRAY_LIKE_METHOD_SET` (`:668`).

## Acceptance criteria

1. Root-cause note per mechanism sub-bucket, with the measured test list from
   the baseline jsonl (recompute — main moves).
2. ≥ 110 of the ~204 family records flip to genuine pass on the default lane.
3. Result-object length/prototype fidelity holds for map/filter/flatMap.
4. Zero Wasm traps; no standalone-lane regressions.

## Coordination (hot file)

`src/codegen/array-methods.ts` is shared with #3199/#3201, epic S3 #3193 /
S6 #3196, and dev-array-hof. Behavioral fixes only; re-anchor by symbol;
re-merge `origin/main` before enqueue.

## Slice 1 (2026-07-17, fable-2) — index-MOP unsound `__sget_*` probes in the array-like generic loop

Root cause (probed live, repros in `tests/issue-3200.test.ts`): `__sget_<k>`
struct-field getters are ref.test shape-dispatch chains that NEVER trap — for
a receiver whose own shape lacks the field they return null, or a
zero-initialized slot on a structurally-colliding shape. Three runtime.ts
index-MOP arms trusted the raw probe:

- `__extern_get_idx` returned the wrong-shape null as a real element, masking
  INHERITED indices (fnctor prototype chain / Object.prototype walks sit
  BELOW the probe) — the map/filter/forEach `-c-i-*` families.
- `__extern_has_idx` `return 1`-ed whenever ANY shape in the module carried
  the field — HasProperty answered true for every struct, visiting holes.
- `__extern_length` (same class): cast-succeeds on fnctor instance structs
  and returns a zero-initialized own length 0, shadowing the inherited
  `length` that `_fnctorProtoLookup` resolves — this is what holds the
  `-2-*` + most `-c-i-*` clusters (loop never runs). **Owned by fable-e on
  `issue-3201-array-search-generics`** (coordinated 2026-07-17; do not
  double-fix). This slice fixes get_idx/has_idx via `_readOwnDescriptor`
  (#1589A field-name-registry discipline); expect the big cluster flips only
  once BOTH land.

Residual mechanisms for later slices (measured 2026-07-16, 201 non-pass):
`.call` bucket 87 (mostly blocked on the length fix; ToObject-primitive
receivers `-1-*` separate), direct bucket 114: accessor observability via
defineProperty on real arrays (~62, value-rep/#3022-cause-1 territory),
ArraySpeciesCreate constructor/@@species on the native vec path (~28,
map/filter create-species* + flatMap this-value-ctor*), sparse/holes on real
arrays (~23), thisArg (~9), flatMap array-like (.call not in
ARRAY_LIKE_METHOD_SET at all). Note: probe batches are contaminated by
Object.prototype getter pollution + the #3318 `declaredType` CE — measure
single-test, fresh process.

## Slice 2 (2026-07-24, dev-opus-arrayhof) — flatMap correctness (trap-first, fully owned)

Fresh MEASURE at HEAD def8f82 (default gc lane, real runner, per-file unit;
includes slice-1 + a64f272 length fix). Scoped map/filter/forEach/flatMap:
**672 / 462 pass / 210 non-pass (68.8%)**. Per-method non-pass: map 74,
filter 68, forEach 52, flatMap 16. (204→210 vs 2026-07-12 = corpus growth:
new resizable-buffer + this-value-ctor tests, NOT a slice-1 regression.)

Receiver-kind partition of the 210 (source-grepped every file — the real
tractability axis):
- **direct-real-array 115** (map39/filter38/forEach27/flatMap11) — dominated
  by defineProperty-index=55, accessor/getter=53, species=25, delete=16,
  proto-chain-index=14. = HARD value-rep MOP substrate (typed WasmGC vecs
  don't implement per-index accessor / prototype-chain HasProperty /
  delete-during-iteration). Same wall as suspended #2773; the host lane hits
  it too, not just standalone. **No m-slice closes this — routed as a
  substrate finding (see below).**
- **arraylike-.call 86** (map32/filter27/forEach22/flatMap5) — SHARED path
  with #3201 (a64f272 length fix landed here). Mostly still needs accessor/
  defineProperty observability on the array-like object.
- **primitive-.call 9** (map3/filter3/forEach3) — `.call(false,cb)`
  ToObject(primitive) bails to the legacy `__proto_method_call` bridge that
  can't invoke the closure → "object is not a function".

Trap subset (soundness, 6): map/filter target-array-with-non-writable
(OOB, Symbol.species result), map/filter create-revoked-proxy (illegal cast,
Proxy), flatMap depth-always-one (illegal cast, array-of-array return),
flatMap array-like-objects-nested (null-deref). Most are species/Proxy-rooted
(hard); depth-always-one is the clean one.

### Landed in this slice (in-budget: src/codegen/array-methods.ts)
1. **flatMap non-callable mapper → TypeError** (§23.1.3.11 step 3). flatMap
   skipped the shared `emitCallbackTypeCheck` gate that map/filter/forEach run,
   so a missing/non-callable mapper fell through to host `__array_flatMap`,
   which wraps the value in an always-callable arrow — hiding the non-callable
   from native flatMap's IsCallable check → no throw. Added the gate at the top
   of `compileArrayFlatMap` (above the standalone arm → both lanes). Flips
   `flatMap/non-callable-argument-throws.js`.
2. **`ts.TypeFlags.ESSymbolLike` added to `isKnownNonCallable`'s
   NON_CALLABLE_FLAGS** — a symbol is never callable, so `[].flatMap(Symbol())`
   (and `.map/.filter/.forEach(Symbol())`) throw the spec TypeError. Covers the
   8th (symbol) assertion of non-callable-argument-throws and helps the whole
   HOF family. (Coordinated with #3201/dev-c-2 — owned here to avoid a shared-
   helper double-edit.)

### Routed OUT of this slice
- **depth-always-one illegal-cast trap** (priority a) — root-caused: host-lane
  flatMap returns an externref JS-array; the result coerces to the declared
  `T[][]` vec via `buildVecFromExternref` (type-coercion.ts:~450). Its
  `buildElemCoerce` (~:398) handles a **vec-typed ref element** with a naked
  `any.convert_extern; ref.cast_null` — but a nested JS sub-array is NOT a
  WasmGC struct → `illegal cast`. Fix = recurse: call the reserved
  `__vec_from_extern_<elemTypeIdx>` materializer (`vecFromExternFuncIdx`)
  instead of the naked cast. BUT the reserve pass
  (`reserveVecFieldMaterializers`, member-set-dispatch.ts) only reserves
  materializers for struct-FIELD vecs — the flatMap result is a local/expression
  coercion target it never sees, so no element materializer is reserved and the
  recursion can't be wired post-freeze. Needs reserve-pass support for nested-vec
  element types (type-coercion.ts + member-set-dispatch.ts — OUT of this issue's
  loc-budget, hot shared coercion infra). Filed for a coercion-infra task.
- **thisArg-argument** — host `__array_flatMap`'s `wrapped` drops `this`, and a
  compiled closure can't take an injected `this` through the JS bridge; needs
  the map/filter/forEach thisArg-closure machinery, not the host bridge. Deferred.
- **array-like-objects*** (null-deref traps) — flatMap absent from
  ARRAY_LIKE_METHOD_SET; `.call(arraylike,fn)` needs the shared array-like path
  + full FlattenIntoArray HasProperty-skip semantics. Shared with #3201, deferred.
- **this-value-ctor-*** — ArraySpeciesCreate @@species; species mechanism, hard.
