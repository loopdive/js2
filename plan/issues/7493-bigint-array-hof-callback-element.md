---
id: 7493
title: "A `bigint[]` array HOF callback receives a wrong element (parameter, arrow and `arguments[0]`)"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7465, 7078]
---

# #7493: a `bigint[]` HOF callback gets a wrong element

## Problem

Found by RV7431 in the review of PR #7431 (#7465). It reported the zero-formal `arguments[0]` row. Measured on main
`c3b7be667a` (2026-11-26), with each program compiled for gc, standalone and wasi and compared with node, the bug is
wider: **every** array HOF callback over a `bigint[]` sees a wrong element. A declared parameter is wrong, not only
the `arguments` extras.

```ts
let n = 0;
export function test(): number { const a: bigint[] = [5n, 6n]; a.forEach(add); return n; }
function add(x: bigint): void { if (typeof x === "bigint") n++; }
```

| program | node | gc | standalone | wasi |
| --- | ---: | ---: | ---: | ---: |
| zero formals, `typeof arguments[0] === "bigint"` (forEach, counted) | 2 | 0 | 0 | 0 |
| one formal, `typeof x === "bigint"` | 2 | 0 | 0 | 0 |
| one formal, `x === 5n` | 1 | 0 | 0 | 0 |
| arrow callback, `typeof x === "bigint"` | 2 | 0 | 0 | 0 |
| `a.map((x) => x + 1n)[0] === 6n` | 1 | throws | throws | throws |

The same element read outside a HOF is correct on all three lanes:

| program | node | gc / standalone / wasi |
| --- | ---: | ---: |
| `for (const x of a) if (typeof x === "bigint") n++` | 2 | 2 |
| a direct call `f(5n)` with `typeof x === "bigint"` | 1 | 1 |

So the element is lost between the array's i64 storage (#7078 lowers a bigint-only `[]` to an i64 element vector)
and the callback's parameter.

## Where to look

- `src/codegen/array-methods.ts`, the callback element path. `callbackInvokeInstrs` passes
  `{ load: loadElem, type: elemType }` with `elemType.kind === "i64"` into the closure call; check the coercion from
  i64 to the callback's declared parameter type (bigint's carrier). `emitElemBoxToExternref` covers the zero-formal
  `arguments[0]` arm, and it still pushes the `undefined` placeholder for i64 ("Unboxable element kind
  (i64/v128/…)"). For a bigint element that placeholder is reachable and wrong: it must box the i64 the way a bigint
  value is boxed elsewhere.
- The `map` row throws, so the result-store side may share the cause.

## Acceptance

- The five rows above match node on gc, standalone and wasi, pinned in a test under `tests/equivalence/`.
- No `undefined` placeholder is left for an i64 element in `emitElemBoxToExternref`. The one #7465 kept for
  i64/v128 is removed for i64, or limited to v128.

## Related, Session B (arrays)

Found in the same review (RV7431); not part of this issue:

- `reduce` with two formals reads `arguments[2]` and `arguments.length` wrong (node 12324, ours 6024).
- `forEach` visits holes in a sparse array.
