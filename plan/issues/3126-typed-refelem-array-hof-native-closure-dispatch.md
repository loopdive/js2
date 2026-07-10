---
id: 3126
title: "Typed ref-element array HOFs (find/filter/every/…): admit native closure dispatch — retires the typed string[] __make_callback leak (#3098 boundary) and fixes silent gc-lane no-ops on struct arrays"
status: done
completed: 2026-07-10
assignee: ttraenkler/fable-3098r
sprint: current
model: fable
created: 2026-07-10
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, standalone
language_feature: callbacks, higher-order-functions, arrays
goal: standalone-mode
umbrella: 2860
parent: 3098
related: [3098, 3015, 2688, 1967, 2939, 2379]
origin: "#3098 implementation-notes boundary: 'typed string[] receivers of find/filter/… still leak __make_callback' (S5 candidate, separate PR)"
---

# #3126 — typed ref-element array HOF dispatch: native closure path

## Problem (verified against origin/main @ 6c122b63b2aed, 2026-07-10)

The typed array-HOF dispatch gates in `compileArrayMethodCall`
(`src/codegen/array-methods.ts:3473-3553`) admit only `f64 | i32 | externref`
element kinds for `find`/`findIndex`/`findLast`/`findLastIndex`/`filter`/
`every`/`some`/`forEach`/`reduce`/`reduceRight`. A receiver whose elements are
**GC refs** — a native-string `string[]` vec on the standalone/wasi lanes, or
an object-struct `T[]` array on EVERY lane — falls through to the generic
fallback, which is broken in two lane-specific ways:

1. **Standalone/wasi** (probe `.tmp/probe-3098r-typedstr.mts`): the fallback
   materializes the callback via `env.__make_callback` — an unsatisfiable host
   import; the module fails instantiation. All 9 non-`map` HOF methods leak on
   a typed `string[]` receiver (`map` is native via the #2688-widened gate;
   `number[]` is native via the numeric gate):

   ```
   str-find/filter/findIndex/findLast/findLastIndex/every/some/forEach/reduce:
     LEAK: env.__make_callback
   str-map-control:    HOST-FREE PASS
   num-find-control:   HOST-FREE PASS
   ```

2. **gc host lane** (probe `.tmp/probe-3098r-gclane.mts`): for struct arrays
   with HOST-FREE callback bodies the same fallback is a **silent vacuous
   no-op** (the host cannot iterate a WasmGC vec struct):

   ```
   objs.find(o => o.x > 1)          → undefined (want {x:2})
   objs.filter(o => o.x > 1).length → 0  (want 2)
   objs.some(o => o.x === 2)        → false (want true)
   ```

   This is the #1837/#3088 vacuity class: wrong results, no error. **BUT**
   (measured on PR #2838's first merge-group attempt — see the reversal note
   below) the fallback is NOT universally broken on gc: for callbacks whose
   BODIES reference host globals or host-object methods it is the ONLY
   working path, so the gc lane keeps it (this issue fixes standalone/wasi
   only; the gc struct-array vacuity stays a named residual).

## Root cause

