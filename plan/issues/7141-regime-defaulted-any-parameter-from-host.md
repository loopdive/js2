---
id: 7141
title: "Regime gap: an exported `f(value: any = \"A\")` called from JavaScript with no argument ignores the default"
status: ready
created: 2026-10-25
updated: 2026-10-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: default-parameters
goal: architecture
sprint: current
parent: 5385
related: [6979, 3521, 7095]
---

# #7141 — default parameter of an `any`-typed export parameter at the boundary

Found by the S7-a landing (2026-10-25) while re-pinning
`tests/issue-3521-prepared-free-function-routing.test.ts`. On the native
regime in a JavaScript environment, an export `lateDirect(value: any = "A")`
called from the host with no argument returns as if `value` were `undefined`
(`false` where Node gives the result for `"A"`). Either the export wrapper
passes an explicit `undefined`/null carrier that the module's default-
parameter check does not recognise as "missing", or the carrier arrives as a
non-undefined box. Marked `it.fails` on the S7-a PR; fails identically on
main's default profile.

## Plan

1. Measure: a `.tmp` probe under native-first via `wrapCompiledExports`
   for `any`, `string`, `number` and `boolean` parameters with defaults,
   called with no argument, with `undefined`, and with a value; the same for
   a second defaulted parameter; against Node. Record what the module sees
   (`__is_undefined` on the carrier) and what `wrapExports` passes.
2. Fix at the identified site: the export wrapper passes the module's
   undefined sentinel for missing arguments, or the default-parameter check
   treats the host's `undefined` carrier as missing (shared runtime/boundary
   code; no new direct-AST body semantics).
3. Tests: turn the `it.fails` row back into a normal row; add the matrix.
4. Acceptance: equivalence gate "No new equivalence regressions"; binaries
   for programs without defaulted export parameters byte-identical.
