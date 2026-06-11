---
id: 1949
title: "fn.call(thisArg, …) / fn.apply(thisArg, […]) silently discard thisArg for functions that use this"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: this-binding
goal: core-semantics
related: [489, 473, 364, 1596]
origin: "2026-06-10 deep-audit sweep (closures agent): verified miscompile on main, WAT-proofed"
---

# #1949 — `.call`/`.apply` lowering drops the thisArg

## Problem

`getV.call(o, 1, 2)` evaluates `o` "for side effects", **drops it**, and passes
`undefined` as the callee's `this` parameter — even though the compiler
materializes a real this-param for functions whose body reads `this`. Silent
wrong values.

## Repro (verified on main)

```ts
function getV(this: any, a: number, b: number): number { return this.v + a + b; }
export function test(): string {
  const o = { v: 100 };
  return "" + getV.call(o, 1, 2) + "," + getV.apply(o, [3, 4]);
}
```

| probe | wasm | node |
|-------|------|------|
| `getV.call({v:77})` (body `return this.v`) | `0` | `77` |
| repro above | `"2,4"` | `"103,107"` |

WAT proof: `(drop (struct.new $0 (f64.const 77)))` then
`(call $getV (call $__get_undefined))`.

Related loud (not silent) failures on adjacent paths: `obj.method.call(other)`
→ `"call is not a function"`; `add.bind(null,1)` → `"bind is not a function"`.

## Root cause

`src/codegen/expressions/calls.ts:2517-2630`. Both Case 0 (function-literal
`.call/.apply`, :2589-2601) and Case 1 (`identifier.call(...)`, :2619-2624)
evaluate the thisArg and `drop` it, on the stated assumption "standalone
functions ignore `this`". But the compiler *does* emit a `this` param
(`(param $0 externref)`) for functions reading `this`, and direct-call sites
feed it `__get_undefined` (calls.ts:7247-7260) — the `.call/.apply` lowering
never threads the user thisArg into that slot. #1596's design notes codified
the drop.

## Fix direction

In Case 0/Case 1, detect that the callee has a this-param (same check the
direct-call path uses to inject `__get_undefined`) and pass the compiled
thisArg (boxed to externref) as that leading argument; keep the drop only for
callees with no `this` usage.

## Acceptance criteria

- Both repros match Node
- `.call`/`.apply` with no thisArg usage unchanged (no extra boxing)
- `.apply` array spread of args still correct alongside the this fix

## Dupe check

Grepped `thisArg`, `this binding`, `call/apply`, `drop.*thisArg`: #489, #473,
#364, #1596 all done; #1596 codified the drop — the wrong-this consequence is
tracked nowhere.
