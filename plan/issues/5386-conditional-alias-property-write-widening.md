---
id: 5386
title: "Preserve property type changes through conditional object aliases"
status: in-review
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: compiler
language_feature: objects
goal: correctness
assignee: "ttraenkler/codex-alias"
# 2026-09-08: small hooks in existing collectors, local registration, console,
# addition, and identifier reads propagate one declaration-scoped property
# widening fact. The traversal lives in strict-eq-stale-type.ts and the new
# widened-property-return.ts helper; a broader driver split is outside this fix.
loc-budget-allow:
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/index.ts
  - src/codegen/binary-ops.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/statements/variables.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/expressions/identifiers.ts
func-budget-allow:
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
---

## Problem

A property write through an alias selected by a conditional must update the
original object, including when the write changes the property's runtime type.
The locally built js2wasm compiler accepts this program but prints `NaN`:

```js
const a = { x: 1 };
const b = true ? a : { x: "" };
b.x = "x";
console.log(a.x + 1); // Must print: x1
```

Node.js 24.4.1 prints `x1`. The local js2wasm `dist` build, compiled with
`target: "node"` and run under Node, prints `NaN`. This initial observation is
from the existing build; source-level baseline and fix evidence will be recorded
below. The isolated fix starts at `16498efb481cb0`.

For comparison, scriptc 0.0.36 refuses line 3 with SC1090,
`assignment to non-variables are not supported yet`. Fixing that separate
compiler is outside this issue.

## Acceptance criteria

- [x] The exact program compiles and prints `x1` using the current source compiler.
- [x] Regression tests verify reads through the original binding after writes
      through conditional aliases, including a runtime-selected condition.
- [x] Numeric-only object writes retain correct arithmetic behavior.
- [x] Relevant existing property-widening and alias tests show no new failures
      against the clean baseline (see the pre-existing failure below).

## Implementation and validation

The property-write prepass records writes to each declaration behind a union
receiver. Incompatible primitive writes invalidate the old numeric/string field
type without widening unrelated objects that happen to use the same property
name. Existing field registration selects the dynamic storage carrier.

A shared expression predicate preserves that fact through property reads,
addition, and unannotated initializer aliases. Addition, local/global storage,
identifier reads, inferred function return slots, equality, and console imports
use it to avoid coercing the live value back to the old checker type. Both console
import collection and emission choose the same existing dynamic-value import.
The standalone path uses its existing native addition and output sink.

This is declaration-scoped propagation, not general escape/interprocedural
analysis. Indirect call-result inference and arbitrary reassignment/destructuring
flows are not newly covered.

### Validation

- Clean source baseline `16498efb481cb0`: the exact top-level program prints
  `NaN`; candidate prints `x1` with default JS-host options on Node 24.4.1.
- Candidate standalone compiles the exact program with zero imports and its
  output sink contains `x1\n`.
- Existing suites: `issue-2953-unions-boxing`, `issue-2984-alias-receivers`,
  `union-narrowing`, and `equivalence/empty-object-widening`: 25/26 pass.
  The nested-scope shadow guard in `issue-2984-alias-receivers` returns 3 where
  it expects 1, identically on candidate and clean baseline (6/7 in that suite).
- New regression suites: 12/12 pass on the candidate. On clean baseline,
  the first 11 cases have 8 failures and 3 passing controls; the subsequently
  added same-instance true/false case also fails (`[NaN, 2]` vs `["x1", 2]`).
- Type checking and lint pass. LOC/function budgets pass with the scoped
  integration allowances above; oracle and coercion checks report zero growth.
- `check:dead-exports` exits 0 but reports the same pre-existing open graph on
  clean baseline and candidate: nonliteral dynamic imports in `optimize.ts`
  and `runtime/platform-capability-adapter.ts`. No deletion is certified.
- The coercion gate was invoked through a space-free symlink with Node's
  preserve-symlinks flags so it actually inspected this worktree; its direct
  invocation misreads the URL-encoded space in the checkout path and falls back
  to an unscoped baseline check.
