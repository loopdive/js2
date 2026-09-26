---
id: 2717
title: "Array flat/flatMap are host-import-only — no standalone native arm, no ctx.standalone guard"
status: done
sprint: 75
assignee: ttraenkler/dev-serve
created: 2026-06-26
updated: 2026-09-25
completed: 2026-09-25
priority: high
feasibility: medium
reasoning_effort: medium
task_type: fix
area: codegen
language_feature: standalone
goal: standalone-everything
parent: 2711
loc-budget-allow:
  - src/codegen/array-methods.ts
  # 2026-09-25 (#2717 native recursive flatten): +8 — the `flat`/`flatMap`
  # first-class member-body dispatch arm + their variadic-ABI entry.
  - src/codegen/array-object-proto.ts
  # 2026-09-25 (#2717): +3 — `$AnyValue` element materialization hook.
  - src/codegen/type-coercion.ts
func-budget-allow:
  # 2026-09-25 (#2717): +2 — boxed primitives bound for an `$AnyValue` vec slot
  # are classified via `anyvalue-elem-materialize.ts` instead of a trapping cast.
  - src/codegen/type-coercion.ts::buildVecFromExternref
coercion-sites-allow:
  # 2026-09-25 (#2717): one `__unbox_number` for flat's ToNumber(depth) — the
  # same helper the #6447 concat producer uses; an object depth skipping
  # ToPrimitive is a recorded under-approximation.
  - src/codegen/array-flat-native.ts
---
# #2717 — Array.prototype.flat / flatMap have no standalone arm

**Parent:** #2711 (standalone↔host differential parity gate). **Surfaced by**
the cross-backend harness: `[[1,2],[3,4]].flat()` does not compile/run on the
linear (standalone) backend.

## Root cause

`flat` / `flatMap` call `ensureLateImport("__array_flat" / "__array_flatMap")`
with **no `ctx.standalone` guard and no native (Wasm-only) arm**
(`src/codegen/array-methods.ts:8748` / `:8790`). In WASI / standalone there is
no JS host to satisfy that import, so the module **fails to instantiate** (and
the linear backend has no lowering at all → compile error). Host mode works
because the import is satisfied.

## Fix sketch (per #2711 policy)

- Add a Wasm-native lowering for `flat`/`flatMap` over WasmGC array element
  types, gated so standalone uses it.
- Until the native arm exists, the standalone/WASI path must **`reportError`
  (fail loud)** rather than emit an unsatisfiable import that traps at
  instantiate time — the #2711 fail-loud policy.

## Acceptance criteria

- [x] `flat`/`flatMap` either compile+run in standalone (agree with host on the
      cross-backend corpus) OR produce a tracked compile error — never an
      unsatisfiable late import.

## Resolution (2026-06-26) — fail-loud guard (#2711 policy)

`compileArrayFlat` / `compileArrayFlatMap` (`src/codegen/array-methods.ts`) now
gate on `ctx.standalone || ctx.wasi` and refuse loudly via `reportError` BEFORE
`ensureLateImport`, so the unsatisfiable `__array_flat` / `__array_flatMap` host
import is never registered. Host/gc mode is byte-unchanged.

**Why fail-loud, not a native arm.** Unlike #2719 (where the pure-Wasm
`__extern_strict_eq` / `__extern_same_value_zero` helpers already existed and the
fix was a one-line swap), flat/flatMap have NO native machinery. A real native
arm needs recursive flatten (variable depth + runtime `IsArray` per element +
dynamic result-array build over heterogeneous WasmGC element types), and flatMap
additionally needs callback invocation with mixed scalar/array returns — a large,
busy-`Object()`/array-method-surface change. Per the tech-lead's call and the
#2711 policy, a marginal single-feature standalone gain is not worth a risky
partial native flatten on the surface that produced the #2149/#2702 merge_group
regressions this sprint. The native arm is a tracked follow-up.

**Sticky-error mechanism.** A naïve `reportError(...) + return null` is SILENTLY
SWALLOWED here: the `a.flat().length` outer access wraps the `a.flat()` compile
in the #1919 speculative transaction, and `rollbackSpeculative` truncates
`ctx.errors` on a null inner result, then emits a default — so standalone
`flat().length` compiled to a silent-wrong `0`. The guard instead returns a
NON-NULL `externref` (matching the host result) and emits `unreachable`, so the
speculative wrapper COMMITS, the diagnostic survives, and the compile fails loud
(mirrors the `RegExp.escape` brand-check refusal at `calls.ts:4831`).

