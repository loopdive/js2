---
id: 7152
title: "Native-first: Array.prototype.filter with a narrowing predicate on a mixed externref-element array dereferences null in the predicate"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-26
completed: 2026-10-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [7146, 7151]
# 2026-10-26 (#7152): +2 lines — the import of the raw-externref guard that keeps
# `typeof`'s `$AnyValue` arms off a re-typed HOF callback parameter, and the
# guard on the generic `__any_typeof` arm (round 3);
# the guard itself lives in array-hof-nullable-elem-param.ts.
loc-budget-allow:
  - src/codegen/typeof-delete.ts
# 2026-10-26 (#7152 round 3): +1 line — the same raw-externref guard on the
# generic `__any_typeof` arm (a boxed `$AnyValue` read of a re-typed parameter
# threw "illegal cast" for `const t = typeof k` / `switch (typeof k)`).
func-budget-allow:
  - src/codegen/typeof-delete.ts::compileTypeofExpression
---

# #7152 — `filter` with a narrowing predicate on a mixed externref vec traps

Found during the round-2 review of PR #6905 (#7146). On gc native-first and
standalone, at module level and inside a function:

```js
const keys = [];
for (const k in { c: 1, a: 2 }) keys.push(k);
keys.push(3); keys.push(1);
console.log(keys.filter(k => typeof k === "number").length); // RuntimeError: dereferencing a null pointer
console.log(keys.filter(k => k !== "a").length);              // same trap
console.log(keys.filter(k => true).length);                   // works
console.log(keys.map(k => k).length);                         // works
```

Pre-existing on `origin/main` (not introduced by #6905; that PR only makes
`…filter(narrowing).sort(cmp).join()` reach this trap instead of failing wasm
validation). The predicate's parameter is read from the externref-element vec
and dereferenced as a concrete struct in the `typeof` / `!==` lowering.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the four lines above on both no-host lanes; dump WAT for the
   predicate closure and find the `ref.as_non_null` / struct read that
   precedes the trap (it is in the predicate body, not in `filter`'s loop).
2. The closure-literal planning for an array callback (`select-closure-literal.ts`
   / the legacy `compileArrayMethodCall` callback path) assumes the element
   type the checker gives (`any[]` → f64/number element) while the storage is
   externref; make the callback's parameter carry the receiver's **storage**
   element type (the same source #7146 now uses in `nativeJoinProbeExpr`), so
   `typeof k` and `k !== "a"` lower through the dynamic/externref arms.
3. Keep host-assisted gc bytes identical; native-first / standalone bytes
   change only for callbacks over externref vecs — state the delta.
4. Tests: `tests/equivalence/issue-7152-*.test.ts` with the four lines plus
   `find`, `some`, `every`, `forEach` with the same narrowing predicates (same
   callback path), both lanes vs node.

## Resolution (2026-10-26)

- Cause: the callback's element parameter was typed `$AnyValue` (checker:
  `string | number`) while the vec stores `externref`; the HOF loop's
  externref→`$AnyValue` coercion is a `ref.test` cast that yields null.
- Fix: `nullableElemParamOverrideFor` now also arms for an `externref` element
  (scoped to the callback node, parentheses peeled), and
  `applyNullableElemParamOverride` re-types only the `$AnyValue` element
  parameter of that callback to `externref`. The `reduce*` accumulator is not
  re-typed: the call's result stays `$AnyValue`, so a pass-through `acc` would
  be cast to null (round-3 review). Both `typeof` arms that box into
  `$AnyValue` — the `=== "literal"` tag fast path and the generic
  `__any_typeof` arm — skip an identifier held in a raw `externref` slot, or in
  a ref cell whose value type is `externref` (a nested closure writes `k`):
  boxing would tag a stored number as 5.
- Bytes: identical on the 13 playground examples, 24 HOF/typeof-using
  equivalence programs and 12 hand-written reduce/filter/typeof programs ×
  gc/standalone/wasi (147 compiles); only function-local repro-shaped programs
  change.
- Test: `tests/equivalence/issue-7152-hof-narrowing-externref-vec.test.ts` (67 rows, gc native-first / standalone / wasi vs node).
- Left out: `reduce`/`reduceRight` with an initial value whose callback
  combines the accumulator (`keys.reduce((acc, k) => acc + …, 0)`,
  `(…, "")`) still traps with a null deref, as on base; pass-through and
  element-only callbacks are correct. `.length` of a `$AnyValue` string result
  on wasi is #7176 (pre-existing).
