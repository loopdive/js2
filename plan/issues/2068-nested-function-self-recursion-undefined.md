---
id: 2068
title: "nested function declarations: self-recursion and forward sibling calls silently call undefined (fact(5) → 0)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: functions
goal: core-semantics
related: [256, 1312]
origin: "2026-06-10 deep-audit sweep (closures agent): verified miscompile on main, WAT-proofed"
---

# #1948 — no-captures nested functions registered too late

## Problem

A plain nested `function fact(n) { ... fact(n-1) ... }` (no captures) silently
computes through `undefined`: the recursive (or forward-sibling) call resolves
to the unknown-identifier fallback (`ref.null extern` → `__unbox_number(null)`
→ `0`). Bread-and-butter code, silent wrong results.

## Repro (verified on main)

```ts
export function test(): number {
  function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }
  return fact(5);
}
export function test2(): number {
  function a(n: number): number { return b(n) + 1; }
  function b(n: number): number { return n * 2; }
  return a(10);
}
```

| probe | wasm | node |
|-------|------|------|
| `fact(5)` | `0` | `120` |
| `a(10)` | `1` | `21` |
| mutual nested `isEven(4),isOdd(4)` | `"false,false"` | `"true,false"` |

Controls: top-level `fact(5)` OK (`120`); nested recursion **with a capture**
(`base * pow(n-1)`) OK (`32`).

WAT proof (wasm-dis): the recursive call compiles to
`(f64.mul (local.get $0) (call $__unbox_number (ref.null noextern)))`.

## Root cause

`src/codegen/statements/nested-declarations.ts:401-415` and `:506-518`. The
no-captures branch of `compileNestedFunctionDeclaration` registers `funcName`
in `ctx.funcMap` only **after** compiling the body (line 518), so during body
(or earlier-sibling) compilation the name is unresolved. The in-code comment
says pre-registration was reverted because it broke 38
`built-ins/Function/15.3.5.4_2-*gs.js` tests that *accidentally* pass via
`null.caller` throwing TypeError, and asserts "the recursive cases #1312
targets all have captures" — wrong: any plain nested function has no captures.
The has-captures branch pre-registers correctly (line 646, #1312).

## Fix direction

Pre-register the reserved function index in the no-captures branch too (same
reserved-entry pattern as the captures branch at :637-646), and solve the
`Function.caller` strict-TypeError tests properly (emit an explicit throw for
`.caller`/`.arguments` access) instead of relying on the accidental null-deref.

## Acceptance criteria

- All three repros match Node
- `built-ins/Function/15.3.5.4_2-*` test262 family does not regress (handle
  `.caller` explicitly)
- Mutual recursion among 3+ nested siblings correct

## Dupe check

Grepped `nested function`, `recurs.*nested|inner`, `pre-regist`, `15.3.5.4`,
`forward reference.*function`: #256 (hoisting, done), #1312 (async recursive
closure — captures branch, done), #1858/#1820 (IR ternary). The no-captures
late-registration gap is untracked.
