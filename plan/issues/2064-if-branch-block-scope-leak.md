---
id: 2064
title: "let/const declared in if/else branch blocks leak into the enclosing scope (shadow not restored, const-ness leaks)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: block-scoping
goal: core-semantics
related: [968, 462]
origin: "2026-06-10 deep-audit sweep (control-flow agent): verified miscompile on main"
---

# #1944 — `if (c) { let x = 2; }` clobbers outer `x` for the rest of the function

## Problem

Block-scoped declarations inside `if`/`else` branch blocks permanently shadow
the outer binding in `fctx.localMap`: subsequent reads of the outer variable
see the inner local's value, and an inner `const` makes later writes to the
outer `let` throw "assignment to constant". Utterly ordinary code, silently
wrong.

## Repro (verified on main)

```ts
export function ifBlock(): number {
  let x = 1;
  const c: boolean = true;
  if (c) { let x = 2; x++; }
  return x;            // must be 1
}
export function constShadow(): number {
  let x = 1;
  const c: boolean = true;
  if (c) { const x = 9; }
  x = 7;               // must be legal
  return x;
}
```

| fn | wasm | node |
|----|------|------|
| `ifBlock` | `3` | `1` |
| else-branch variant | `3` | `1` |
| `if (true)` const-folded variant | `3` | `1` |
| `constShadow` | throws WebAssembly.Exception ("assignment to constant") | `7` |

Controls: bare block `{ let x = 2; }` and while-body block are correct — only
the if paths leak.

## Root cause

`src/codegen/statements/control-flow.ts` `compileIfStatement` iterates
branch-block statements directly — then-branch :477-483, else-branch :516-522,
and the constant-folding path :416-431 — bypassing the
`saveBlockScopedShadows`/`restoreBlockScopedShadows` handling that the generic
Block case in `src/codegen/statements.ts:145-155` applies. The inner `let x`
overwrites `fctx.localMap` (and `constBindings`) for the rest of the function.

## Fix direction

In all three places, either call `compileStatement(ctx, fctx, branch)` so the
Block case runs, or wrap the direct iteration in
`saveBlockScopedShadows(fctx, block)` / `restoreBlockScopedShadows`.
(Loops/try/catch/finally already do this; `if` was simply missed.)

## Acceptance criteria

- All four repros match Node
- Shadowing inside nested ifs and else-if chains correct
- TDZ/closure-capture of the inner binding unaffected
- Equivalence suite green

## Dupe check

Grepped `shadow`, `block scop`, `leak`, `compileIfStatement`: #968 (done —
different cause: locals dedup), #462 (null-narrowing save/restore — different
state). Not covered. Survives test262 because block-scope tests there use bare
blocks/loops and TS flags many shadow patterns.

## Resolution (2026-06-11)

In `compileIfStatement` (`src/codegen/statements/control-flow.ts`), the four
spots that iterated branch-block statements directly — the const-fold then/else
paths and the regular then/else branches — now call
`compileStatement(ctx, fctx, branch)` instead. That routes a branch `Block`
through the generic Block case in `statements.ts`, which already runs
`saveBlockScopedShadows`/`restoreBlockScopedShadows` (saving and restoring
`localMap`, `constBindings`, TDZ flags, and null-guard aliases for the inner
`let`/`const` names). `compileStatement` also handles the brace-less
single-statement form. No new state introduced; loops/try/catch already did
this — `if` was simply missed.

Verified: all four repros + nested-if / else-if-chain + used-then-restored
cases match Node (`tests/equivalence/if-branch-block-scope.test.ts`, 6 green).
The narrowing/typeof-narrowing buffer (`pushBody`/`thenInstrs`) and `#1712`
else-branch parking are untouched — the branch body is still captured from
`fctx.body` after the call.
