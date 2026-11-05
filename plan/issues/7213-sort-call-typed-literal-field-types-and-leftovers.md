---
id: 7213
title: "`sort.call` on a typed object literal: field types refuse sorted values, and leftovers"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: low
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrays
goal: correctness
related: [7167]
---

# #7213 — what #7167 left open

#7167 (PR #7016) makes `Array.prototype.sort.call` write into the declared
fields of a typed object literal. Its review found that the issue's own
program is still wrong, together with some leftovers that also behave this
way on main.

## Still wrong

1. **A field type refuses the sorted value.** On gc and standalone:
   ```js
   const o = { length: 3, 0: "c", 1: undefined, 2: "a" };
   Array.prototype.sort.call(o);
   console.log(o[0] + o[1] + o[2]);   // node: acundefined — we print: aca
   ```
   `o[2]` is a `string` field, which cannot hold `undefined`.
2. **Typed reads show coerced values.** A string sorted into an `f64` field
   reads `NaN` (`{ length: 3, 0: 3, 1: "x", 2: 1 }` gives `1|x|NaN|NaN`,
   node `1|3|x|x1`). A boolean field given `"b"` reads `false`.
3. **The struct list depends on declaration order.** The structs that get the
   field write are collected when the generic sort body is first emitted, so
   a literal shape declared after that stays unsorted for typed reads. The
   existing write arms avoid this by filling at the end of compilation
   (`fillClosedStructExternSetArms`, `src/codegen/index.ts`). Doing the same
   here would fix it.
4. **A stale side-table copy.** After the sort, a typed write is invisible to
   dynamic reads: `o[0] = "z"` then gives `za` (node `zz`).
5. **Holes do not clear declared fields.**
6. **`in` on a declared field** is folded to `true` at compile time.
7. **A non-writable `defineProperty`** does not make the write throw.

Items 1 and 2 need the field type to admit the value (widening it, or
falling back to the side table for the whole object). That touches the type
APIs, so it needs session A's agreement under the #6583 constraint.

## Plan

1. Fix item 3 first: collect the struct types at the end of compilation.
2. Agree an approach for items 1 and 2 on #6583, then implement it.
3. Fix items 4–7, which are independent of sort.
4. Tests on gc, standalone and wasi against node for every item. Add a wasi
   test of the write-back once wasi can reach it.
