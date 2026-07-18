---
id: 3373
title: "Annex B: call expressions as assignment/update/for-in targets are rejected at compile time"
status: done
created: 2026-07-17
updated: 2026-07-17
completed: 2026-07-17
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: parser, codegen
language_feature: annex-b, assignment-targets
goal: test262-conformance
assignee: codex/root
related: [3362]
files:
  - src/compiler.ts
  - src/codegen/expressions/assignment.ts
---

# #3373 — Annex B call-expression assignment targets

## Problem

Seven tests in the deterministic original-harness assignment sample are
rejected with `Invalid left-hand side` diagnostics instead of compiling with
the Annex B web-legacy semantics expected by Test262:

- `annexB/language/expressions/assignmenttargettype/callexpression.js`
- `annexB/language/expressions/assignmenttargettype/callexpression-in-compound-assignment.js`
- `annexB/language/expressions/assignmenttargettype/callexpression-in-postfix-update.js`
- `annexB/language/expressions/assignmenttargettype/callexpression-in-prefix-update.js`
- `annexB/language/expressions/assignmenttargettype/callexpression-as-for-in-lhs.js`
- `annexB/language/expressions/assignmenttargettype/callexpression-as-for-of-lhs.js`
- `annexB/language/expressions/assignmenttargettype/cover-callexpression-and-asyncarrowhead.js`

## Acceptance criteria

- Fetch and cite the current Annex B assignment-target algorithm.
- Add focused regressions for simple, compound, update, for-in, and for-of
  forms.
- The seven sampled tests no longer fail solely because TypeScript rejects the
  legacy syntax before js2wasm lowering can apply the required semantics.

## Implementation summary

The early-error pass now recognizes the non-strict Annex B
`~web-compat~` assignment-target form instead of rejecting it as an invalid
left-hand side. Assignment, compound assignment, prefix/postfix update,
`for-in`, and `for-of` lowering evaluate the call target and then throw the
required `ReferenceError` without evaluating the assignment RHS or coercing
the call result. Strict code retains the syntax error.

This follows [ECMA-262 Annex B.3.9, Runtime Errors for Function Call Assignment Targets](https://tc39.es/ecma262/multipage/additional-ecmascript-features-for-web-browsers.html#sec-runtime-errors-for-function-call-assignment-targets).

### Verification

- `tests/issue-3373.test.ts`: seven focused forms pass.
- Original harness: all seven sampled Annex B assignment-target tests pass.
