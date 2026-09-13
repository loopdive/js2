---
id: 6439
title: "An OBJECT default for an absent array-destructuring element still reads back `undefined`"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: compiler
goal: correctness
---

## Problem

Residual from
[#6419](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6419-three-closure-area-tests-red-on-main)
arm 2. That arm fixed the host lane's absent-element pad (it was
`ref.null.extern`, i.e. JS `null`, so §8.5.3 defaults never fired). Every
primitive and self-referencing case is correct now. One shape is not:

```ts
export function test(): any {
  let [ a = ({ z: 1 } as any) ] = [] as any[];
  return a;                 // → undefined   (expected { z: 1 })
}
```

Measured 2026-09-13, before and after the #6419 fix — unchanged in both, so it
is a separate defect, not a regression of that work. The sibling shapes all
pass:

| source | result |
| ------ | ------ |
| `let [a = 9] = []` | `9` ✓ |
| `let [a = "x"] = []` | `"x"` ✓ |
| `let [a = ({z:1} as any)] = [undefined]` | `{z:1}` ✓ |
| `let [a = ({z:1} as any)] = []` | **`undefined`** ✗ |

So the default fires when the element is an explicit `undefined` but not when
the element is absent — for an object-valued default specifically.

## Where to look

`destructureParamArray` (`src/codegen/destructuring-params.ts`) has two arms
for an element with a default: the `refFieldWithDefault` arm
(`emitDefaultValueCheck`, `ref.is_null`-based) and the externref arm
(`emitNestedBindingDefault`, `__extern_is_undefined`-based). An object-literal
default reaches the boundary between them; the object-literal compile also has
a dedicated `compileObjectLiteralAsExternref` path that one of the two arms
uses and the other does not.

## Acceptance criteria

1. `let [a = ({z:1} as any)] = []` binds `{z:1}`.
2. The `[null]` control still binds `null` (a default must not fire on null).
3. A regression test with both controls, `let` and `const`.
