---
id: 7306
title: "IR: localIsRewritten matches written names by text across the file — resolve the write through the checker"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7283, 7106]
---

# IR: `localIsRewritten` matches written names by text

## Problem

`localIsRewritten` (`src/ir/lattice-param-facts.ts`) collects every name
written anywhere in the declaration's scope, nested functions included, and
compares by **text**. Since #7283 the selector's local call graph uses it for
function declarations. A function whose binding is rewritten counts as
external, so its callers refuse with `external-call` before the claim.

Matching by text also counts a write to an unrelated **shadowing** local of
the same name, in another function, as a rewrite of the top-level function.
That callee's callers then go legacy, although base claimed and compiled
them correctly.

Repro (#7151 review round 3; real harness, sloppy and strict, gc,
standalone and wasi):

```js
function isTrue(x) { return x === true; }
function c(x) { return isTrue(x) ? 1 : 0; }
function g() { var isTrue = 0; isTrue = 1; return isTrue; } // unrelated LOCAL write
```

- Before #7283: `ir=[isTrue, c, g]`, pass.
- After #7283: `ir=[isTrue, g]`. `c` is legacy, because `g`'s write to its
  own local marks the top-level `isTrue` as rewritten.

Correctness is unaffected (legacy passes). It breaks "no newly legacy unit
that compiled on base". Impact on test262 is zero: the reviewer scanned all
53,575 test files plus the harness top-level function names and found none
that writes a top-level function's name only through a shadowing local,
parameter or catch binding. Playground and user code can hit it.

The variable path (#7106) shares the same over-approximation, which is
conservative and documented.

## Fix

Resolve each written identifier through the checker or the oracle. The
write counts only when the identifier's value declaration is `declaration`
itself (`localValueDeclaration(write) === declaration`). That applies to both
the `FunctionDeclaration` and the `VariableDeclaration` case.

Keep the nested-function reach: a closure that rewrites the outer binding
must still count.

## Acceptance criteria

- The repro claims `c` again, on all three lanes.
- A real rewrite (`isTrue = function(){…}`, at top level or in a nested
  function) still makes callers refuse before the claim. The #7283 test rows
  keep passing.
- Code quality: one write-resolution helper in `lattice-param-facts.ts`,
  shared by both declaration kinds. No second walker.
