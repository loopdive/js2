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
related: [7424, 7423, 7425]
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

### Reported by review RV7465 on PR #7465 (#7423), pre-existing on main `1a726b3e`

4. **`const [a] = it` calls `next` twice** on a class iterator; node calls
   `next` once and then `return()`. Assignment destructuring and for-of
   `break` are correct. (#7424, PR #7448, routes declarations through the
   bounded drive; re-measure after it lands.)
5. **`yield* it` over a class iterator throws** on every target, and
   `gen.return(5)` through `yield*` is a TypeScript compile error. (#7425,
   PR #7444, fixes the class `yield*` case; re-measure after it lands.)
6. **Object-literal iterators hit the #2090 stack-balance compile error** in a
   for-of with `break` or with a throw in the loop body. A direct
   `it.next()` on an object-literal iterator records nothing
   (`arguments.length` reads -1).
7. **A function parameter destructured from an iterator** is a TypeScript
   compile error.

### Reported by review RV7444 on PR #7444 (#7425)

8. **`yield*` over a class whose `[Symbol.iterator]()` returns a built-in
   iterator throws**, for example `[Symbol.iterator]() { return [1, 2][Symbol.iterator](); }`.
   This fails on main as well. The delegation's `next` read does not reach the
   native array iterator that the user method returns.

### Code-quality follow-up (lead, 2026-11-26)

9. **Move `wellKnownSymbolKeyOf` from `src/codegen/literals.ts` to
   `src/checker/well-known-symbol-keys.ts`.** #7425 added it as the single
   producer of a key expression's `@@` spelling, and it belongs beside the
   checker's other symbol-key helpers. Its callers are
   `resolveComputedKeyExpression` and `class-proto-accessors.ts`.

## Acceptance

- Item 9 is a move with no behaviour change: bytes identical.
- A test pins node's answer for F1 and items 1 to 8 on gc, standalone and wasi
  (items 4 and 5 only if they still fail once #7448 and #7444 land).
- F1's fix makes the bounded drive accept a generator-valued `@@iterator`
  result instead of special-casing destructuring.
- Items 1 and 2 are fixed inside `__iterator_return` (the shared IteratorClose
  helper), so for-of `break` gets the same TypeErrors.
