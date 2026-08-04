---
id: 4086
title: "Object.getOwnPropertyNames leaks BUILTIN struct internals in standalone (`/ab/` reports 7 internal fields) — blocks sharing the closed-struct arms with Object.keys"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: object-enumeration
goal: standalone-mode
related: [4071, 4062, 4055]
---

# `getOwnPropertyNames` reports compiler-internal fields of builtin carriers

Found while working #4071. It is the reason #4071 shipped only half its intended
fix.

## Defect

`fillClosedStructOwnPropertyNamesArms` (`src/codegen/object-runtime.ts`) splices
one arm per entry of `ctx.structFields`, skipping only
`isSyntheticStructName` (`Wrapper*` / `$AnyValue` / `__vec_*` / `__arr_*`) and
field names starting with `$` or `__`.

**Builtin carriers are not screened by either filter**, and their internal field
names are ordinary identifiers. Measured in standalone:

| expression | spec | gc lane | standalone |
| --- | --- | --- | --- |
| `Object.getOwnPropertyNames(/ab/).length` | 1 (`lastIndex`) | 1 | **7** |
| `Object.getOwnPropertyNames(new Date(0)).length` | 0 | 1 (`timestamp`) | 1 (`timestamp`) |

`Object.getOwnPropertyNames(/ab/)` returning seven internal RegExp fields is a
silent wrong answer on a very common spelling.

## Why it blocked #4071

#4071 fixes `Object.keys` for standalone carriers that are not `$Object`. The
natural implementation — share these same closed-struct arms with
`__object_keys`, which is what the sibling helpers already do — was implemented
and **measured**: it was worth **+5 more net test262 flips** (+8/−3 vs +3/−2 on
the 234-file `Object.keys` population).

It was **reverted** anyway, because it propagated this leak into `Object.keys`:

```js
Object.keys(new Date(0)); // ["timestamp"] — spec: []
Object.keys(/ab/);        // 7 internal fields — spec: []
```

Both are correctly `[]` today, so sharing the arms would have traded a real gain
for a NEW silent wrong answer on two very common spellings. `Object.keys` is
enumerable-only, and a builtin's internal slot is not an own enumerable property.
`tests/issue-4071.test.ts` carries both as explicit regression guards.

## Fix direction

Introduce a principled **user-declared-vs-builtin** struct predicate (the thing
that does not exist today — `isSyntheticStructName` only screens the four
compiler-internal prefixes). Then:

1. Restrict these arms to user-declared shapes, fixing `getOwnPropertyNames`.
2. Re-share them with `__object_keys` and bank the +5 that #4071 declined,
   removing the two regression guards.

Do **not** re-share the arms before the predicate lands.

## Acceptance criteria

1. `Object.getOwnPropertyNames(/ab/)` returns `["lastIndex"]` in standalone.
2. `Object.getOwnPropertyNames(new Date(0))` returns `[]` (this also fixes the
   `gc` lane, which reports `timestamp` too).
3. `Object.keys` on a class instance enumerates its own fields, with the
   Date/RegExp guards in `tests/issue-4071.test.ts` still green.
4. Flips reported against a force-refreshed standalone baseline, denominator
   stated.

---

## Investigation (2026-08-02, `ttraenkler/L-enum`) — the obvious fix is REFUTED

Instrumented `fillClosedStructOwnPropertyNamesArms` to dump every
`ctx.structFields` entry that survives both existing filters
(`isSyntheticStructName` on the struct name, `$`/`__` prefix on FIELD names) and
therefore actually produces an arm. Probe source declared a user class, an
interface-typed object, object literals (flat + nested + inside an array), a
RegExp, a Date and a TypedArray.

```
ARMSTRUCT  __anon_0             alpha,beta
ARMSTRUCT  __anon_1             w,h
ARMSTRUCT  __anon_2             deep
ARMSTRUCT  __anon_3             inner
ARMSTRUCT  __anon_4             k
ARMSTRUCT  __Date               timestamp
ARMSTRUCT  MyClass              a,b
ARMSTRUCT  Shape                w,h
ARMSTRUCT  __StandaloneRegExp   flags,nGroups,prog,classTable,source,nScratch,lastIndex
ARMSTRUCT  __subview_f64        length,data,byteOffset
ARMSTRUCT  __subview_i16_byte   length,data,byteOffset
ARMSTRUCT  __subview_i32_elem   length,data,byteOffset
ARMSTRUCT  __subview_i8_byte    length,data,byteOffset
```

