---
id: 1518
title: "spec gap: Annex B.3.2 — sloppy-mode function-in-block hoisting (`var` shadow)"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: annex-b, function-declaration, hoisting
goal: spec-completeness
sprint: 52
related: [1435]
---
# #1518 — Annex B function-in-block hoisting

## Problem

`annexB/language/eval-code/{direct,indirect}/` contributes
**~183 failing test262 cases** (133 direct + 50 indirect), plus
~10 in `annexB/language/function-code/` and
~10 in `annexB/language/global-code/`.

The dominant pattern:

```js
// SLOPPY MODE only
if (true) function f() { return 'decl'; }
typeof f;        // expected 'function' (Annex B.3.2)
// our compiler sees only the block-scoped binding → 'undefined'
```

Per ECMA-262 Annex B.3.2, in sloppy mode a `FunctionDeclaration`
inside a `Block`, `IfStatement`, `SwitchStatement`, `TryStatement`,
or `WithStatement` is **hoisted to two places**:

1. The block's lex env (modern semantics, like `let f`).
2. The surrounding function's var env (legacy var-like declaration).

At each evaluation of the block, the lex-env binding is copied into
the var-env binding (so the outer var-binding reflects the latest
function body executed in the block).

## Failure count

**~200 fails**. Realistic target: **~100 flips** — the patterns split
roughly 50/50 between "must hoist" (we don't) and "must update on
each evaluation" (we hoist but don't update).

## Root cause

`src/compiler/parser.ts` + `src/compiler/scope-analysis.ts` (or
equivalent) implement only the modern §13.2.6 / §14.4.3 path:
function declarations inside a block create a `let`-style binding
limited to the block.

The Annex B.3.2 algorithm is:

1. During scope analysis, identify candidate
   `FunctionDeclaration` nodes — those that **are not** in a
   strict-mode context, **are** at top level of a block, and **do
   not** conflict with a lexical binding (`let`/`const`/`class`) at
   the surrounding function scope of the same name.
2. For each candidate, emit a `var`-style binding at the surrounding
   function scope, initially `undefined`.
3. At runtime, when the block evaluates the declaration, write the
   function value to **both** bindings.

The interaction with `eval` (direct eval inside a block) is what
generates the eval-code cluster — Annex B.3.2's hoisting must run
inside the eval source's syntactic scope but write to the *caller's*
function var env, which our eval path does not implement.

## Files to touch

- `src/compiler/parser.ts` — flag function-in-block declarations.
- `src/compiler/scope-analysis.ts` — add Annex B var-bindings for
  candidates.
- `src/codegen/declarations.ts` — emit the dual write on each
  evaluation.
- `src/codegen/eval-shim.ts` (or wherever direct-eval lives) — wire
  the caller's var-env reference through.

## Acceptance criteria

1. ≥ 100 of 200 in `annexB/language/{eval-code,function-code,global-code}/`
   flip to `pass`.
2. Strict-mode tests in `annexB/language/{eval-code,function-code}/`
   still see *no* hoisting (no false positives in `language/statements/let/`).
3. `language/eval-code/direct/lex-env-no-init-cls.js` and friends
   are not regressed.

## Reference tests

- `annexB/language/function-code/if-decl-no-else-func-skip-early-err-for.js`
- `annexB/language/eval-code/direct/func-if-decl-else-decl-b-eval-func-no-skip-param.js`
- `annexB/language/global-code/switch-case-global-skip-early-err-for-in.js`

## Notes

This issue is **explicitly hard**. It is included in the audit
because the test impact is large (~200 tests), but the team may
choose to defer it to sprint 53 if the parser/scope changes risk
churning the working compile path. An alternative: skip-filter the
whole `annexB/language/eval-code/` directory and document the gap.
