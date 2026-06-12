---
id: 1983
title: "synthetic class-method names collide with user functions: class A { m() {} } + function A_m() breaks both paths"
status: blocked
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: compilable
related: [1370]
origin: "2026-06-10 deep-audit sweep (IR agent, secondary observation): verified on main @ 0c753ea88, both paths"
---

# #1983 — `${ClassName}_${method}` funcMap keying is not collision-free

## Problem

A class method `A.m` is registered under the synthetic name `A_m`; a
user-defined top-level `function A_m()` collides with it. Legacy: runtime
null-ref trap; IR: module-wide CompileError (`argument type mismatch in
call`). Node: works (`12`).

```ts
class A { m(): number { return 10; } }
function A_m(): number { return 2; }
export function test(): number { return new A().m() + A_m(); }
```

## Root cause (area)

funcMap keys use the `${ClassName}_${method}` convention
(`src/codegen/class-bodies.ts`, #1370 keying) with no mangling/uniquing
against user identifiers.

## Fix direction

Use a non-collidable separator in synthetic names (e.g. `A#m` or a reserved
prefix that is not a valid TS identifier), or unique-ify on collision at
registration time. Audit other synthetic name factories (getters/setters,
statics, closure wrappers) for the same convention.

## Acceptance criteria

- Repro returns `12` on both paths
- Mangled names don't leak into exports/WIT
- Other `_`-joined synthetic name sites audited

## Dupe check

#1370 (class-method IR adoption — keying origin). No collision issue on file.

---

## Implementation Plan (senior-1, 2026-06-12)

Bug reproduced on main @ 274dd03f7: the repro compiles to an **invalid Wasm
binary** (both `new A().m()` and `A_m()` resolve to one overwritten funcMap
entry with mismatched signatures).

### Scope-narrowing finding

The `${name}_${member}` convention appears at ~40 sites, but the **collision is
confined to `ctx.funcMap`** — the only map a user `function A_m()` also writes to
(under its export name). The funcMap-keyed synthetic member names are: methods,
getters (`${name}_get_${prop}`), setters (`${name}_set_${prop}`), and the
constructor. Their **gating membership sets must flip with them**:
`classMethodSet` / `staticMethodSet` (store the method `fullName`). Other maps
using the same string convention key disjoint namespaces and must NOT flip:
`structAccessorClosure`, `staticProps`, `classAccessorSet` / `staticAccessorSet`
(they store `${name}_${prop}`, never a user function name) — flipping them in
isolation would break their own producer/consumer pairing.

### The helper

`src/codegen/class-member-key.ts` → `classMemberKey(name, member)` =
`` `${name}#${member}` `` (`#` is not a valid TS-identifier char ⇒ collision
impossible). Internal only — exported names still come from the user identifier,
so the separator never reaches exports/WIT.

### Execution

Route every funcMap method/getter/setter key construction AND its
`classMethodSet`/`staticMethodSet` membership check through `classMemberKey`.
Producer sites (class-bodies.ts, index.ts struct methods) and consumer sites
(calls.ts dispatch, closures.ts method-ref, property-access.ts, literals.ts
object-literal methods) must change together. Verify by the full class
equivalence suite + the #1983 repro → 12 on both legacy and IR paths; a missed
funcMap lookup manifests immediately as a method-dispatch trap/invalid-wasm.

### ⚠️ CRITICAL TRAP found mid-implementation (senior-1) — needs arch design

The funcMap key `${name}_${member}` is **OVERLOADED**: it keys BOTH user-class
members AND **extern/host-class** members on the SAME map with the SAME
convention:

- **Constructors:** `${className}_new` (user) vs `${info.importPrefix}_new`
  (extern — `Map_new`, `Array_new`, `RegExp_new`) at index.ts:10184/10271/10279,
  expressions/calls.ts:2159, expressions/new-super.ts (many). The extern ones are
  **real `env` host-import names** — flipping their separator breaks
  `WebAssembly.instantiate` (unsatisfiable import).
- **Methods:** `${structName}_${methodName}` (user) vs
  `${info.importPrefix}_${methodName}` (extern — `Array_push`, `Map_get`,
  `String_charAt`) at index.ts:10192/10312. Same map, same dispatch lookup
  (index.ts:3311 `funcMap.get(${structName}_${methodName})` does **not** know if
  `structName` is a user class or an extern class).

So a blind flip of method/getter/setter/ctor keys would **break extern-class
construction and method dispatch** (Array/Map/String/RegExp) — strictly worse
than the original collision.

**The fix MUST discriminate user-class keys (flip to `#`) from extern/host-class
keys (keep `_`, they are host-import names) at every one of the ~20 funcMap
sites.** `ctx.classSet.has(name)` identifies user classes, but the extern path
keys off `info.importPrefix` (not always in `classSet`), so the producer and
consumer sites need a consistent "is this a user class?" predicate threaded
through. That is an architect-level design (a `userClassMemberKey` that only
mangles when the receiver is a user class, vs leaving extern host-import names
untouched), not a mechanical separator swap.

**Status:** helper `src/codegen/class-member-key.ts` is committed (the `#`
mangling primitive) and the bug is reproduced + scoped. Releasing for an
`[ARCH input first]` pass to design the user-vs-extern discriminator before the
~20-site flip, so the implementation doesn't regress extern-class dispatch.
Alternative narrower fix worth evaluating: **uniquify only on detected collision
at the single registration site** — when `funcMap.has(syntheticName)` is already
true at method registration, mangle just that one entry and record the mangled
name in a `ctx.classMemberKeyOverride` map that every lookup consults. That
confines the change to one producer + one shared lookup wrapper instead of 20
edits, at the cost of a lookup indirection.
