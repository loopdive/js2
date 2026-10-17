---
id: 7019
title: "standalone: package module initialisation traps before any test runs — axios `utils.toObjectSet([...])` derefs null (and its 12-line reduction fails codegen with `dynamic array length fill requires a pre-reserved Hole global`), hono `helper/dev` throws `Array method called on null or undefined`, stylelint utils trap `illegal cast` in `__module_init`"
status: ready
sprint: current
created: 2026-10-16
updated: 2026-10-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: module-init, closures, arrays
goal: standalone-gap
related: [7013]
---

# Module initialisation fails on standalone in package graphs

Found by the [#7013](./7013-standalone-upstream-unit-lane.md) standalone
upstream unit lane. When `__module_init` throws, the lane records the file as
`module init: …` and none of its tests run (the JS-host lane passes them).
First measurement (2026-10-16):

| suite | files | tests lost | signature |
| --- | --- | --- | --- |
| axios | 5 (`cancel/isCancel`, `core/settle`, `helpers/isAxiosError`, `helpers/parseHeaders`, `helpers/validator`) | 23 | `RuntimeError: dereferencing a null pointer` in `__module_init_chunk_3` |
| hono | `helper/dev`, `utils/concurrent` | 14 | `TypeError: Array method called on null or undefined`; `dereferencing a null pointer` |
| stylelint | `isCounterIncrementCustomIdentValue`, `isKeyframeSelector` | 2 | `RuntimeError: illegal cast` |
| jest | `jest-watcher/prompt` | 4 | `TypeError: Cannot access property on null or undefined` |

## Repro (axios, standalone)

```ts
// entry.ts — the package file is axios@<pinned>/lib/utils.js from the npm-compat cache
import utils from "<npm-compat>/axios/package/lib/utils.js";
export function t1(): number { const o: any = utils.toObjectSet(["a", "b"]); return o.a === true ? 1 : 0; }
// standalone: RuntimeError: dereferencing a null pointer   (JS host: no trap)
```

`toObjectSet` is

```js
const {isArray} = Array;
const toObjectSet = (arrayOrString, delimiter) => {
  const obj = {};
  const define = (arr) => { arr.forEach((value) => { obj[value] = true; }); };
  isArray(arrayOrString) ? define(arrayOrString) : define(String(arrayOrString).split(delimiter));
  return obj;
};
export default { toObjectSet };
```

Compiled ALONE as `u.js` + the same entry, standalone compilation fails
instead: `Codegen error: dynamic array length fill requires a pre-reserved
Hole global (at src/codegen/vec-length-hole-fill.ts:120:13)` — a second bug on
the same shape (a destructured `Array.isArray` + nested arrow capturing `obj`
+ `forEach` with a computed-key store).

## Implementation Plan

1. Fix the reduction first: `vec-length-hole-fill.ts:120` — find which emitter
   reaches the dynamic length fill without reserving the Hole global
   (`grep -rn "pre-reserved Hole" src/codegen`), and reserve it in the
   collection pass for that shape. Add the 12-line repro as a test.
2. With the codegen error gone, re-run the reduction under the full axios
   `utils.js` to see whether the null deref is the same defect; if not, bisect
   `utils.js` top-down (delete exports not reachable from `toObjectSet` until
   the trap disappears) and record the minimal shape here.
3. hono `helper/dev`, stylelint, jest-watcher: compile each generated test
   module with `JS2WASM_UPSTREAM_TARGET=standalone` and `sourceMap: true`,
   map the trapping offset to source (`DOGFOOD_SOURCE_DIAG=1` worker support),
   and reduce the same way. File any signature that turns out to be a separate
   root cause as its own issue and link it here.
4. Scoped standalone test262 over every dir the fix touches, base vs fix.

## Acceptance

All files in the table initialise on standalone; their tests then pass or fail
on their own assertions; gc binaries byte-identical.
