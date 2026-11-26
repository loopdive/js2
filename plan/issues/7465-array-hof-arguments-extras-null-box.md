---
id: 7465
title: "Array HOF callback `arguments` extras are null instead of the index when `__box_number` is registered after the call site"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7416, 3165]
---

# #7465: array HOF `arguments` extras box to null

## Problem

Measured on the #7347 branch (main `31328186` merged), on gc, standalone and
wasi:

```ts
export function main(): number {
  const a: string[] = ["p"];
  return a.map(show)[0];
}
function show(x: string): number {
  return String(arguments[1]).length;
}
```

| program (callback declared after `main`) | node | gc | standalone | wasi |
| --- | ---: | ---: | ---: | ---: |
| `String(arguments[1]).length` | 1 | 4 | 4 | 4 |
| `arguments[1] === 0 ? 1 : 0` | 1 | 0 | 0 | 0 |
| `number[]` `[7]`, zero formals: `String(arguments[0]).length` | 1 | 4 | 4 | 4 |
| `number[]` `[7]`, zero formals: `arguments[0] === 7 ? 1 : 0` | 1 | 0 | 0 | 0 |

`arguments[1]` should be the index `0`, and `arguments[0]` the element `7`.
Both arrive as null, which reads back as `"null"`.

The same callbacks declared **before** `main` are correct on all three
lanes. So are callbacks whose own body registers `__box_number`, for example
through a `typeof arguments[1]` chain.

## Root cause

`emitArrayCallbackArgsPlumbing` (`src/codegen/array-methods.ts`) builds the
`arguments` extras vector for an array HOF callback. It looks up
`__box_number` with `ctx.funcMap.get`. When the helper is not registered
yet, it drops the index and pushes `ref.null.extern`.

The element arm, `emitElemBoxToExternref`, has the same fallback for f64 and
i32 elements.

Whether the helper is registered depends on compile order. A callback
declared after the call site has not been compiled yet, so nothing has
registered the helper, and the null takes the index's place.

#7416 found this site reached on gc (`issue-7165-string-vec-sort-undefined`,
`a.map(show)`), so it was left out of the `requireHelper` conversion. A hard
error there would break valid programs.

## Fix

Register the helper before the detached instruction list is built:

- call `ensureLateImport(ctx, "__box_number", [f64], [externref])`;
- then flush the late-import shifts;
- remove both null fallbacks.

`array-methods.ts:1526` already does this for its own `thisArg` box. Reuse
that pattern instead of adding a new one.

## Acceptance

- A test pins node's answer on gc, standalone and wasi for the four rows above.
- No `ref.null.extern` fallback is left in `emitArrayCallbackArgsPlumbing` or
  `emitElemBoxToExternref`, except the unboxable i64/v128 placeholder.
- The equivalence gate passes, including `issue-7165-string-vec-sort-undefined`.
- Code quality: one registration point shared by both arms, and no new
  wrapper.
