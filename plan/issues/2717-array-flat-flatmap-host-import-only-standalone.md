---
id: 2717
title: "Array flat/flatMap are host-import-only — no standalone native arm, no ctx.standalone guard"
status: done
sprint: 75
assignee: ttraenkler/dev-serve
created: 2026-06-26
updated: 2026-07-22
completed: 2026-07-22
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
