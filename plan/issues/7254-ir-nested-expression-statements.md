---
id: 7254
title: "IR: nested expression statements refused as `body-exprstmt-other` — measure the hidden value refusals"
status: in-progress
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [5163, 7106, 7240]
assignee: "ttraenkler/c-lead"
# 2026-11-05: +~20 lines in select.ts — the catch-all attribution must sit with
# `shapeNo` / `probeShape`, whose first-wins detail state is module-private there.
loc-budget-allow:
  - src/ir/select.ts
---

# #7254: `body-exprstmt-other` hides the value refusal behind it

## Problem

`ir_only_pass` (standalone test262 passes with zero legacy units) is flat at
1088 / 48232. A blocked-by-one census (wrapped ledger, stride 40, standalone,
2026-11-05) found 9 files whose only blocker is `body-exprstmt-other`
(`src/ir/select.ts`, the catch-all of `isPhase1BodyStatement`): an expression
statement inside a nested body that no statement arm admits. The working
hypothesis was that these are shapes with an IR value lowering that only lack
the statement (discard) form, so they could be admitted next to #5163.

## Measurement (2026-11-05, before any code change)

Wrapped compile of every stride-40 test262 file, standalone, through
`measureSource` from `scripts/ir-claim-ledger.mts` with
`JS2WASM_IR_SHAPE_DIAG=1`, at `origin/main` e73e190c6c. The row is the unit's
first refusal. To see what the discard probe refused, `probeShape` was
temporarily patched to expose the inner detail (scratch only, not committed).

15 rows in 15 files, all in `<module-init>` (nested in `try` / block bodies of
the script). 12 of the 15 files have no other unsupported unit.

| Statement shape | Rows | Example | Inner (value) refusal | Value lowering in IR? |
| --- | ---: | --- | --- | --- |
| IIFE `(function () { … }())` | 5 | `annexB/language/function-code/switch-case-func-skip-early-err.js` | silent `return false` — call with a non-identifier callee (`select.ts`, the call arm) | none |
| tagged-template IIFE `(function (p) { … })\`\`` | 1 | `language/expressions/tagged-template/template-object-frozen-strict.js` | `expr-unhandled:TaggedTemplateExpression` | none |
| `new` as a statement | 4 | `built-ins/RegExp/valid-flags-y.js` | `expr-new-regexp-target` (host-free standalone), `expr-new-extern-host-free` (`new Promise`), `expr-new-ctor-unknown` (`new Integer`), `expr-new-callee-nonident` (`new 1`) | refused in value position too |
| `delete` member | 2 | `built-ins/.../let-ary-init-iter-get-err-array-prototype.js` (`delete Array.prototype[Symbol.iterator]`) | `expr-delete-no-ir-lowering` (only the dynamic-parameter receiver of #7106 lowers) | none (keep refused, #2949) |
| `in` on a primitive | 1 | `language/expressions/in/S11.8.7_A3.js` (`"toString" in true`) | `expr-binary-op-in` | refused in value position too |
| `typeof await e` in a module | 1 | `language/module-code/top-level-await/syntax/typeof-await-expr-null.js` | `expr-await-outside-async` | refused in value position too |
| bare identifier / member read, `void`, comma | 0 | — | — | already admitted by #4459 |

### Finding

**No row is a statement-position gap.** The #4459 discard arm already re-tests
every such statement as a value through `isPhase1Expr`; each of the 15 rows is
there because the VALUE lowering is refused. Admitting a "discard form" would
need the value lowering first, which this slice's own rules exclude (a refused
value lowering stays refused; `delete` on a non-parameter receiver stays
refused, #2949). So the expected flip of 9 files is not available here.

The largest real bucket is the IIFE (6 of 15 rows, 5 sole-blocker files): it
needs a Phase-1 lowering of a call whose callee is a function expression
(closure creation, captures of module storage, `arguments`, Annex B
function-in-block hoisting in the body). That is a feature, not an `s` slice,
and is left for its own issue.

## What this issue ships

A diagnostics-only change, so the next census attributes these rows to the
missing value lowering:

- Under `JS2WASM_IR_SHAPE_DIAG=1`, the expression-statement catch-all labels
  (`body-exprstmt-other`, and the top-level `nontail-*` catch-alls) carry the
  declined probe's first-refusal arm, e.g.
  `body-exprstmt-other(expr-binary-op-in)`; a `delete` reads
  `body-exprstmt-other(expr-delete-no-ir-lowering)`.
- The silent refusal of a non-identifier callee now records
  `expr-call-callee-nonident`.
- Without the variable nothing changes: `shapeNo` records only under
  SHAPE_DIAG, the probe still restores detail and typed reason, and no claim
  decision reads the new state.

## Acceptance

- Wrapped stride A/B (SHAPE_DIAG): every `body-exprstmt-other` row carries an
  inner arm; route, compileOk and invariant counts identical.
- Claim outcomes and binaries identical with and without SHAPE_DIAG
  (`tests/issue-7254-exprstmt-refusal-attribution.test.ts`).
