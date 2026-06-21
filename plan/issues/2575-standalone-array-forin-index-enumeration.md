---
id: 2575
title: "standalone: for-in over an array static-unrolls members, not numeric indices (no $ObjVec / index walk)"
status: done
completed: 2026-06-21
assignee: ttraenkler/sd-6
sprint: Backlog
created: 2026-06-21
updated: 2026-06-21
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: for-in, arrays
goal: standalone-mode
related: [2572, 1837]
test262_bucket: standalone-array-forin
es_edition: es5
origin: "Follow-up to #2572 (sd-5, 2026-06-21). #2572 fixed standalone for-in over a dynamic $Object via the native key walk and made array for-in *instantiate* instead of leaking, but array for-in still routes to the static-unroll path which enumerates the array type's static members, not its own numeric indices."
---

# #2575 — standalone for-in over an array enumerates members, not indices

## Problem

`for (const k in arr)` must enumerate the array's **own enumerable property
keys** — the numeric indices `"0".."length-1"` (as strings), in ascending order
(§13.7.5 / OrdinaryOwnPropertyKeys integer-index rule). In standalone mode an
array for-in instead routes to the for-in **static-unroll** fallback
(`src/codegen/statements/loops.ts` `compileForInStatement`), which enumerates the
_static array type's_ `getProperties()` — i.e. `length` and the Array prototype
members — not the live indices.

```ts
const a = [10, 20, 30];
let n = 0;
for (const k in a) n++;
// expected: 3   standalone: enumerates static members (wrong count)
```

After #2572 this **instantiates** (the `__for_in_*` host-import leak is gone),
but the enumerated key set is wrong.

## Why separate from #2572

#2572 routed the **dynamic `$Object`** receiver through the native object
runtime (`__object_keys` walk). An array is not a `$Object` — it lowers to a
WasmGC array/vec — so `__object_keys` would return empty and the static-unroll
path was kept for it. Array index enumeration needs its own native key source.

## Fix direction

In `compileForInStatement`, when the standalone receiver lowers to an array/vec
(not `$Object`, not a closed struct), enumerate the live indices: read the array
length and emit each index `i` ToString'd to its decimal key (`number_toString`,
the same helper `__object_keys` uses for integer keys), in ascending order
(integer-index keys come first per OrdinaryOwnPropertyKeys, #1837). The loop
scaffolding (counter, `$break`/`$continue`, #2066 liveness) can be shared with
the existing path; only the key source differs. A sparse array (#2001 holes)
must skip hole indices — coordinate with the $Hole representation.

## Acceptance criteria

- `const a=[10,20,30]; for (const k in a) …` enumerates `"0","1","2"` in order,
  count 3, in `target: "standalone"`; no `env.__for_in_*` import.
- Enumeration is ascending integer-index order.
- A sparse array (`const a=[1,,3]`) skips the hole index (coordinate with #2001).
- JS-host array for-in unchanged.

## Notes

Follow-up to #2572. Lower priority than the dynamic-object case (array for-in is
less common). Found by sd-5's #2572 edge testing.
