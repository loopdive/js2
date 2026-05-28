---
id: 1527
title: "module-code: ambiguous-export & re-export tests fail with 'no test export'"
status: done
created: 2026-05-20
updated: 2026-05-28
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: modules, export-bindings, re-exports
sprint: Backlog
es_edition: ES2015+
test262_category: language/module-code
test262_count: 54
related: [1357]
---
# #1527 — Module-mode tests collapse with `no test export`

## Problem

54 test262 module tests fail at compile time with:

```
no test export
ConformanceError: [compile_error] no test export
```

The runner expects every compiled test module to provide a `test`
export it can invoke. These modules either:

1. *Should* expose `test` but the compiler drops it due to a
   re-export / ambiguous-binding edge case, or
2. Use `export *` / `export ... from` chains the linker doesn't
   resolve, or
3. Are deliberately negative (early errors) that the runner should
   classify as `SyntaxError` expected, not "no test export".

## Failing test examples

- `test/language/module-code/ambiguous-export-bindings/error-import-named-as.js`
- `test/language/module-code/export-expname-from-unpaired-surrogate.js`
- `test/language/module-code/import-attributes/import-attribute-trlng-comma.js`

## Approach

1. Inspect 5 sample tests' source — how do they expose `test`? Many
   use `export { test } from './module.js'`.
2. Walk our module linker to see why the re-export name is lost.
3. For negative-test cases (expected-SyntaxError), let the runner
   classify "no test export" as a fail only when the test is
   positive — for `negative.phase: parse` cases this is actually a
   correct outcome and should be a *pass*.

## Acceptance criteria

- Either the affected tests expose `test` correctly post-link, or
- The runner reports negative `parse`/`early` tests as pass when the
  module fails to compile with a `SyntaxError`-shaped error.
- At least 30 of the 54 cluster tests flip from CE → pass.

## Estimated impact

**54 test262 tests**, plus this is a foundation issue for the broader
module-system audit.