Verified (`tests/issue-2717.test.ts`, 5 cases): standalone `flat()` / `flat(1)` /
`flatMap()` produce a tracked compile error with zero `__array_flat*` imports;
host `flat()` → 4, `flatMap()` → 6 unchanged. Existing `flatmap-closure` /
`issue-1718-flatmap` host tests pass; `tsc` + prettier clean.

**Follow-up (not in scope):** a Wasm-native flat/flatMap arm (and the linear
backend lowering) to turn the compile-error into compile+run in standalone.

## Reopened 2026-07-20 (stale false-done review)

Marked `done` but live test262 shows: Array.prototype.flatMap() still 'not yet supported in --target standalone'. Reopened as `ready`. See #3474 (done-status integrity).

## Resolution 2026-07-22 — native standalone flatMap arm (dev-serve)

**PR:** `issue-2717-flatmap-standalone-native`. Adds the Wasm-native standalone
`Array.prototype.flatMap` arm, closing the reopened gap. (`flat()`'s native
depth-1 arm already landed as #3363.)

### Approach — `flatMap(cb)` ≡ `map(cb).flat(1)`, reusing existing native code

`compileArrayFlatMap` (`src/codegen/array-methods.ts`), in the
`ctx.standalone || ctx.wasi` arm, now tries `tryCompileFlatMapNative` before the
loud refusal. That helper compiles the native `map` (arg layout — arg0 = cb,
arg1 = thisArg — matches flatMap's) directly, then dispatches on the RESULT vec's
element type (ground truth for what the callback returned):

- element is a nested vec (callback returned arrays) → the #3363 depth-1 flatten,
  refactored into a reusable `emitFlattenDepth1FromVec` + `canFlattenVecElem`
  (byte-inert extraction — `tryCompileArrayFlatNativeDepth1` and all 11 #3363
  tests unchanged);
- element is a concrete scalar / non-array ref (scalar or plain-object callback)
  → `flatMap` ≡ `map` (a depth-1 flatten of non-arrays is the identity), so the
  map result is the answer;
- element is `externref`/`anyref` (dynamic) → drop + refuse loudly.

### A-priori empty-`[]` guard (the one correctness edge)

An inline callback whose body contains a bare empty array literal `[]` compiles —
under flatMap's `U | readonly U[]` contextual type — to a closure whose empty `[]`
resolves to a different vec type than a sibling non-empty array (a Wasm fallthru
type error). The static return type does NOT discriminate this, and the invalid
closure is a global module side effect the native `map` cannot roll back — so
`inlineCallbackHasEmptyArrayLiteral` catches it BEFORE compiling map and refuses
loudly. Over-conservative but never invalid Wasm; the underlying conditional-`[]`
vec-type bug is tracked as **#3532**.

### Proofs

- Standalone `flatMap` runtime-correct for array callbacks
  (`[1,2,3].flatMap(x=>[x,x*2])` → 6, sum 18), string arrays (→4), scalar
  callback (`x=>x` → 3, ≡ map); zero `__array_flatMap` imports.
- **Zero invalid-Wasm** across the full boundary corpus (array/scalar/variable
  conditionals run-correct; every bare-`[]` shape and explicit-depth `flat(1)`
  fail loud, never trap).
- **test262 standalone lane: 0 → 9 passes** across
  `built-ins/Array/prototype/flatMap` (all 24 previously fail-louded, so no
  regression possible; `depth-always-one.js` passes → correct depth-1 semantics).
- **Host/gc mode byte-unchanged** (native arm gated on standalone||wasi;
  `issue-2717` host section + `issue-1718-flatmap` pass).
- `issue-3363` (11), `issue-3098`/`issue-3162` HOF, `array-methods`,
  `functional-array-methods`, `flatmap-closure` suites pass (the single
  `issue-2001-s2` reduce-standalone failure is PRE-EXISTING on origin/main,
  verified by control run). `tsc`/`biome`/`prettier` clean.

### Still open (follow-ups, NOT this PR)

- **#3532** — conditional bare-`[]` under a union contextual type mistypes the
  closure (removes the a-priori guard once fixed).
- Variable-depth recursive `flat(depth)` / `flatMap` with dynamic
  scalar-or-array (heterogeneous) returns — needs a runtime-IsArray flatten.

## Implementation Plan (executed 2026-09-25)

Close the remaining standalone gap — hono's first `standalone-dynamic` blocker
(`[path].flat()` over an `any` element) — with one Wasm-native recursive
FlattenIntoArray instead of more static-shape arms.

1. New module `src/codegen/array-flat-native.ts`:
   - `__arr_flatten_into(target, source, depth: f64)` — ECMA-262 §23.1.3.13.1,
     reading through `__extern_length` / `__extern_has_idx` / `__extern_get_idx`
     / `__extern_is_array` (serves typed `__vec_<k>`, `$ObjVec` and array-like
     `$Object`s), pushing into a `$ObjVec` with `__objvec_push`; holes skipped;
     `+Infinity - 1` stays infinite.
   - `__arrprod_flat(recv, args)` / `__arrprod_flatMap(recv, args)` — §23.1.3.13
     / .14 entry points (RequireObjectCoercible, ToIntegerOrInfinity(depth),
     IsCallable, `__apply_closure(cb, thisArg, [el, i, O])`).
   - Three call surfaces: `compileArrayFlatNativeCall` (typed call sites),
     `emitArrayFlatProtoMemberBody` (first-class `Array.prototype.flat.call`),
     and the dyn-array-producer dispatcher arm (`any` receivers, via
     `DYN_ARRAY_PRODUCER_METHODS`).
2. `array-methods.ts`: `compileArrayFlat` falls back to the generic helper after
   the #3363 depth-1 arm; `tryCompileFlatMapNative` routes a statically dynamic
   callback return (`union`/`any`/`unknown`, `flatMapReturnIsDynamic` in
   `array-flatmap.ts`) to `__arrprod_flatMap`, and flattens a map result with
   `externref` elements per element. The custom-species (`externref` map result)
   path stays fail-loud.
3. `anyvalue-elem-materialize.ts` + `buildVecFromExternref`: materializing a
   dynamic `$ObjVec` into a `(string | number)[]` (`$AnyValue`) vec used to
   `ref.cast` boxed primitives and trap ("illegal cast"); non-`$AnyValue`
   elements now go through the module's `__any_from_extern` classifier.
4. JS-host lanes byte-identical (every new arm is gated on `ctx.standalone`).

## Resolution 2026-09-25 — native recursive flat/flatMap (sendev-standalone)

**Mechanism.** One recursive Wasm-native `__arr_flatten_into` over the dynamic
array-like substrate, with `__arrprod_flat` / `__arrprod_flatMap` entry points
wired into typed call sites, the `any`-receiver dispatcher and the first-class
`Array.prototype.flat/flatMap` values. Zero host imports.

**Evidence.**
- Regression test `tests/issue-2717-native-flatten.test.ts`: 14/14 pass;
  13/13 of the then-present cases FAIL on the parent (compile error or wrong
  value — e.g. `id([1,[2,3],[4]]).flat().length` was a silent `0`).
- Scoped standalone test262 `built-ins/Array/prototype/{flat,flatMap}` (43
  rows, `--isolate`): parent **14 pass / 10 fail / 19 CE** → fix **28 pass /
  14 fail / 1 CE**; +14, zero losses.
- Wider standalone slice (`Array/prototype/{concat,map,slice,filter}`,
  `Array/{from,of}`, 661 rows): 530 pass both sides, identical non-pass set.
- JS-host byte-identical on 7 flat/flatMap/concat samples; hono JS-host
  dogfood 271/324 (unchanged).
- hono `standalone-dynamic` lane: before `compile-error` —
  "Codegen error: Array.prototype.flat() is not yet supported in --target
  standalone/wasi (#2717) …"; after `host-import-error` — "standalone binary
  retained 8 host import(s)" (`env.addEventListener`, `env.Headers_new`,
  `env.URL_new`, `env.URL_set_pathname`, `env.URL_get_pathname`,
  `env.Request_new`, `env.Response_new`, `env.Request_get_method`).

**Recorded under-approximations.** ArraySpeciesCreate is a plain `$ObjVec`
(same as the #6447 `concat` producer); ToNumber(depth) does not run
ToPrimitive on an object; the 2^53-1 TypeError is unreachable. A custom-species
receiver with an array-returning flatMap callback stays fail-loud.

**Tests updated.** `tests/issue-3363.test.ts` and `tests/issue-2717.test.ts`
asserted `flat(depth)` / a dynamic scalar-or-array flatMap callback refuse
loudly; both now assert the correct runtime value.
