---
id: 4403
title: "compile failure: `valueOf` object in arithmetic inside a FUNCTION BODY — `local.set[0] expected (ref null N), found f64.const` — module scope works"
status: ready
sprint: Backlog
created: 2026-08-13
priority: medium
feasibility: medium
task_type: bug
area: codegen
language_feature: ToPrimitive / valueOf
related: [4157]
---

# #4403 — `valueOf` object arithmetic fails to compile inside a function body

## Problem

```ts
export function f(): number {
  var o: any = { valueOf: () => 7 };
  var s: number = o - 1; // COMPILE FAILURE
  return s;
}
```

fails Wasm validation:

```
local.set[0] expected type (ref null 76), found f64.const of type f64  @+48635
```

The identical pattern at **module scope** compiles and runs correctly:

```ts
var o: any = { valueOf: () => 7 };
var s: number = o - 1; // fine
```

## Provenance

Found 2026-08-13 during the #4157 ToNumber fast-path work (issue entry (20)),
by the workstream building `JS2WASM_FUSED_TONUMBER`. **Pre-existing, not
caused by that work**: reproduced byte-for-byte on pristine `origin/main`
blobs of every touched file — same function, same offset `@+48635` — with all
#4157 flags off. Recorded there as "unfiled; worth an issue"; this is that
issue. Filed with `pr_scan=degraded` (no `gh` in the container); the open-PR
scan equivalent was done by hand via the GitHub MCP against PRs #4453/#4454.

## Diagnosis starting point

The error shape — an f64 value assigned to a local declared as a struct ref —
suggests the function-body path declares the result local from the
*pre-coercion* type of the initializer (the `{ valueOf }` object's struct
type), while the module-scope path routes the same initializer through the
`externref → f64` ToPrimitive coercion first and declares the local `f64`.
Look at where `var` locals get their declared type inside a `FunctionContext`
versus module init: the annotation is `number`, so the local should be f64 in
both paths, and the subtraction's numeric hint (#3688) should compile the
operand with ToNumber applied.

The #4157 fixture suite works around it by hoisting the object to module scope
(`tests/issue-4157-tonumber-fast-paths.test.ts`); that workaround marks the
repro shape.

## Acceptance criteria

- The function-body form above compiles, validates, and returns `6`.
- Equivalence test comparing module-scope and function-body forms against
  native Node, both `-` and `+` (ToPrimitive `"default"` hint) operators.
- The #4157 fixture's module-scope hoist workaround can be removed (or is
  documented as no longer necessary).
