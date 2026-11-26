---
id: 7434
title: "A `const` reassignment crashes the Prepared entry's from-ast mutation pre-pass instead of refusing"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: ir
goal: ir-full-coverage
depends_on: []
related: [7428, 7354]
---

# #7434 — `const` reassignment on the Prepared entry: an invariant error, not a refusal

## Problem

Found in the review of #7428 (PR #7344). `export function f(): number { const c = 1; c = 2; return c; }` through
the strict Prepared entry throws `IrProgramDriverInvariantError` from from-ast's mutation pre-pass. Before #7428 the
entry refused it earlier because TS2588 ("Cannot assign to 'c' because it is a constant") was an error-severity
diagnostic, and the presentation refused every such diagnostic. #7428 applies the ordinary single-source policy, under
which TS2588 is not a hard code, so the program now reaches the IR. Main already throws the same invariant error under
`skipSemanticDiagnostics` (the test262 lane's mode), so the crash predates #7428; #7428 only stops hiding it on the
direct Prepared entry.

## Fix

Either refuse at select by name (a write to a `const` binding), or lower it to the runtime TypeError that ECMAScript
specifies for an assignment to an immutable binding (§9.1.1.1.5 SetMutableBinding, strict: TypeError). Never claim the
unit and then fail in the pre-pass.

## Acceptance

- The program above, through the strict Prepared entry, either refuses with a named refusal or compiles to code that
  throws a catchable TypeError (node agrees); no invariant error, with and without `skipSemanticDiagnostics`.
- A pin in the Prepared-entry tests.
