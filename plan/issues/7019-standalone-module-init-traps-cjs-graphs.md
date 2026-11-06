---
id: 7019
title: "standalone: package module initialisation traps before any test runs — axios `utils.toObjectSet([...])` derefs null (and its 12-line reduction fails codegen with `dynamic array length fill requires a pre-reserved Hole global`), hono `helper/dev` throws `Array method called on null or undefined`, stylelint utils trap `illegal cast` in `__module_init`"
status: done
sprint: current
created: 2026-10-16
updated: 2026-10-18
completed: 2026-10-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: module-init, closures, arrays
goal: standalone-gap
related: [7013, 7052, 7053, 7054, 7057, 7058, 7059, 7060, 7061]
# 2026-10-17 — the omitted-argument pad is emitted by pushDefaultValue in
# type-coercion.ts, the one helper every call path uses; the fix is a guard on
# its existing `ref` arm, not a new code path.
loc-budget-allow:
  - src/codegen/type-coercion.ts
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

## Resolution

Six separate root causes, one PR each (all stacked on #6718). Each has a
regression test that fails on the parent:

| root cause | issue | PR | reached by |
| --- | --- | --- | --- |
| an omitted argument whose caller slot is a non-null ref was padded `ref.null; ref.as_non_null` (an unconditional trap) | #7019 (this file, `type-coercion.ts`) | this PR | axios `utils.toObjectSet([...])` |
| multi-source finalize ran the dynamic length fill before `$__hole` existed (compile error) | [#7052](./7052-standalone-hole-reserve-multisource-finalize.md) | #6736 | the 12-line reduction above |
| a binding holding `C.prototype` / `this.prototype` got the instance-struct slot and was nulled | [#7053](./7053-standalone-class-proto-binding-slot.md) | #6735 | axios `AxiosHeaders.accessor([...])` |
| a rest-parameter closure stored in a property was called positionally | [#7054](./7054-standalone-callable-property-rest-pack.md) | #6734 | hono `helper/dev` (`this.use = (a, ...hs) =>`) |
| `[...map]` took its carrier from the key type, not `[key, value]` entries | [#7057](./7057-standalone-map-spread-entry-carrier.md) | #6733 | stylelint `reference/keywords.mjs` |
| `ReadonlyMap`/`ReadonlySet` receivers skipped the native collection dispatch | [#7058](./7058-standalone-readonly-collection-method-dispatch.md) | #6732 | stylelint `reference/keywords.mjs` |

Measured 2026-10-17/18, standalone upstream lane, parent (#6718 tip
`70f2a4e`) vs all six fixes, both sides run here:

| suite | parent | with fixes | module-init failures left |
| --- | --- | --- | --- |
| axios | 44/231 | 64/231 | 0 (were `isCancel`, `isAxiosError`, `settle`, `validator`, `parseHeaders`) |
| stylelint | 100/108 | 103/108 | 0 |
| hono | 32/324 | 33/324 | `utils/concurrent` → [#7059](./7059-standalone-filter-builtin-callback-reference-elements.md) |
| jest | 185/356 | 185/356 | `jest-watcher/prompt` (see below) |

gc binaries are byte-identical: 13 fixtures hashed before and after (the
reductions plus generated axios and stylelint test modules). Scoped standalone
test262, base vs fix:

- Slice 1 (492 rows: built-ins/Map, Set ops, rest-parameters, calls, class
  definition, spread, `X.prototype` bindings): 434 vs 434, identical non-pass
  rows.
- Slice 2 (535 rows: arguments-object, function-code,
  Function.prototype.apply, arrow functions): 430 vs 430. Every row that
  differed was a compile timeout under machine load and passes when re-run
  alone.

Not fixed here:

- `jest-watcher/prompt` fails at `constants.ts:8`, `process.platform`. There is
  no `process` global on standalone. That is the platform-global cluster of
  [#7016](./7016-standalone-upstream-host-import-leak.md), not a codegen trap.
- Filed while reducing:
  - [#7059](./7059-standalone-filter-builtin-callback-reference-elements.md):
    `strings.filter(Boolean)` answers `[]`. This is what makes hono
    `utils/concurrent` fail at init.
  - [#7060](./7060-standalone-any-receiver-use-disposablestack-dispatch.md):
    `anyValue.use(…)` is captured by `DisposableStack.prototype.use`.
  - [#7061](./7061-standalone-instance-misses-runtime-proto-methods.md):
    instances miss methods that are installed on `C.prototype` at runtime.
