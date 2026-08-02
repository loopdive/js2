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
