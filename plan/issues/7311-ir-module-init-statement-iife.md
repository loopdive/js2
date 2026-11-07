---
id: 7311
title: "IR: statement IIFE in a test's <module-init> — measured, stopped (yield ≤ 1 file)"
status: backlog
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7287, 7284, 7305, 7308]
assignee: "ttraenkler/c-lead"
---

# #7311: statement IIFE in a test's `<module-init>`

## Problem

R11's single-lever census (`plan/log/ir-module-init-single-lever-census.md`,
main `cc27f70d`, stride 40, standalone) lists 6 files whose only legacy unit is
`<module-init>` and whose only refusal family is a statement IIFE,
`(function () { … })();` / `(function () { … }());`
(`body-exprstmt-other(expr-call-callee-nonident):ParenthesizedExpression`).
The brief: lower it as a closure invoked once and stop at measurement if fewer
than 3 passing files flip.

## Measurement (2026-11-07, main `dc52abf7` / `cc27f70d`, standalone)

**Legacy's lowering.** Legacy does not call a closure:
`compileTailDispatch` (`src/codegen/expressions/call-tail-dispatch.ts`)
inlines a function-expression or arrow IIFE's body into the enclosing
function. Generator IIFEs and self-recursive named IIFEs are excluded and go
through the closure path. An IR lever matching legacy would therefore inline
the body into the `<module-init>` unit, so the body itself must be
IR-lowerable.

**Candidates.** These are the stride-40 files with a top-level IIFE whose only
legacy unit is `<module-init>`. All of them pass on standalone today.

| File | IIFE body as a plain IR function | Flips with an IIFE lever? |
|---|---|---|
| `annexB/language/function-code/block-decl-func-skip-early-err-try.js` | refused: `expr-ident-not-in-scope` «f» (a deliberate unresolvable read) | no |
| `annexB/language/function-code/if-decl-else-decl-b-func-skip-early-err-for.js` | refused: `expr-ident-not-in-scope` «f» | no |
| `annexB/language/function-code/if-decl-no-else-func-skip-early-err-try.js` | refused: `expr-ident-not-in-scope` «f» | no |
| `annexB/language/function-code/switch-case-func-skip-early-err.js` | refused: `body-unhandled-stmt:FunctionDeclaration` (Annex B block function in a `switch`) | no |
| `built-ins/ArrayIteratorPrototype/next/args-unmapped-iteration.js` | uses `arguments` (refused by the brief) | no |
| `language/statements/function/S13.2.1_A1_T1.js` | 32 nested empty statement IIFEs | **yes, the only one** |

The "plain IR function" column was measured by rewriting each IIFE as
`function __iife() { … } __iife();` and compiling it through the wrapped
harness (`JS2WASM_IR_SHAPE_DIAG=1`). The named function's refusal is the
refusal its inlined body would hit inside `<module-init>`.

Other files with a top-level IIFE are not single-lever. Their first refusal
is something else:

- `spread-obj-spread-order.js`: `vardecl-module-storage-unrepresentable`;
- `template-object-frozen-strict.js`: a tagged template;
- `12.14-16.js`: `var global = this`;
- the `15.2.3.6-4-*` and Annex B eval files also keep harness units.

**Yield: at most 1 passing file** (`S13.2.1_A1_T1.js`), below the
3-file bar. Stopped here; no code.

## What would unlock the annexB group

The four Annex B files need, inside the inlined body:

- a read of an unresolvable global that throws ReferenceError
  (`expr-ident-not-in-scope`);
- `typeof` of an unresolvable name;
- a destructuring catch parameter;
- Annex B block-function semantics (B.3.3 "skip early error").

Each is its own lever and larger than the IIFE arm. Revisit #7311 when two of
those land.
