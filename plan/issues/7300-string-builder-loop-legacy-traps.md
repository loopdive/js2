---
id: 7300
title: "String-builder loops: empty-receiver charAt traps, mixed-primitive appends trap, for-of string appends fail to compile"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [1210, 1744, 7291]
---

# String-builder loops: three pre-existing wrong results

Found by the fresh-context review of PR #7156 (#7291 step 2). All three
reproduce the same way on main `dc52abf7` and on the #7291 head: the #7291
change does not touch these routes. Each source below is a `.ts` file
compiled with `test()` exported.

## 1. `s += r.charAt(i)` with an empty receiver traps

```ts
function b(n: number, r: string): string { let s = ""; for (let i = 0; i < n; i++) { s += r.charAt(i); } return s; }
export function test(): number { return b(3, "").length; }
```

- **standalone and wasi:** `RuntimeError: array element access out of
  bounds`. JS gives `0`.
- **Likely cause:** legacy's #1744 single-code-unit fast path
  (`emitStringBuilderAppendCodeUnit`'s `charAt` arm in
  `src/codegen/expressions/operator-assignment.ts`) reads `data[off + i]`
  with no bounds check. `charAt` out of range is `""`, so it must append
  nothing.
- **Reference:** the IR builder's `stringBuilderAppendCharAtInstrs`
  (`src/backend/wasmgc/lowering/wasm-string-builder.ts`) is the
  bounds-checked shape to reuse.

## 2. Appending non-string primitives traps

```ts
function b(n: number): string { let s = ""; for (let i = 0; i < n; i++) { s += i; s += true; s += null; s += undefined; } return s; }
export function test(): number { return b(2).length; }
```

- **standalone and wasi:** `RuntimeError: illegal cast`. JS gives `"0truenullundefined1truenullundefined".length`.

## 3. `for…of` over `string[]` with string appends fails to compile

```ts
function b(a: string[]): string { let s = ""; for (const x of a) { s += x; s += x.charAt(0); } return s; }
export function test(): number { return b(["ab", "c"]).length; }
```

- **standalone, wasi and gc:** compile error, `IR path failed for b:
  ir/from-ast: checker-string RHS for "s +=" has contradictory carrier
  externref`.

## Acceptance

- All three return the JS value on standalone, wasi and gc.
- A regression test covers each.
- Output is byte-identical for builder loops that are already correct.
