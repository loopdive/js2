---
id: 7505
title: "Array destructuring of a user iterator: generator @@iterator throws, IteratorClose skips its TypeErrors, empty pattern calls nothing"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7424]
---

# #7505: destructuring IteratorClose residuals

## Problem

Found by review RV7448 on PR #7448 (#7424). These are stated as the reviewer
reported them; re-measure on current main before planning.

### F1: a generator `[Symbol.iterator]` method throws (new with #7424)

```js
class C { *[Symbol.iterator]() { yield 1; yield 2; } }
const [a, b] = new C();
```

- **Node:** `a === 1`, `b === 2`.
- **After #7424:** an uncaught exception. #7424 routes array destructuring of a
  user iterable through the bounded `__array_from_iter_n` drive, which does not
  accept the generator object this method returns.
- **Main before #7424:** `NaN` bindings. That was wrong too: the deleted #2033
  arm drained into an f64 vec.

### Already wrong on main before #7424

1. **A non-callable `return` is not a TypeError.** For
   `class It { …; get return() { return 5; } }` with `const [a] = new It()`,
   §7.4.9 IteratorClose step 5 (GetMethod) must throw a TypeError. We complete
   normally.
2. **A non-object result from `return()` is not a TypeError.** For a class
   `return() { return 1; }`, IteratorClose step 9 must throw a TypeError
   because the result is not an object. We ignore the result.
3. **An empty pattern calls nothing.** For `const [] = it`, node calls
   `it[Symbol.iterator]()` once and then `return()` once (the iterator is not
   done). We call neither: the externref destructuring path skips an empty
   pattern on purpose (#1016/#1158).

## Acceptance

- A test pins node's answer for F1 and items 1 to 3 on gc, standalone and wasi.
- F1's fix makes the bounded drive accept a generator-valued `@@iterator`
  result instead of special-casing destructuring.
- Items 1 and 2 are fixed inside `__iterator_return` (the shared IteratorClose
  helper), so for-of `break` gets the same TypeErrors.
