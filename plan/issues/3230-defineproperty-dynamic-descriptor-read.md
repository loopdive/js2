---
id: 3230
title: "Object.defineProperty: dynamic (non-literal) descriptor read-lane — struct-widening splits read/write stores (accessor read + data write-back both leak)"
status: blocked
assignee: ttraenkler/opus-3022
sprint: Backlog
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
created: 2026-07-13
task_type: bugfix
area: runtime
language_feature: object-defineproperty, property-descriptors
goal: es5
parent: 3022
related: [3022, 3042, 3043, 3116, 1629, 1712, 2106]
test262_category: built-ins/Object/defineProperty
---

# #3230 — dynamic-descriptor read-lane (struct-widening / value-rep)

Split from the #3022 umbrella (descriptor-fidelity tail). This is the
cause-scoped **value-round-trip / accessor read-lane** cluster (dev-3022 cause 1,
fable-3022 "accessor read-lane ~80"). **BLOCKED after verify-first analysis (see
below): a bounded read-path point-fix is net-NEGATIVE. Needs the full
read/write/define store-unification, not a point change.**

## Verify-first measurement (opus-3022, 2026-07-13)

Process-isolated (fresh process per file — the required isolation; a shared
process is contaminated because tests mutate shared intrinsics used as descriptor
objects, e.g. `Math.value=…`/`Math.get=…`, which leak across tests and manufacture
a spurious ~26-wide "Cannot both specify accessors and a value" bucket).

- Baseline `built-ins/Object/definePropert{y,ies}` on `origin/main` (4f9c060f,
  descriptor codegen byte-identical to 94614517): **1336 pass / 427 fail** of 1763.
- The largest genuine cluster is the `obj.property` read-back (74 files) after a
  single-key `Object.defineProperty(obj, "property", <non-literal desc>)`.

## Root cause (confirmed)

For a **single-key** `Object.defineProperty(obj, "p", desc)` where `desc` is a
**non-literal expression** (a host object like `Math`, a `new Con()`, or a
`var d = {...}` reference), the compiler cannot statically decide value-vs-accessor.
It routes the define through `emitDefinePropertyDescRuntime` →
`__defineProperty_desc` and records `obj:p` in `sidecarDefinedPropertyKeys`, but
does NOT set `definedPropertyFlags` (no literal to parse).

The dot-read `obj.p` then lowers to a **`struct.get`** on the synthesized widened
field. For an **accessor** descriptor the field holds the default and the sidecar
getter (`__get_p`) is never invoked — `obj.p` reads back `undefined` even though
`getOwnPropertyDescriptor` reports the accessor correctly (the sidecar
round-trips). Minimal repro (process-isolated):

```js
var obj = {};
var d0 = { get: function () { return "viaGetter"; } };
Object.defineProperty(obj, "property", d0);
obj.property;      // -> undefined (bug); expected "viaGetter"
obj["property"];   // -> "viaGetter" (bracket keeps obj externref -> __extern_get)
```

## Why a bounded point-fix does NOT work (the trap — do not repeat)

**Attempt A — reroute the read to the runtime.** Extend
`runtimeAccessorDescriptorKey`: when a key is in `sidecarDefinedPropertyKeys`
with no `definedPropertyFlags` (⇒ dynamic descriptor, unknown kind), route the
read through `emitRuntimeDescriptorGet` (`__extern_get` → `_safeGet`) so an
accessor invokes its getter.

Measured full process-isolated diff branch-vs-main:
**+23 fail→pass (accessor cases) but −30 pass→fail (regressions).** Net −7.

The regressions are the **`{writable:true}` data-descriptor-then-write** cluster
(`15.2.3.6-3-154..177`): `Object.defineProperty(obj,"p",{writable:true})` then
`obj.p = X` then read `obj.p`. On main all three (define/write/read) live on the
**struct field** (write-back undefined, `struct.set`, `struct.get`) → consistent
→ pass. Rerouting only the READ to the sidecar (which holds the `undefined`
presence-marker, not the `struct.set`-written value) diverges read (sidecar) from
write (field) → read returns `undefined`.

**Attempt B — Attempt A + a runtime fallback** in `__extern_get`: for a struct
key whose sidecar value is `undefined` with no accessor and a real `__sget_<k>`
field, fall through to the struct-field read instead of the sidecar short-circuit.
Fixes the isolated data-write repro, but the actual test262 files still fail.

**The killer finding — the store is widening-sensitive and not centrally
routed.** The field-vs-sidecar choice for BOTH the write and the read of `obj.p`
shifts with unrelated uses of `obj`. E.g. adding a single
`Object.getOwnPropertyDescriptor(obj, "p")` call elsewhere flips `obj`'s
representation and makes the *same* define/write/read sequence pass, while
without it the write value vanishes (verified: `tr_e` with a prior read fails;
`tr_f` with a GOPD call passes; identical data-write logic otherwise). So no
read-side (or read+runtime) point-fix can be consistent — the WRITE store is
itself widening-dependent and is not funnelled through a single hookable choke
point that `sidecarDefinedPropertyKeys` reaches.

## What the real fix requires (recommendation)

Unify the define / plain-write / read stores for dynamically-defined properties
so a single source of truth serves data AND accessor:

- Either **keep every dynamic-descriptor property on the runtime side** — route
  the plain-assignment WRITE (`obj.p = X`) for `sidecarDefinedPropertyKeys`
  through `__extern_set` → `_safeSet` (which already does the #1712 symmetric
  `__sset_<k>` field write-back AND the sidecar/setter write), in lockstep with
  the read reroute; OR
- **suppress the struct-field synthesis** for a variable that receives a
  non-literal `Object.defineProperty` so `obj.p` never becomes a typed field and
  stays on the uniform `__extern_get`/`__extern_set` path (the bracket form
  already proves this path is correct).

Either is a **value-rep / member-access architecture change** (#1629 S3 / #2106
territory) that MUST be validated in full CI / merge_group, and requires the
struct-widening heuristic (`widenedVarStructMap` + the define-site field
synthesis in `literals.ts`/`declarations.ts`) to be made write/read symmetric.
Not a bounded slice.

## Acceptance (unchanged)

- `obj.p` (dot read) of a dynamically-defined accessor invokes the getter.
- Data-descriptor-then-write (`{writable:true}; obj.p = X; obj.p`) still reads X.
- Zero regressions across `built-ins/Object/definePropert{y,ies}` (full
  process-isolated diff branch-vs-main).

## Measured

- Baseline: 1336 pass / 427 fail (process-isolated, origin/main).
- Attempt A (read reroute): +23 / −30 = **net −7**. Reverted, not shipped.
- No code change shipped — this issue records the root cause + the failed
  bounded approaches so the next senior-dev goes straight to the store-unification.
