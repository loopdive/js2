---
id: 1334
title: "spec gap: Object.defineProperty — descriptor attribute fidelity (664 test262 fails, biggest single bucket)"
status: done
created: 2026-05-08
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: object
goal: spec-completeness
sprint: 50
parent: 1328
---
# #1334 — Object.defineProperty: descriptor attribute fidelity

## Problem

`built-ins/Object/defineProperty` test262 bucket is the single largest fail bucket in the
audit: **467 / 1131 pass (41.3%) — 664 fails (600 assertion_fail, 32 other, 16 runtime_error,
7 type_error, 5 wasm_compile)**.

Spec §10.1.6 (OrdinaryDefineOwnProperty) and §20.1.2.4 (Object.defineProperty) require:

1. **Property attributes** (`writable`, `configurable`, `enumerable`) tracked **per property**.
2. **Accessor properties** (`get`/`set`) stored separately from data properties.
3. **Type-checking** the descriptor — non-object descriptors throw TypeError.
4. **Validating** descriptor invariants: a non-configurable property cannot become configurable,
   non-writable cannot become writable, the descriptor type cannot flip from data to accessor, etc.
5. **Coalescing** missing descriptor fields with defaults (writable/configurable/enumerable default
   to false; data-descriptor `value` defaults to undefined).

The current js2wasm implementation in `src/codegen/object-ops.ts` and `src/runtime.ts`:
- Sets the field value but **does not record the attribute flags** for typed structs.
- Only the externref/host path retains attributes (it forwards to host `Object.defineProperty`).
- For typed (struct-backed) objects, redefining a non-configurable property silently succeeds.

## Acceptance criteria

1. `built-ins/Object/defineProperty/15.2.3.6-3-*` (descriptor coalescing) tests pass.
2. `built-ins/Object/defineProperty/15.2.3.6-4-*` (configurable invariants) tests pass.
3. `built-ins/Object/defineProperty/15.2.3.6-5-*` (writable invariants) tests pass.
4. Pass-rate for `built-ins/Object/defineProperty` rises from 41.3% to ≥75%.
5. Object.defineProperties and Object.create(o, descriptors) inherit the fix.

## Files to modify

- `src/codegen/object-ops.ts` — descriptor compilation, attribute storage
- `src/codegen/property-access.ts` — attribute checks on get/set/delete
- `src/runtime.ts` — runtime helpers for typed-object descriptor table

## Implementation Plan

### Root cause

Typed (WasmGC struct) objects have no attribute storage — every property is implicitly
`{writable:true, configurable:true, enumerable:true}`. The descriptor passed to
`Object.defineProperty` is parsed for its `value` but the attribute bits are dropped on the floor.

### Approach

Add a parallel attribute-table struct to typed objects:

```
(type $AttrEntry (struct (field $key (ref string)) (field $flags i32)))
;; flags: bit 0 = writable, bit 1 = enumerable, bit 2 = configurable, bit 3 = isAccessor
(type $AttrTable (array (mut (ref null $AttrEntry))))
;; Object struct gains an extra (mut (ref null $AttrTable)) — null means "all defaults".
```

When `Object.defineProperty` is called:
1. Parse the descriptor (a JS object) into `(value, flags)` pairs at compile time when possible,
   or at runtime via `__parse_descriptor` host import.
2. Lazily allocate `$AttrTable` on first non-default-attribute write.
3. On subsequent writes, look up by key and validate invariants.

### Edge cases

- Descriptor is null/undefined → TypeError at the call site.
- Descriptor has both `value` and `get` → TypeError (data + accessor mix).
- Descriptor argument is a Proxy → must trap on `[[Get]]` for each known key.
- Property already non-configurable → reject incompatible redefinition (return false in
  Reflect.defineProperty / throw in Object.defineProperty).

### Test262 sample

- `test262/test/built-ins/Object/defineProperty/15.2.3.6-1-1.js` (undefined → TypeError)
- `test262/test/built-ins/Object/defineProperty/15.2.3.6-3-1.js` (default attribute coalescing)
- `test262/test/built-ins/Object/defineProperty/15.2.3.6-4-82.js` (non-configurable invariants)

## ⚠️ ADJUDICATION 2026-07-26 (opus-loop-e, task #24) — CLOSED ON VACUOUS EVIDENCE

**Verdict: hypothesis (2). This issue was closed against a harness that could
not report failure.** Not a partial slice — the evidence itself was vacuous. The
call is recorded here rather than acted on silently; see "Disposition" below.

### The measurement

Direct test, sharper than re-estimating a pass rate: take tests the **baseline
records as `pass`** in this issue's own directories and re-run them on current
HEAD, which is **post-#3603 de-inflation**. A baseline-`pass` that now fails is a
test that was passing vacuously — i.e. exactly the evidence this issue closed on.

- baseline-`pass` population in `built-ins/Object/{defineProperty,defineProperties,create}`: **1,532**
- sampled **90** (deterministic seed): **80 still pass, 10 now FAIL, 0 other**
- **11.1 % of sampled baseline-passes no longer pass** → ~170 of the 1,532
  (order-of-magnitude; a sample, not a census)

**And the failures are this issue's own subject matter** — every one is a
descriptor-attribute assertion:

```
15.2.3.7-6-a-272  descriptor should not be enumerable; should not be writable
15.2.3.6-4-229    descriptor value should be undefined; should not be enumerable
15.2.3.6-3-171-1  descriptor should be writable
15.2.3.6-4-354-6  descriptor should not be writable
15.2.3.7-6-a-163  value should be 1; descriptor should not be writable
```

That is the `verifyProperty` / `propertyHelper.js` vacuity signature
(#3468/#3592/#3434): the attribute assertions were not being reported at all, so
the tests registered as passing. #1334 measured a harness, not the compiler.

### Why the pass-rate route was inconclusive (recorded so it is not redone)

Acceptance criterion 4 was "pass-rate rises from 41.3 % to ≥ 75 %". The cached
baseline shows `defineProperty` at 855/1131 = **75.6 %**, which *appears* to meet
it — but that baseline **predates de-inflation**. A bounded random sample of 120
files on current HEAD gives **68.3 % (95 % CI ±8.3)**. The CI still touches 75 %,
so the rate alone cannot settle it — which is why the baseline-pass re-run above
is the decisive test. **Do not quote 75.6 % as this issue's achieved rate.**

### Disposition

**Left `done`, with this correction attached — not silently reopened.** The code
this issue landed is real and still present; what was wrong is the *evidence* for
its completeness, and the remaining work is already owned elsewhere
(#739 for store-unification, #3653 for `writable`/`configurable` reporting,
#3647 for `enumerable`). Reopening would duplicate live issues. The value here is
the corrected record.

### Consequence — a class of issues, not just this one

**Any issue closed on test262 pass-rate evidence in a `verifyProperty`-covered
area before #3603 landed is suspect on the same grounds.** Twenty issues carry
`completed: 2026-05-2x`; the descriptor/property-attribute ones are the exposed
set. This has NOT been swept — it needs its own task, and it is a bigger finding
than #1334 alone. Recommended check is cheap and mechanical: re-run each issue's
cited tests and diff against the baseline's recorded status, as done above.

**Method:** the general rule this instance supports — *a green test proves the
harness reported nothing, not that the behaviour is correct.* Verify any
pass-rate claim in this area against a post-de-inflation tree.
