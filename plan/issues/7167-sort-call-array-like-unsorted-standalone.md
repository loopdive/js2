---
id: 7167
title: "Standalone: Array.prototype.sort.call(arrayLike) leaves typed literal fields unsorted"
sprint: current
created: 2026-10-25
updated: 2026-10-31
completed: 2026-10-31
task_type: bugfix
area: codegen
goal: correctness
parent: 6979
status: done
reasoning_effort: high
priority: low
horizon: m
feasibility: medium
language_feature: arrays
related: [7151, 7165, 7213]
---

# #7167 — generic-receiver `sort` is a no-op on standalone

Found while implementing #7151 (PR #6918). Pre-existing on `origin/main`,
standalone (gc native-first and host-assisted: verify):

```js
const o = { length: 3, 0: "c", 1: undefined, 2: "a" };
Array.prototype.sort.call(o);
console.log(o[0] + o[1] + o[2]);   // "cundefineda"   (node: "acundefined")
```

## Cause (as diagnosed; verify before fixing)

The generic-receiver arm of `sort` (`Array.prototype.sort` value body, `sortCompareGreater` in `src/codegen/array/array-sort-value.ts`) reads the array-like through `__extern_get` but writes back nothing on standalone (or writes to a copy). #7151 left this path byte-identical.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce on standalone and gc native-first; also with a comparator, with holes (`{ length: 3, 0: "b", 2: "a" }` → `"a","b",<hole>`), and with `arguments`.
2. Implement §23.1.3.30 steps for a generic receiver: SortIndexedProperties (read `0..len-1` via HasProperty/Get, skip holes), sort the collected list with the #7151 comparator-less rule or the user comparator, then write back with Set(true) for the sorted prefix and DeletePropertyOrThrow for the remaining indices. Reuse `prepareExternVecDefaultSortCompare` for the comparison; no host imports.
3. Tests: `tests/issue-7167-sort-call-array-like.test.ts` with the programs on standalone and gc native-first vs node.

Acceptance: node's output; host-assisted gc bytes unchanged; equivalence gate no new regressions.

## Resolution (2026-10-31)

**Verified cause — the issue's diagnosis was wrong.** The generic sort body
(`emitArraySortMemberBody`) already implements SortIndexedProperties, the
#7151 comparison and the Set / DeletePropertyOrThrow write-back. An `any`
receiver, `arguments`, a class instance and a Proxy all sorted correctly on
`origin/main`. The failing receiver is a *typed* object literal: it lowers
to a closed struct whose index-named properties are physical fields. The
write-back used a boxed-number key, and the closed-struct write arms on
`__extern_set` (`fillClosedStructExternSetArms`) match a string key only.
So the sorted items landed in the expando bag. Dynamic reads (`p[k]`, which
check the bag first) saw the sorted order; typed field reads (`o[0]`) kept
the old one.

**Fix** (`src/codegen/array/array-sort-declared-slots.ts`): for a receiver
whose struct type declares an index-named field that those arms cover, the
element is also written under the key `ToString(n)`. This reaches the slot.
The boxed write runs afterwards unchanged, so every other surface reads what
it read before:

- a value the slot refuses still lands in the bag;
- a key that is not a declared field gets no string write, so an inherited
  setter still runs only once.

The fix runs whenever native strings are on. On wasi the closed-struct arms
are not built, so the extra string-keyed write is harmless there; today every
closed-struct `sort.call` already throws on wasi on base and head alike.
Modules with no index-named struct field emit nothing new. The shared runtime, the classifiers and the type APIs
are untouched.

**Still wrong, and left alone on purpose** (each one needs shared
object-model or type work):

- The issue program itself is `{ length: 3, 0: "c", 1: undefined, 2: "a" }`.
  It now gives `"aca"` (base: `"cundefineda"`). `o[2]` is a `string` field,
  and the closed-struct arm refuses to store `undefined` there. Fixing this
  means widening the struct field type. A dynamic read gives the right
  answer, as it did before.
- A `string` value stored into an `f64` slot is coerced to `NaN`, and a
  boolean slot given `"b"` reads `false`. This is the same thing a literal
  `p["1"] = "a"` does.
- `2 in o` on a typed literal is folded to `true` at compile time.
- `Object.keys` order is wrong after an expando: `0,length,1`.
- `Array.prototype.sort.call("ba")` does not throw TypeError.
- A class-prototype index setter does not run.
- On wasi, plain array-like objects misread: `({ length: 2 } as any).length`
  is `undefined`. This is independent of sort.

**Scope note (2026-10-31, PR #7016 review).** This issue is closed for the
write-back into declared fields. The issue's own program, the coerced typed
reads and the leftovers above move to #7213.
