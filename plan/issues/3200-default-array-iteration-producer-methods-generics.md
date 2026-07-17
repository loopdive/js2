---
id: 3200
title: "default lane: Array.prototype iteration/producer generics (forEach/map/filter/flatMap) over real + array-like receivers (~204 fails)"
status: in-progress
created: 2026-07-12
updated: 2026-07-17
assignee: ttraenkler/fable-2
loc-budget-allow:
  - src/runtime.ts
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
