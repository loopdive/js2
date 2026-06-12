---
id: 1980
title: "IR: while/for with a numeric-truthiness condition emits invalid Wasm and bricks the entire module (no fallback, verifier silent)"
status: done
sprint: 62
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1280, 1850]
origin: "2026-06-10 deep-audit sweep (IR agent): verified on main @ 0c753ea88, IR path"
---

# #1980 — loop cond lowering skips the i32 type check that `if`/ternary have

## Problem

```ts
export function f(n: number): number {
  let s = 0; let k = n;
  while (k) { s = s + k; k = k - 1; }   // f64-typed JS-truthiness cond
  return s;
}
```

IR: `CompileError: I32Eqz value type mismatch` — and **every export of the
module** fails to instantiate. Legacy: `f(3)=6`, `f(0)=0` (= node). Same for
the `for` variant. This is both a lowering bug and a fallback-mechanism gap:
the IR should throw-and-fall-back instead of shipping broken Wasm.

## Root cause

`lowerWhileStatement` (`src/ir/from-ast.ts:2898-2914`) and `lowerForStatement`
(from-ast.ts:2928-2960) take `condValue` from the cond buffer's last
instruction **without checking its IrType is i32** — unlike `if`
(from-ast.ts:620-623) and ternary (from-ast.ts:3464-3469) which throw a clean
fallback. The lowerer then unconditionally emits `i32.eqz`
(`src/ir/lower.ts:1919-1922`). The IR verifier registers `condValue` as a use
but never type-checks it (`src/ir/verify.ts:592-594` — concrete instance of
the #1850 gap). Side note: taking `condInstrs[last].result` as the cond root
(from-ast.ts:2902/2951) is fragile — use `lowerExpr`'s returned value id.

## Fix direction

Use the value returned by `lowerExpr` and throw the same "cond must be bool"
fallback error if `typeOf(condValue)` isn't i32 (restores legacy behavior for
numeric-truthiness loops; proper ToBoolean lowering can come later). Add an
i32 check on `condValue` to verify.ts under #1850. `tests/issue-1280.test.ts`
only uses `i < N` conditions — add truthiness-cond cases.

## Acceptance criteria

- Repro compiles (via fallback or correct lowering) and returns `6`/`0`
- Verifier rejects non-i32 loop conds
- #1280's claimed loop shapes unregressed

## Dupe check

#1280 (introduced while/for claims — no mention), #1850 (verifier umbrella,
in-progress — lists dominance/buffer recursion, not cond typing).

## Resolution (2026-06-12)

Two source changes, both following the fix direction:

1. **`src/ir/from-ast.ts`** — `lowerWhileStatement` and `lowerForStatement`
   now capture the value id `lowerExpr` returns (instead of the fragile
   `condInstrs[last].result`) and throw the same `if`/ternary-style fallback
   (`"while/for condition must be bool"`) when `asVal(typeOf(condValue))` isn't
   i32. The IR demotes the function to the legacy path, which already does
   ToBoolean lowering for numeric-truthiness loops — restoring `f(3)=6`,
   `f(0)=0` for both the `while` and `for` repros.

2. **`src/ir/verify.ts`** — `while.loop`/`for.loop` now type-check `condValue`
   after walking the cond buffer: a non-i32 condValue pushes a
   `"condValue must be i32"` error. This is the structural backstop for the
   #1850 gap (the lowerer throw in (1) fires first, but the verifier should
   never wave a non-i32 loop cond through to the unconditional `i32.eqz`).

### Test Results

New `tests/issue-1980.test.ts` — 5 cases, all pass:
- `while (k)` / `for (; k; )` with an f64 counter → `f(3)=6`, `f(5)=15`,
  `f(0)=0` (were: `i32.eqz expected i32, found f64` invalid-Wasm, whole module
  failed to instantiate).
- i32-comparison `for (i < n)` and `while (i < n)` loops → unchanged, still
  compile via the IR path (`f(4)=6`).

`tests/issue-1280.test.ts` (9/9) and `tests/issue-1844.test.ts` pass — #1280's
claimed loop shapes unregressed. Pre-existing failures in
`tests/ir/passes.test.ts` / `tests/ir/inline-small.test.ts` (8 total) are
confirmed identical on clean `origin/main` — unrelated to this change (they
exercise `if`/`return`/inline, not loops). `tsc --noEmit`, `biome lint`,
`prettier --check` all clean on the changed files.