The 10 gates predate ref-element support and were never widened when `sort`
(#1967) and `map` (#2688) were. The typed loop machinery itself is already
element-kind agnostic **on the closure path**: `buildClosureCallInstrs` does
`call_ref` with `coercionInstrs(elemType → closureParamType)` (a no-op for
matching refs, `extern.convert_any` for `any`-typed params), and the type
registry normalizes ref-element arrays to nullable elements
(`getOrRegisterArrayType`, registry/types.ts:108-110), so `array.new_default`
(filter result alloc) and elem locals are valid.

The only genuinely elem-kind-specific pieces:

- `compileArrayFind`/`compileArrayFindLast` type their result local per elem
  kind (f64 + NaN sentinel / externref + null-extern sentinel) — a ref element
  needs the element's **nullable ref** with a `ref.null <typeIdx>` "not found"
  sentinel (the typed lane's `undefined` rep, same as `pop()`/`at()` misses).
- The NON-closure fallback (`buildBridgeCallInstrs` → `__call_1_f64`) converts
  the element to the host bridge's f64 argument; a GC struct element has no
  such lowering (`bridgeElemConvertInstrs` returns `[]` → invalid Wasm). That
  opaque-externref-callback residual is exactly **#3015** and stays on its
  current path.

## Fix (this PR)

1. `refElemHofCallbackIsClosure(ctx, fctx, callExpr)` — admit a ref-element
   receiver iff the callback **provably compiles to a GC closure struct**:
   inline arrow/function-expression (always `compileArrowAsClosure`), else a
   transactional probe-compile (#1919 machinery) checking
   `ctx.closureInfoByTypeIdx`. Missing/known-non-callable callbacks are also
   admitted (the typed impls emit the spec §23.1.3 step-3 TypeError — strictly
   better than the vacuous fallback).
2. Widen the 10 gates: `hofElemKindOk(elemType)` = old kinds ∪
   (`ref`/`ref_null` ∧ **standalone/wasi lane** ∧ closure-callback). The gc
   host lane is NOT widened — see the merge-group reversal note below.
3. `compileArrayFind`/`compileArrayFindLast`: ref-element result rep =
   `{ref_null, elemTypeIdx}` local + `ref.null` sentinel; return that type
   (reachable only via the widened lanes, byte-inert on gc).

Non-closure (opaque externref) callbacks on ref-element receivers keep the
current fallback — #3015's slice. `sort(cmp)`/`flatMap`/`Array.from` remain
#3098 S4. Dynamic (`any`) receivers are untouched (#3098's landed `__hof_*`
path).

## Acceptance criteria

1. All 9 leaking typed `string[]` probe shapes compile HOST-FREE standalone
   (zero imports), instantiate with an empty import object, and return correct
   values; `map`/`number[]` controls unchanged.
2. gc-lane emission byte-identical to main (the lane is not widened).
3. `prove-emit-identity` main-vs-branch: byte-identical on corpus files not
   using ref-element HOF receivers.
4. Zero regressions vs the honest baseline (merge_group gates).

## Implementation notes (fable-3098r, 2026-07-10)

### MERGE-GROUP REVERSAL — why the gc lane is NOT widened (the key lesson)

The first version of this PR widened the gate on ALL lanes, on the argument
"the gc fallback is measurably broken too (struct-array vacuity), so there is
no working behavior to preserve." **That argument was wrong, and the
merge_group caught it**: PR #2838's first merge-group attempt regressed
**212 tests, all `built-ins/Temporal/*`** (net −145; auto-park `hold`).

Mechanism (verified locally, `.tmp/dump-ceil.ts` +
`JS2WASM_3126_ONLY=forEach` bisect): the Temporal tests' top-level
`expected.forEach(([unit, pos, neg]) => { TemporalHelpers.assertDuration(
instance.round({...}), ...) })` iterates a **ref-element tuple array** — so
the widened gate re-routed the callback from `compileArrowAsCallback`
(`__make_callback`, host-lifted) to `compileArrowAsClosure` (GC closure).
`Temporal` and `TemporalHelpers` are **HOST globals** (src/runtime.ts) that
are NOT in the compiled module's scope — the host-lifted path resolves them,
the closure-lifted path compiles them to `"TemporalHelpers is not defined"`
runtime throws. So on the gc lane the fallback is the ONLY working path for
host-global-referencing callback bodies, and the vacuity probe result
("`objs.find` is a no-op on gc") holds only for HOST-FREE bodies. The
attribution method that pinned this: diff my merge-group merged-report
against predecessor PR #2815's merge-group merged-report (identical state
minus my PR) — 212/212 flips attributable to my PR, 100% under
`built-ins/Temporal/`.

Consequences baked into the final PR:

- The widening carries `(ctx.standalone || ctx.wasi)` — lanes where
  `__make_callback` is **unsatisfiable**, so re-routing can only gain.
- gc emission is byte-identical to main (verified by shape-hash probe:
  `gcstr gc`, `ident/opaque/numeric` all match current origin/main).
- The gc struct-array vacuity is a NAMED RESIDUAL (below), whose real root
  is **closure-lifted host-global/host-method resolution**, not this gate.
- Sample validation: 31/31 of the 212 regressed Temporal files (every 7th)
  pass on the re-scoped branch.

### Design WHYs

- WHY gate on closure-provability instead of fixing the bridge for ref
  elements: the bridge's f64 ABI fundamentally cannot carry a GC struct; a
  `drop + NaN` coercion would trade invalid Wasm for silently-wrong callback
  args. Admitting only provable closures means the widened path is exactly the
  `call_ref` path, and every previously-working shape (numeric/externref
  elems, opaque callbacks) is byte-identical.
- The probe in the gate runs at most once per call site (only for ref-element
  receivers of the 10 methods on standalone/wasi) and is fully rolled back
  (#1919 `probeCompiledType` restores body/locals/imports/errors).

### Validation (post-#3127 merge state)

- `.tmp/probe-3098r-typedstr.mts` (standalone): all 9 previously-leaking
  shapes → HOST-FREE PASS; `map`/`number[]` controls unchanged.
- `.tmp/probe-3126-edges.mts` (standalone): identifier-closure admission,
  2-/3-arg arity, chained filter→find, find/findLast miss → `undefined`,
  reduce seed-from-first / empty-throw / reduceRight, native-string
  truthiness, forEach capture, some early-exit, struct arrays,
  opaque-`any`-callback parity — PASS.
- Explicit `thisArg` + function-expression callback: host-free PASS
  (`.tmp/probe-3126-thisarg.mts`).
- Temporal restoration: the 3 named repros + 31/31 sampled regressed files
  pass on the gc lane.
- Shape-hash probe vs current origin/main: gc hashes identical everywhere;
  standalone differs ONLY on the ref-elem HOF shape (the fix).
- `prove-emit-identity` vs current origin/main: all 39 (file,target) hashes
  across gc/standalone/wasi — IDENTICAL (corpus has no ref-elem HOF sites).
- test262 cluster (`built-ins/Array/prototype/{map,filter,forEach,reduce,
reduceRight,every,some,find,findIndex,findLast,findLastIndex}`, 1,699 files
  × gc+standalone = 3,398 rows, run on the all-lanes draft which is a
  superset of this final gate): **zero flips** either direction.
- `tests/issue-3126.test.ts` green (gc struct-array cases are documented
  skips); suites 3098/array-methods/array-prototype-methods/3031 green.
- Gates: tsc, biome lint (error level), prettier, loc-budget (in-module
  growth, baseline regen), coercion-sites, speculative-rollback — all OK.

### Discovered residuals (pre-existing, byte-identical to main — NOT this PR)

1. **Identifier-held closure on a typed `string[]` HOF is wrong on BOTH
   lanes** (`const f = (s: string) => …; a.find(f)` → miss standalone, "fn is
   not a function" on gc). The call site never reaches the typed dispatch —
   it routes through an `__apply_closure` dynamic path; branch emission is
   byte-identical to main (sha256-verified). The gate's probe correctly
   rejects it (`f` compiles to externref, no ClosureInfo). Adjacent to
   #3015/#2939 — needs a PO issue on the identifier-callback compile shape.
2. **gc-lane externref find/findLast miss `=== undefined` compares false**
   (`["alpha"].find(s => s === "zz") === undefined` → false on the gc lane;
   the miss sentinel is `ref.null.extern` and the comparison lowers to 0).
   Pre-existing, emission byte-identical to main; the 2 `it.skip`s in
   `tests/issue-3126.test.ts` document it. Needs a PO issue on the externref
   miss-rep equality.
3. **gc-lane struct-array HOF vacuity** (`objs.find/filter/some` with a
   host-free callback body are silent no-ops through the `__make_callback`
   fallback — `.tmp/probe-3098r-gclane.mts`). Deliberately NOT fixed here
   (see the merge-group reversal note): widening the gc gate breaks
   host-global-referencing callback bodies (Temporal). The real fix is
   **closure-lifted host-global/host-object-method resolution** (make
   `compileArrowAsClosure` bodies resolve `Temporal`-class host globals), OR
   a body-scan that routes host-free bodies natively. Needs a PO issue; the
   4 gc `it.skip`s in `tests/issue-3126.test.ts` document it.
