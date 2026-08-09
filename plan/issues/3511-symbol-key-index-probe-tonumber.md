---
id: 3511
title: "Symbol-keyed property access eagerly ToNumber-coerces the key via the __unbox_number index-probe → symbol-safe __any_to_index"
status: done
completed: 2026-07-21
assignee: ttraenkler/senior-dev
created: 2026-07-21
priority: high
feasibility: medium
task_type: bug
area: codegen
goal: test262-conformance
model: opus
sprint: 73
horizon: m
related: [3481]
loc-budget-allow:
  - src/codegen/property-access.ts
  - src/runtime.ts
---

# #3511 — Symbol-keyed property access spuriously coerces the key to a number

## Problem (host lane, ~52 failing test262 files)

`obj[symbolKey]` on a **host-object receiver** with a dynamically-`any`-typed key
throws `TypeError: "Cannot convert a Symbol value to a number"` during normal
execution, where the spec requires an ordinary (non-throwing) property access.

Root cause (verified 2026-07-21, faithful harness repro): the host/gc dynamic-
`any`-index arm in `src/codegen/property-access.ts` (the #2773 arm, ~line 4093)
eagerly ToNumber-probes the key for a native vec index:

```
idxF64 = __unbox_number(key)   // §7.1.4 ToNumber — THROWS on a Symbol/BigInt
```

`__unbox_number` is the centralized ToNumber funnel (`runtime.ts` ~13811); it
correctly throws on a Symbol (per `+Symbol()` / `Number(Symbol())`). But here it
runs as an *array-index probe* BEFORE the `__extern_get(recv, key)` fallback that
would handle the Symbol key correctly, so a valid `obj[symbol]` read/write/delete
throws. `Object.getOwnPropertyDescriptor`/`hasOwnProperty` on a Symbol key hit the
same funnel from their own arms.

This is what breaks `verifyProperty(obj, Symbol.iterator, {...})` (propertyHelper.js)
— its `isWritable` does `obj[name]` get/set/delete with `name` = a Symbol.

## Fix — shared `__any_to_index(key) → f64` helper (symbol-safe index probe)

A new internal host import `__any_to_index` that NEVER throws: a Symbol/BigInt key
(or any value whose ToNumber would throw) returns `NaN` so the caller's existing
integer-round-trip guard falls through to `__extern_get(recv, key)` (the property-
key path). Everything else matches `__unbox_number`. Swapped in at the element-
access index-probe sites (get / set / delete). Zero-regression by construction:
those sites currently ALWAYS throw on a Symbol key, so nothing passing depends on
the throw, and `obj[symbol]` never throws in JS.

Standalone twin (property-access.ts ~4209) already reads `__extern_get` FIRST and
only unboxes on a miss, so a Symbol key never reaches its probe — left as-is.

## Acceptance
- `verifyProperty(X, Symbol.iterator/@@toStringTag/@@species, {...})` no longer
  throws "Cannot convert a Symbol value to a number".
- `obj[symbolKey]` get/set/delete on a host-object receiver reads/writes the
  Symbol-keyed property (no numeric coercion).
- Measured whole-file flips on the ~52 non-Temporal `verifyProperty(_, Symbol.*)`
  candidates (assertion-path verified).
- Zero regression on numeric/string-keyed element access (byte-identical path).

## Measured result (assertion-path, faithful `assembleOriginalHarness` repro)

**40 / 52 non-Temporal `verifyProperty(_, Symbol.*)` host files now PASS** with the
single get-arm swap; **zero remaining "Cannot convert a Symbol value to a number"**.
The 10 non-passes fail on UNRELATED features (Atomics/SharedArrayBuffer `@@toStringTag`,
ShadowRealm, async-generator, `Date @@toPrimitive`, mapped/unmapped `arguments`
`@@iterator`); 2 are `module`-flag (skipped). Regression guard: numeric index (`a[1]`),
OOB (`a[5]===undefined`), numeric-string key (`o["5"]`), and string key (`o["foo"]`)
all byte-identical — `__any_to_index` matches `__unbox_number` for every non-throwing
input; it only diverges by returning NaN where ToNumber would throw, and a Symbol key
at this probe ALWAYS threw before, so no passing test depended on it.
