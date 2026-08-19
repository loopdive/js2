---
id: 3420
title: "Write to a frozen Array element is silently honored instead of throwing TypeError (verifyProperty corpus)"
status: done
completed: 2026-07-31
assignee: ttraenkler/dev-es5-coercion
created: 2026-07-18
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: es5
model: fable
sprint: 78
horizon: m
related: [3370, 3417, 3335, 3189]
# The standalone follow-up extends the existing vec descriptor-overlay owner
# with numeric-key reflection, ordinary [[Set]], and semantic delete markers.
# These finalize-time splices share the overlay's private companion-table ABI;
# extracting them would duplicate that state machine rather than isolate a
# subsystem. The implementation therefore remains in its owning module.
# (2026-07-31) The frozen-write consult must sit in assignment.ts beside the two
# pre-existing `frozenVars` consults it completes — `emitAssignToTarget` (~L2667)
# and the property-assign path (~L3568). The whole defect WAS that those two
# cover only `PropertyAccessExpression`; putting the ElementAccess twin in a
# different module would re-separate the three checks that must stay in sync and
# would require exporting `compileElementAssignment`'s internal fctx/emit
# plumbing purely to relocate ~50 lines. Growth is intended and local.
loc-budget-allow:
  - src/codegen/vec-overlay.ts
  - src/codegen/expressions/assignment.ts
func-budget-allow:
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/expressions/assignment.ts::compileElementAssignment
---

# #3420 — element write to a frozen Array is silently honored

> **RE-GROUND (2026-07-31) — the filed symptom no longer reproduces.**
> Re-measured against current `main` before implementing. The originally filed
> uncatchable `array element access out of bounds` trap is **gone**: the #2744
> integrity substrate landed (`status: done`) and #3742/#3750 took the two
> narrow slices. Running the named corpus:
>
> | named test                                                    | result on main |
> | ------------------------------------------------------------- | -------------- |
> | `built-ins/Object/freeze/15.2.3.9-2-c-1.js`                   | **PASS**       |
> | `15.2.3.9-2-c-2/3/4.js`                                       | fail — `wasm closure dispatcher __call_fn_0 is not available` (unrelated cause) |
> | `Array/prototype/pop/set-length-array-length-is-non-writable.js` | fail — wrong value, **no trap** |
>
> **No test produced the `oob` trap.** The live defect is different and worse: a
> frozen array's element write is **silently honored**. `assert.throws(TypeError, …)`
> then sees neither a throw nor a wrong value, so the failure is invisible.
> The old symptom text is kept below under "Superseded symptom" rather than
> deleted, so the history stays legible.

## Superseded symptom (filed 2026-07-18, no longer reproduces)

> **RE-SCOPE (2026-07-24).** Per measurement, this splits into two very
> different-sized pieces:
>
> - **Tractable now (narrow):** the **2-test `filter`/`map` `Symbol.species`
>   result-backing** slice — the HOF result array's element store traps `oob`
>   instead of honoring the (species-constructed) result backing. That is a
>   bounded result-array-write fix, dev/Fable-tier.
> - **NOT tractable as a point-fix (the bulk):** general **frozen / non-writable
>   Array element write** semantics (strict→TypeError, sloppy→no-op) require the
>   **#2744 extensibility-slot substrate** (per-element `[[Writable]]` +
>   frozen/sealed/preventExtensions queries on the fast array-store path). This
>   is senior-dev / Fable-tier substrate, not a scoped codegen tweak.
>
> Kept `status: ready` but **flagged**: only the narrow species-result slice is
> dev-claimable; the frozen-write bulk is blocked on #2744. `model: fable` stays.

## Problem

Under the honest v8 harness, `propertyHelper.js::verifyProperty` and frozen-array
tests exercise writes to non-writable / frozen Array elements. Instead of throwing a
catchable `TypeError` (strict) or silently no-op'ing (sloppy), the compiler emits an
**uncatchable `unreachable`/`oob` trap**:

```
array element access out of bounds [in verifyProperty() ← __module_init]
```

Because the trap is uncatchable, `assert.throws(TypeError, …)` can't catch it and the
test fails; it also drove the merge-group **oob 45→49 (+4)** trap-growth flag on the
oracle-v8 refresh.

Measured (oracle-v8, run 29634290540): 19 tests newly `oob` vs v7 (11 were v7-pass),
in the Object.freeze / Array.prototype non-writable-target family:

- `built-ins/Object/freeze/15.2.3.9-2-c-*.js`
- `built-ins/Array/prototype/{splice,unshift,pop,reverse,slice,map,filter}/…non-writable…`
- `built-ins/Promise/all{,Settled}/resolve-element-function-{length,name}.js`
  Plus a larger latent propertyHelper corpus once #3419 (Duplicate identifier) unblocks
  compilation.

## Root cause

Array element assignment lowers to a bounds-checked store that traps on a
non-writable / frozen (or length-locked) element rather than consulting the element's
`[[Writable]]`/extensibility slot and taking the spec path (throw TypeError in strict,
no-op in sloppy). Frozen/sealed/non-writable state (from `Object.freeze` /
`defineProperty` with `writable:false`) is not honored on the fast array-element write
path. Related slot machinery: #2744 (extensible/preventExtensions/seal/freeze
queries).

