---
id: 4640
title: "ES5 standalone: statements/expressions smalls round 3 — undefined()/null() TypeError identity, named-funcexpr scope, nested-loop labels, object-literal getters, boxed-primitive receivers (~52 rows)"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: misc
goal: standalone-gap
related: [4621, 4620, 4519, 4484]
loc-budget-allow:
  # D7 — `Date(...)` without `new` (§21.4.2.1). The `new`-form arms for every
  # builtin global live in this module and the without-`new` arm has to sit
  # beside `tryCompileErrorCtorCallWithoutNew`, which is the only other
  # called-as-a-function ctor arm; splitting one of a pair into a new leaf is
  # how the two drift. Most of the +82 is the header explaining why this is a
  # CRASH fix (illegal cast in `__date_parse`) rather than a cosmetic one.
  - src/codegen/expressions/new-builtin-globals.ts
  # D3 — the sloppy-implicit-global compound-assignment arm. The lowering lives
  # in the leaf `implicit-global-binding.ts`; what lands here is the dispatch
  # arm plus the comment recording WHY it must precede the string-concat lane
  # (that lane's local carrier is exactly what swallowed the appends).
  - src/codegen/expressions/operator-assignment.ts
  # D1 — the nullish-callee dispatch arm. The helper lives in
  # `stored-member-closure-call.ts` (the documented home of the graceful
  # `undefined` fallback this narrows); the +13 here is the call plus the
  # pointer to why the STATIC guard cannot answer it.
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  # Both are ONE dispatch arm plus its rationale comment, placed at the exact
  # point in an existing ladder where the decision has to be made — the
  # lowerings themselves live in leaf modules
  # (`implicit-global-binding.ts`, `stored-member-closure-call.ts`).
  - src/codegen/expressions/operator-assignment.ts::compileCompoundAssignment
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
origin: "2026-08-23 wave-3 residual map (196 true failures). Lane D (.tmp/lane-D-smalls.txt) + try/return/Date leftovers."
---

# #4640 — statements/expressions smalls round 3

## Problem (measured 2026-08-23 on branch tree) — bounded families

- **D1 — calling an undefined/null VALUE throws a real TypeError (~5)**:
  `var x = undefined; x()` — currently the thrown thing is
  `[object Object]` not `instanceof TypeError` (S11.2.3_A3_T4/T5), and
  `11.2.3-3_3/4`: argument evaluation ORDER — §13.3.6.1 evaluates the
  callee ref, then arguments, THEN throws on non-callable — `fooCalled`
  must be true. #4519's guard covered member GETs; this is the call-value
  twin.
- **D2 — named function EXPRESSION scope (~4)**: `S11.13.1_A6_T1/T2` —
  the funcexpr's own NAME binding must not leak/shadow the outer
  assignment target (`innerX`); `S13.2.2_A19_T8` twin in lane A.
  `8.12.5-3-b_1` — native-code render mismatch in descriptor get/set
  toString (cosmetic render, check against #4637-A4's render).
- **D3 — nested-loop deep var resolution (~3)**:
  `for/S12.6.3_A10_T1/A10.1_T1` — `index6/index8 is not defined` in
  6/8-deep nested loops writing through `eval`-free label bodies; and the
  for-head completion-value row. Smells like a per-depth local-allocation
  cap or shadow-name suffixing bug — reduce depth to find the cliff.
- **D4 — object-literal ACCESSORS at module scope (~3)**:
  `11.1.5-0-1/2` — a get accessor defined in an object literal answers
  null instead of running (module-init getter installation order);
  `S11.1.5_A2` — a wrapper-object property value loses identity.
- **D5 — boxed-primitive receiver own-property writes (~6)**:
  `(5).x = 5; (5).x` family (10.4.3-1-104/106) — sloppy-mode ToObject
  receiver semantics: write succeeds on the temp wrapper, read of the
  temp answers undefined BUT `(5).x === 5` in the SAME expression per
  test expectation — re-read the rows precisely; `typeof (5).x`; strict
  twins throw. #4620 family C named the boxed-receiver accessor path.
- **D6 — with/try/typeof/instanceof smalls (~10)**: with-scope writes
  (S12.10_A5_T5 array-valued twin), `try` catch-param property rows,
  `S12.14_A18_T6` valueOf-object identity across throw (#4621-H pinned),
  instanceof shifted-expression rows, `typeof` on `new`-ed results.
- **D7 — misc singles (~10)**: `S12.9_A5` (return without expression →
  undefined not 0), annexB catch-redeclared-var, comments compile rows,
  directive-prologue pair, identifier-resolution pair, Error pair,
  `Date/S15.9.2.1_A2` illegal cast in `__date_parse` (CRASH class —
  FIRST), JSON/Math singles, `function-code` S10.2.1 rows.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   every family live; D7's Date illegal-cast crash FIRST.
2. D1: emit a constructed TypeError instance (the #1380 pattern in
   identifiers.ts L1574 area does this for ReferenceError — mirror it at
   the call-value null/undefined guard), and move the throw AFTER
   argument evaluation per §13.3.6.1.
3. D2: the funcexpr name binding is an inner immutable binding — check
   how compileLiftedClosureBody scopes `arrow.name` and stop it aliasing
   the outer local.
4. D3: reduce depth-by-depth; find where deep nesting drops a
   declaration.
5. D4/D5/D6: per-row triage with WAT decode; decline
   representation-walled rows with named owners (#4638 vec/holes,
   #4637 fnctor edge, value-rep to-primitive carrier).
6. Verify: per-family scoped runs before/after (own runs); pins
   4621/4620/4519/4484 green; pins tests/issue-4640.test.ts; ≥25 of ~52
   flip OR every non-flipped row declined with a named owner; zero
   regressions.
