---
id: 5361
title: "Array.prototype.splice inserts a SPREAD argument as one element instead of expanding it"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`a.splice(start, deleteCount, ...items)` inserts the SPREAD SOURCE as a single
element. `compileArraySplice` (`src/codegen/array-methods.ts`) counts inserted
items syntactically —

```ts
const insertCount = Math.max(0, callExpr.arguments.length - 2);
```

— so a `SpreadElement` counts as one, and the array itself is stored in the
slot. `Array.prototype.push` already has a dedicated runtime-length spread path
(`compileArrayPushDynamicSpread`, gated by `tryCompileArrayPushDynamicSpread`);
`splice` has no equivalent, and neither does the host bridge
`compileArrayMethodExtern` (it `__js_array_push`es one element per argument
node).

The nested array is only visible once something reads the element:

```js
const sections = 'a:b:c'.split(':');
sections.splice(-1, 1, ...'x:y'.split(':'));
sections.length;          // 3   (should be 4)
sections.join(':');       // "a:b:x,y"   (should be "a:b:x:y")
sections[2].padStart(4);  // TypeError: padStart is not a function
```

## Evidence

Found while fixing #5338. It is the whole of the residual hono
`src/utils/ipaddr.test.ts` failure set (3 of 16 after #5338 landed, all
`padStart is not a function`): `expandIPv6('::ffff:127.0.0.1')` takes the
IPv4-mapped branch

```js
sections.splice(-1, 1, ...convertIPv6BinaryToString(...).substring(2).split(':'))
```

and every later `sections[i].padStart(4, '0')` then runs on an array.

Measured on `upstream/main` `efa9e76f07` through the hono dogfood lane, and
identically with #5338's codegen reverted — so this is independent of that fix,
not a consequence of it:

| probe | native | wasm |
| --- | --- | --- |
| `splice(-1, 1, ...'x:y'.split(':'))` then `.length` | 4 | **3** |
| `'1:2:127.0.0.1'` + splice-spread, then `.join(':')` | `1:2:7f00:0001` | **`1:2:7f00,0001`** |
| `splice(1, 1, 'x', 'y')` (no spread, control) | ok | ok |

Two adjacent defects surfaced by the same probes, likely the same root
(spread expansion in an argument list that is built element-per-node):

- `Math.max(...[1, 5, 3])` → `NaN` (spread of an ARRAY LITERAL; a spread of a
  host array from `.split()` works);
- `a.push(...['x','y'])` → appends two empty slots;
- `hostArray.concat(otherHostArray)` → `RuntimeError: illegal cast`.

## Acceptance criteria

1. `splice` with one or more spread arguments inserts every element of the
   spread source, in order, with the correct resulting length — for a host
   (externref) receiver and a native vec receiver.
2. Spread of an ARRAY LITERAL works in the same positions (the `Math.max`
   probe above returns 5).
3. hono `src/utils/ipaddr.test.ts` reaches 16/16.
4. Regression test under `tests/` with untyped `.js` two-file fixtures pinning
   the resulting length AND the joined value (a `join` with the default `,`
   separator hides the defect — the nested array stringifies to the same text;
   use a non-comma separator or assert `length`).
5. A/B at one HEAD over the 17 dogfood suites; nothing regresses.

## Implementation Plan

1. Read `compileArrayPushDynamicSpread` in `src/codegen/array-methods.ts` — it
   is the established runtime-length pattern (materialize the source, read its
   length, grow the backing array, copy).
2. `compileArraySplice`'s insert path already rebuilds the backing array when
   `insertCount > 0`, which is the hard part; what it lacks is a RUNTIME insert
   count. Compute the count into a local (static args contribute 1 each, a
   spread contributes its measured length) and drive the existing rebuild from
   that local instead of the constant.
3. Decide the host-receiver lane deliberately: `compileArrayMethodExtern` would
   also need spread expansion if `splice` routes there. Prefer one shared
   argument-list builder over a second bespoke one — `emitSetExtrasArgv`'s
   spread arm in `src/codegen/statements/nested-declarations.ts` is the
   existing "expand spreads into a runtime-length externref vec" code.
4. `array-methods.ts` is a god-file at its LOC ceiling; put the new builder in
   its own module.
