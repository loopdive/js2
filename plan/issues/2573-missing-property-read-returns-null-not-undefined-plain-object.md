---
id: 2573
title: "Reading a missing property on a plain `{}` object returns null, not undefined"
status: done
completed: 2026-06-21
assignee: ttraenkler/sd-6
created: 2026-06-21
priority: medium
feasibility: medium
goal: test262-conformance
parent: 983d
test262_fail: 8
---
# #2573 — Missing-property read on a plain object yields `null` not `undefined`

## Problem

Reading an own property that does not exist on a plain object literal
(`var obj = {}; obj.length`) returns JS `null` (`typeof === "object"`) where the
spec requires `undefined` (§10.1.8 OrdinaryGet → returns `undefined` for a
missing property).

```js
var obj = {};
obj.length;   // expected: undefined ; actual: null
```

## How it surfaced (#983d residual)

After #983d landed the dual-path dispatch for `obj.<field>()` host-method calls
(`var o = {}; o.pop = Array.prototype.pop; o.pop()` now actually runs), the
generic-Array-method-on-plain-object test262 cluster went 0 → 11/19. The
remaining 8 fail at a **later** assertion — `obj.length === undefined` — because
the missing-`length` read returns `null`:

```
S15.4.4.5_A2_T1.js  #2: ... obj.join(); obj.length === undefined.  Actual: null
S15.4.4.7_A2_T1.js  #4: ... obj.push(...); ...
S15.4.4.8_A2_T{1,2,3}.js, S15.4.4.13_A{2_T1,3_T2}.js, S15.4.4.7_A4_T3.js
```

Probe (`var obj={}; var b=obj.length; ... b===null, typeof==="object"`) confirms
the read is `null`, independent of any method call — it is a **property-read**
bug, not a method-dispatch or write-back bug.

## Root cause (CONFIRMED — sd-6, 2026-06-21)

It is **`length`-specific**, not a generic missing-property bug. A plain missing
key (`obj.missing`) already correctly returns `undefined` (routed through the
generic any-typed `__extern_get` reroute). `obj.length` is the exception:

- `property-access.ts` (~L1967) explicitly **EXCLUDES `length`** (alongside
  `constructor`/`__proto__`/`prototype`/`name`) from the any-typed
  `__extern_get` reroute — *"Reserved accessors have dedicated lowerings (array
  length…) — never reroute them."*
- So `.length` is handed to the dedicated array-length lowering, which returns a
  **numeric** ValType (`i32`/`f64`). For a real array/string/arguments that's
  correct (vec struct field 0). For a **plain `{}` object** it returns the
  **number `0`** (standalone: a static `f64/i32 0`, no import; gc: still numeric)
  — so `obj.length === undefined` is *always false* (it's the number 0, not the
  externref `undefined`). (Measured: `typeof obj.length === "number"`, value 0 —
  NOT `null` as the original triage guessed.)

**Fix direction:** route `.length` to the normal property read (`__extern_get` →
`undefined`-if-absent, externref result) ONLY when the receiver statically
resolves to a **plain object** (`any`/object-literal with NO `length` member, NO
array/string/function/arguments/typedarray signature). Real array-likes keep the
vec-field-0 lowering untouched. The gate must be NARROW — `.length` is read on
arrays/strings/arguments/typedarrays/bound-fns everywhere, so a too-broad gate
regresses `array.length`. Validate via the full gate (merge_group / local-ci)
before enqueue — this is a shared-path, broad-reach change.

## Implementation attempt + SUBSTRATE verdict (sd-6, 2026-06-21)

Implemented the narrow STATIC gate (`isPlainObjectWithoutLength` in
`property-access.ts`, a `.length` arm before the Function/vec arms):
`.length` → `undefined` (via `emitUndefined`) when `objType` is a CONCRETE
Object type (NOT `any`/`unknown`) with no own/inherited `length` member, no
numeric index signature, no call/construct signature.

- **Correct + regression-free for STATICALLY-TYPED plain objects:**
  `const obj = {}; obj.length === undefined` ✓ (gc + standalone);
  `array`/`string`/`function`/`any[]` `.length` arithmetic all unchanged
  (`a.length*2===6`, `"abc".length===3`, `f.length===2`); `issue-2187` (9/9) +
  `issue-2576` (12/12) `.length` suites pass.

- **BUT moves 0 test262 rows** — the real `S15.4.4.*_A2` cluster stays 0/12. The
  tests are `var obj = {}` with dynamic `obj.join = Array.prototype.join;
  obj.length` → the receiver is **`any` / dynamically-mutated**, not a
  statically-typed plain object. The classifier deliberately EXCLUDES `any`
  (can't tell plain-object from array there; arrays dominate — excluding `any` is
  exactly what keeps `any[].length` arithmetic safe), so it structurally cannot
  catch the real cluster.

**SUBSTRATE conclusion.** The real cluster needs `any`/dynamic-receiver `.length`
to do a **runtime property-presence** check (`ref.test $Object` →
`__extern_get("length")` returning undefined-if-absent; else the numeric length),
which forces `.length` on `any` receivers to return a **uniform externref** (the
numeric array length boxed too). That is a return-type change on the hot
`any[].length` path (used in `for (;i<a.length;)` loops + arithmetic everywhere)
— a value-rep / representation decision, NOT a quick point-fix. The real tests
additionally route through the generic-array-method-on-plain-object machinery
(#983d reverted territory) and a standalone ToPrimitive throw, so a correct
`.length` alone would not flip them.

**Status: substrate-blocked** for the test262 cluster. The narrow static fix is
correct user-code-level value but banks 0 conformance; whether to land it
standalone is a tech-lead call (held, not pushed). Re-route the dynamic-receiver
`.length` substrate to the value-rep / senior-dev lane (coordinate #983d retry).

## Acceptance

- `var obj = {}; obj.missing === undefined` (typeof `"undefined"`).
- The 8 residual `…/S15.4.4.*` generic-method-on-plain-object fails flip to pass.
- No regression in property reads that legitimately return `null`.

## Notes

Carved from #983d by sd-4 on 2026-06-21. Orthogonal to the dual-path dispatch
fix that #983d delivered (the method now runs correctly; this is the missing
sibling property read returning the wrong nullish value).

**DONE (narrow static slice).** The fail-safe static gate
(`isPlainObjectWithoutLength`) lands the statically-typed plain-object case
(`const obj = {}; obj.length === undefined`), with the hot `any[].length`
arithmetic path untouched. The remaining `any`/dynamically-mutated-receiver
case (the test262 `S15.4.4.*_A2` cluster — `var obj = {}; obj.length`) needs a
runtime property-presence check + a uniform-externref `.length` representation,
which is substrate — split out as **#2580** (coordinate the value-rep lane +
#983d retry, task #20).
