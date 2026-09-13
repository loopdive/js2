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

## Verdict (planning pass, 2026-09-13)

already-fixed: Headline defect does not reproduce on 54c36a9fe3 in either lane: `let [a = ({z:1} as any)] = [] as any[]` binds {z:1} (a.z === 1) for let/const, host and standalone. The reported `undefined` came from serialising the returned WasmGC struct (JSON.stringify → undefined, Object.keys → []); the [undefined] control shows the identical artifact. Probe did surface a real sibling defect: with a LITERAL source of element type null (`let [a = {z:1}] = [null]`, untyped .js or TS without `as any[]`) the object default wrongly fires (a.z === 1 instead of null); via a variable it is correct. Also `f([null])` on an untyped destructuring param throws "value is not iterable", and `let [a = 9] = [null]` in .js binds 0. These need new issue ids, not #6439.

## Implementation Plan

**Verdict: already-fixed — the headline defect does not reproduce on upstream/main 54c36a9fe3 (measured 2026-09-13).** The `undefined` in the report is a measurement artifact, not a binding defect.

Measurement (host lane via `compile` + `buildImports` + `WebAssembly.instantiate`, same harness as `tests/issue-6419-closure-area-red-on-main.test.ts`; standalone via `target: "standalone"`; probe under `.tmp/p6439/`, run as `tests/probe-*.test.ts`):

| source | host | standalone |
| --- | --- | --- |
| `let [a = ({z:1} as any)] = [] as any[]; return a === undefined ? -1 : a === null ? -2 : a.z` | `1` | `1` |
| same with `const` | `1` | `1` |
| same with `[undefined] as any[]` (control) | `1` | `1` |
| same with `[null] as any[]` (null control) | `-2` (null preserved) | `-2` |
| untyped `.js`: `let [a = {z:1}] = []` | `1` | `1` |

Why the sweep read `undefined`: `return a` hands the export boundary a WasmGC struct, which the host sees as an opaque object — `typeof` is `"object"`, `Object.keys` is `[]`, and `JSON.stringify(v)` is `undefined`. Any probe that serialised the return value (the #6419 sweep did) printed `undefined` for BOTH the absent and the explicit-`undefined` case; reading `.z` inside the module shows the default fired in both. The two arms named in "Where to look" (`emitDefaultValueCheck` vs `emitNestedBindingDefault` in `src/codegen/destructuring-params.ts`) both bind the object-literal default correctly for an absent element; no change is needed there.

Close this issue as `already-fixed` (or re-title it as a measurement note). No regression test is warranted for the headline claim — the #6419 test already covers `[undefined]` with `.z`, and the absent case passes identically.

**Sibling defects surfaced by the probe (NOT this issue — file separately, `create-issue`):**

1. **Object-literal default fires on a `null` element when the SOURCE is a literal whose element type is `null`.** `let [a = {z:1}] = [null]` (untyped `.js`, or TS without `as any[]`) → `a.z === 1` (expected `a === null`). Also `let [b, a = {z:1}] = [0, null]` → `1`. Routing the same value through a variable (`const s = [null]; let [a = {z:1}] = s`) is correct (`-2`), and a string default (`let [a = "x"] = [null]`) is correct — so the responsible arm is the literal-source / struct-typed path where the element lowers to a nullable struct ref and the `ref.is_null`-based `emitDefaultValueCheck` arm treats Wasm null as absent. Fix shape: for a ref-typed slot whose source element can be JS `null`, the default guard must distinguish "absent/undefined" from "null" (sentinel or `__extern_is_undefined`), or the literal-source path must keep the element as externref. Regression test: untyped `.js` two-file fixture, `[null]` literal with object default expects null (fails on parent), `[undefined]` and `[]` expect `{z:1}` (anti-vacuity controls, pass on parent). Expected dogfood movement: none of the anchors exercise this shape; standalone lane identical (measured same on both).
2. **Untyped param destructure `function f([a = {z:1}]) {}; f([null])` throws `value is not iterable`** (host). Separate arm (`destructureParamArray` iterator guard on a `null[]`-typed literal argument).
3. **`let [a = 9] = [null]` in `.js` binds `0`** — `null` in an f64 slot coerces to `0` (documented `null → f64.const 0` policy in `type-coercion.ts`); a widening question, not a destructuring one.

## Dispatch

sonnet — close-out only: mark the issue `wont-fix`/`already-fixed` with the table above and file the three sibling findings as new issues via `claim-issue.mjs --allocate`; no compiler change.
