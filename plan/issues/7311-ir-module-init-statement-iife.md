---
id: 7311
title: "IR: statement IIFE in a test's <module-init> — re-measured on main + pending levers, stopped (≤ 1 statement, 9 expression files)"
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
assignee: "ttraenkler/root-iife"
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

## Re-measured (2026-11-07, root, claim on #6583): still stopped, yield 1 statement + 9 expression files

**Why a re-measurement.** The ES5 blocker map built on top of the pending levers listed
`[IIFE]` as the only refusal in about 220 files. That count is label-level: the selector
refuses the callee before it looks at the body, so a file whose only label is the IIFE can
still have a body that refuses. The R9 method above, which rewrites the body as a
hoisted function, is the measure that counts.

**Method.**
- Population: the 736 ES5 files with an IIFE, from a parse scan over the 9,174 ES5 files of
  the edition classifier. 745 of their 838 IIFEs are at the top level.
- Compile each file on standalone with `JS2WASM_IR_SHAPE_DIAG=1` and
  `JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`. Read every legacy unit's refusals, folding harness
  units and dropping knock-ons, as in the ES5 blocker map.
- "IIFE-only, label": every refusal of the file is the IIFE's (`…callee-nonident[IIFE]`).
- "IIFE-only, body": the same file with every top-level IIFE rewritten as
  `function __iife_k(…) {…}` appended at the end and called in place (`.call(this)` becomes a
  plain call). The file then compiles with no legacy unit. This is an upper bound for any IIFE
  lowering that runs the body as an IR function.
- Two trees:
  - **main** `cb64e11d5f`;
  - **overlay**: main plus the pending levers T, L2, R2, B, W, V, A2c (A3) and R3, merged
    locally and never pushed.

| position | form | args | body uses | module vars | carriers (main) | IIFE-only, label (main / overlay) | IIFE-only, body (main / overlay) |
|---|---|---|---|---|---|---|---|
| stmt | `(function(){}())` | no args | eval | no capture | 137 | 0 / 60 | 0 / 0 |
| stmt | `(function(){}())` | no args | nested-fn | no capture | 56 | 56 / 56 | 0 / 0 |
| stmt | `(function(){}())` | no args | nested-fn | writes module var | 91 | 35 / 35 | 0 / 0 |
| expr | `(function(){})()` | no args | return-value | no capture | 18 | 11 / 13 | 9 / 9 |
| stmt | `(function(){}())` | args | nested-fn | writes module var | 8 | 8 / 8 | 0 / 0 |
| stmt | `(function(){}())` | args | eval | no capture | 8 | 0 / 6 | 0 / 0 |
| stmt | `(function(){})()` | no args | nested-fn+this | no capture | 6 | 6 / 6 | 0 / 0 |
| expr | `(function(){})()` | no args | nested-fn+return-value+this | no capture | 6 | 6 / 6 | 0 / 0 |
| expr | `(function(){})()` | no args | - | no capture | 11 | 5 / 5 | 0 / 0 |
| expr | `(function(){})()` | no args | return-value+this | no capture | 5 | 4 / 5 | 0 / 0 |
| stmt | `(function(){})()` | no args | - | writes module var | 5 | 5 / 5 | 0 / 0 |
| stmt | `(function(){})()` | no args | - | no capture | 7 | 4 / 4 | 1 / 1 |
| stmt | `(function(){})()` | no args | nested-fn | no capture | 7 | 2 / 3 | 0 / 0 |
| expr | `(function(){})()` | args | return-value | no capture | 4 | 2 / 2 | 0 / 0 |
| stmt | `(function(){}())` | no args | arguments+nested-fn | no capture | 6 | 1 / 1 | 0 / 0 |
| stmt | `(function(){})()` | no args | nested-fn | writes module var | 6 | 1 / 1 | 0 / 0 |
| expr | `(function(){})()` | args | nested-fn+return-value | no capture | 2 | 1 / 1 | 0 / 0 |
| **files** (a file can carry several shapes) | | | | | 634 | **147 / 217** | **10 / 10** |

**What blocks the bodies.** The overlay figures cover the 211 rewritten files.
- 196 files: `call-graph-closure`, a knock-on of the body's own refusal.
- 66 files: `eval` inside the body (`expr-global-eval-statement`), the Annex B eval-code
  family.
- 64 + 3 files: an unresolvable or Annex B block-function name (`expr-ident-not-in-scope(f)`).
- 14 + 3 files: `body-unhandled-stmt`, a block-level function declaration.
- 9 files: `param-shape-rejected`.
- 8 files: `vardecl-var-kind`.
- The remaining rows are 5 or fewer each, including a nested IIFE and `vardecl-let-closure`.

Several of these blockers are the Annex B levers listed above ("What would unlock the
annexB group"). None of them is an IIFE lowering.

**The 10 that would flip.**
- **9 expression IIFEs**, all `built-ins/String/prototype/*/…_A1_T{4,5}.js` and
  `S15.5.4.7_A3_T3.js`. Their shape is `function(){ return "lego" }().charAt(null)`: a string
  result used as a method receiver. They are not statement IIFEs. #7106's closure planner
  (`codegen/function-member-closure-planning.ts`) admits a string result, so a fourth planner
  site, "the callee of a call", would cover them. Gain: 9 files.
- **1 statement IIFE**, `language/statements/if/S12.5_A4.js`. This matches R9's ≤ 1.

**Decision: stopped again, no code.**
- Upper bound: 10 files on main, 10 on the overlay.
- That is below the brief's ≈20-file bar.
- The statement-IIFE share is 1 file, below the 3-file bar.

Revisit when the Annex B block-function and eval-in-function levers land: the 56 + 35 + 8
`nested-fn` statement rows and the 60 + 6 `eval` rows are exactly those bodies. When the
lowering is built, use a fourth `FunctionClosureSite` (the callee of a call, owned by
`<module-init>`), lowered through `closure.new` + `closure.call`. Do not inline the body the
way legacy's `compileTailDispatch` does.