### What this settles

1. **The leak is confirmed and named.** `__StandaloneRegExp` contributes exactly
   the 7 fields `Object.getOwnPropertyNames(/ab/)` wrongly reports
   (`flags,nGroups,prog,classTable,source,nScratch,lastIndex`); `__Date`
   contributes `timestamp`. `__subview_*` (TypedArray views) leak
   `length,data,byteOffset` the same way.

2. **A `startsWith("__")` prefix predicate is WRONG — do not use it.** This is
   the obvious cheap fix and it would silently break ordinary user code:
   **object literals are named `__anon_N`** and carry genuine USER data
   (`alpha,beta` / `w,h` / `deep` / `inner` / `k`). Excluding `__`-prefixed
   structs would make `Object.keys({alpha:1, beta:2})` return `[]` — trading this
   leak for a far more common silent wrong answer, i.e. exactly the trade #4071
   refused to make.

   **Why the trap is inviting — read this before reaching for a predicate: the
   field-name filter already uses a `$`/`__` prefix rule and works fine, so
   reusing it on the struct name looks like consistency rather than a category
   error. Two different namespaces, one naming convention.** In the FIELD
   namespace the prefix reliably means "compiler internal". In the STRUCT
   namespace it does not: it marks *compiler-generated*, which covers both
   builtin carriers (`__Date`, `__StandaloneRegExp`, `__subview_*`) and the
   anonymous shapes of ordinary user object literals (`__anon_N`). Only
   user-*declared* names (`MyClass`, `Shape`) are unprefixed, and they are not
   the whole set of things that must keep their arms.

### Implied design — derived from the dump above, not from taste

The dump forces the conclusion: the two categories that must be separated
(`__Date` vs `__anon_0`) are **indistinguishable by name**, so no name-shape
predicate can exist. The information simply is not in the string. It therefore
has to come from somewhere that knows the answer at the time the struct is made.

The predicate must key on **carrier identity recorded at registration time**.
Concretely: a `ctx.builtinCarrierStructs: Set<string>` (or a flag on the
`structFields` entry) populated where these carriers are created —
`native-regex.ts` (`__StandaloneRegExp`), the Date carrier, the `__subview_*`
TypedArray views, and any sibling built the same way. The registration site is
the only place that knows "this struct is a builtin's internal representation,
not user data", and it is the only source that stays correct as carriers are
added.

A deny-list of literal struct names is the tempting shortcut and should be
rejected for the same reason: it is correct for exactly the four carriers this
probe happened to surface, and silently wrong for the next one added. The bug
being fixed here IS a filter that did not keep up with the carriers around it.

Scope note: the same predicate is the prerequisite for the closed-struct halves
of BOTH #4071 (`Object.keys` on class instances, measured at +5 net flips) and
#4085 (`JSON.stringify` of class instances / assignment-built objects). Landing
it unblocks two deferred fixes, which is most of its value — its own direct flip
count is likely small.

---

## A structural builtin-carrier screen is available: `ctx.classDeclarationMap` (2026-08-03, #4098 G1)

This issue records that `startsWith("__")` is **not** a safe screen for builtin
struct internals. A structural alternative exists and is already populated:

`ctx.classDeclarationMap` (`codegen/context/types.ts`) is written *only* by
`collectClassDeclaration` (`class-bodies.ts:609`) and keyed by class name, the
same key space as `ctx.structFields`. So `classDeclarationMap.has(structName)`
partitions user-declared class structs from builtin carriers by **origin**
rather than by name shape — Date/RegExp/Error carriers are never in it.

This is the same predicate #4071's deferred −5 revert was blocked on, and the
one #4098's `Object.keys` stage will use. Recorded here as available substrate;
no arm built for this issue.