## Implementation Plan

- Locate the array element **store** lowering (`src/codegen/expressions.ts` assignment
  path + `src/codegen/array-methods.ts` for the prototype mutators splice/unshift/pop/
  reverse). On a write to an element whose descriptor is non-writable, or whose array
  is frozen / element index is non-configurable/length-locked:
  - **strict mode** → throw a real `TypeError` (catchable) — reuse the existing
    TypeError-throw helper so `assert.throws(TypeError)` matches (see #3287 patterns).
  - **sloppy mode** → silently ignore the write (no trap), return the RHS.
- Route the frozen/non-writable query through the extensibility-slot machinery
  (#2744) rather than a raw bounds/`unreachable` trap.
- Ensure the prototype mutators (splice/unshift/pop/reverse) that relocate elements
  also honor per-element writability and throw/short-circuit correctly.

### Edge cases

- Genuine out-of-bounds (index ≥ length on a NON-frozen array that should extend) must
  still extend, not throw.
- `length` non-writable (frozen array) → setting `length` throws TypeError.
- Distinguish "index out of allocated capacity" (grow) from "element non-writable"
  (throw/no-op) — today both collapse to oob.

## Verification

- Scoped: the 19 listed tests + `Object/freeze/15.2.3.9-2-c-*` pass; assert.throws
  catches the TypeError.
- Confirms as a real spec-fidelity fix, not oracle skew: these throw catchably rather
  than trapping.
- Zero-regression on ordinary array growth/mutation.

## Notes

Filed per coordinator request as the REAL bug behind the oracle-v8 oob +4 trap flag
(#3335/#3189). The trap growth itself was within #3370's declared ceiling and
promoted via a one-time forced refresh; this issue fixes the underlying gap.

---

## Measured root cause (2026-07-31)

`Object.freeze` records integrity two ways: the compile-time `ctx.frozenVars`
set (`markIntegrity` in `call-builtin-static.ts`) and a runtime WeakSet via the
`__object_freeze` host import. Both work — `Object.isFrozen(a)` already returns
`true` for a frozen array, so the #2744 query substrate is fine.

The gap is on the **write** side. `frozenVars` had exactly two consult sites in
`src/codegen/expressions/assignment.ts` — `emitAssignToTarget` (~L2667) and the
property-assign path (~L3568) — and **both test `ts.isPropertyAccessExpression`**.
So only `o.x = v` was ever checked. `ElementAccessExpression` (`a[i] = v`) never
consulted the frozen bit at all and fell straight through to the vec store,
which stored anyway and grew the backing array for an index past the end.

Fix: `tryEmitFrozenElementWriteNoOp`, consulted at the top of
`compileElementAssignment` before any store path. It mirrors the existing #2667
mapped-arguments precedent — evaluate the key and the RHS for their side effects
(§13.15.2 order), then fail the Set: strict mode throws a catchable `TypeError`,
sloppy mode is a silent no-op whose result is the RHS. Per §10.4.2.1 a frozen
object fails EVERY element write (own data properties non-writable **and**
non-extensible), so no per-index descriptor lookup is needed.

The fix is compile-time only — no new host import — so it holds in **both**
lanes.

## Test Results (2026-07-31)

`tests/issue-3420.test.ts` — **16/16 pass** (13 host, 3 standalone).

A/B on one probe set, same harness, stock `main` vs this branch:

| | stock main | with fix |
| --- | --- | --- |
| probes passing | **9 / 13** | **13 / 13** |

The +4 delta is exactly the four frozen-element-write probes; the nine that
already passed (ordinary write, grow, unfrozen-no-throw, seal, `isFrozen`,
frozen **property** write, unrelated-array, and both side-effect probes) are
unchanged — zero regressions.

| probe | stock main | with fix |
| --- | --- | --- |
| frozen elem write → catchable TypeError | no throw (`0`) | **`1`** |
| frozen elem write leaves element | `99` (stored!) | **`1`** |
| frozen append past end → TypeError | no throw (`0`) | **`1`** |
| frozen array does not grow | `4` (grew!) | **`3`** |

Standalone lane: **6/6**, each asserting `imports.length === 0` — proven
host-free, so this counts toward the standalone ES5 score, not just the host lane.

## Not covered here (follow-ups)

- **Per-element `[[Writable]]`** — `Object.defineProperty(a, "0", {writable:false})`
  still stores. There is no general per-element descriptor table (only
  `mappedArgsInfo.nonWritableIndices`, for `arguments`); adding one is substrate
  work, not a scoped codegen change.
- **`Object.seal` + a NEW index** — sealing makes an object non-extensible, so
  `a[<new index>] = v` should fail while existing elements stay writable. That
  needs a static "does this index already exist" answer the frozen case does not.
- **Frozen `a.length = 0`** still traps rather than throwing catchably — the
  `length` property path, not the element path.
- **`any`-typed indexed writes drop silently in the host lane** — a host-lane
  residual of #3190 (which fixed standalone only). Filed separately; unrelated to
  frozen semantics.
