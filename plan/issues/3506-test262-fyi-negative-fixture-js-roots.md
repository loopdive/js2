---
id: 3506
title: "Test262 FYI negative fixture graphs must retain JavaScript roots"
status: done
sprint: 73
created: 2026-07-20
updated: 2026-07-21
completed: 2026-07-20
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
es_edition: multi
language_feature: module-negative-fixture-graphs
area: test262-runner
goal: test262-conformance
lane: A
related: [2932, 3370, 3473, 3491, 3492, 3497]
files:
  - scripts/test262-worker.mjs
  - src/compiler.ts
  - src/index.ts
  - tests/issue-3506-test262-fyi-negative-fixtures.test.ts
loc-budget-allow:
  - src/compiler.ts
---

# #3506 — Test262 FYI negative fixture graphs must retain JavaScript roots

## Problem

The completed original-FYI GC run at project commit
`422608b2d021fc474b4b5b1b607d71c47d363e1b` found 14 negative module tests
which pass the project/CI Test262 runner but fail in FYI. Each test has a
reachable static `_FIXTURE.js` graph. FYI preserves the real `.js` virtual
paths, then calls `compileMulti` with `allowJs: false` for negative tests.
TypeScript excludes those JavaScript roots from the program and the compiler
crashes while reading `undefined.kind` instead of reporting the test's expected
parse/early/resolution `SyntaxError`.

The affected CI-pass/FYI-fail paths are exactly:

- `language/import/import-defer/syntax/invalid-defer-as-with-no-asterisk.js`
- `language/import/import-defer/syntax/invalid-defer-default-and-namespace.js`
- `language/import/import-defer/syntax/invalid-export-defer-namespace.js`
- `language/module-code/export-expname-from-as-unpaired-surrogate.js`
- `language/module-code/export-expname-from-star-unpaired-surrogate.js`
- `language/module-code/export-expname-from-unpaired-surrogate.js`
- `language/module-code/export-expname-import-unpaired-surrogate.js`
- `language/module-code/import-attributes/allow-nlt-before-with.js`
- `language/module-code/import-attributes/early-dup-attribute-key-export.js`
- `language/module-code/import-attributes/early-dup-attribute-key-import-withbinding.js`
- `language/module-code/import-attributes/import-attribute-key-string-double.js`
- `language/module-code/import-attributes/import-attribute-key-string-single.js`
- `language/module-code/import-attributes/import-attribute-value-string-double.js`
- `language/module-code/import-attributes/import-attribute-value-string-single.js`

## Constraints

- Preserve the literal FYI entry assembly and every literal fixture source.
- Keep the real pinned `.js` virtual paths; do not rename roots to `.ts` or
  rewrite Test262 syntax to make TypeScript accept it.
- Compile every reachable graph member before accepting a verdict.
- Accept only the test's expected static rejection. A missing fixture,
  missing-module diagnostic, thrown compiler exception, invalid Wasm, or
  runtime failure is not evidence that a negative test passed.
- Do not modify Test262, its harness, or its fixture sources.

## Acceptance criteria

- All 14 exact paths pass through FYI GC because the compiler reports the
  expected parse/early/resolution rejection, never `undefined.kind`.
- All 14 pass through FYI standalone where the negative test is applicable;
  static rejection occurs before target runtime policy or instantiation.
- The #3491 missing-static-fixture control remains a hard discovery failure and
  the resolution-negative anti-false-pass control remains green.
- The #3492 missing dynamic parse-negative and omitted-graph false-pass controls
  remain green.
- A focused synthetic graph proves an unrelated thrown compiler exception is
  reported as `compile_error`, not scored as the requested `SyntaxError`.
- Project Test262 and ordinary fixture-free FYI behavior are unchanged.

## Validation plan

- Run `tests/issue-3506-test262-fyi-negative-fixtures.test.ts`.
- Run the focused #3491 and #3492 runner suites.
- Run all 14 exact paths through fresh FYI GC and standalone workers.
- Run typecheck, Prettier, issue-ID, verdict-oracle, oracle-ratchet, hard-error,
  and focused LOC gates.

## Implementation summary

- Added opt-in multi-source JavaScript syntax controls which keep literal `.js`
  roots in the TypeScript program while restoring all-root grammar diagnostics
  and the compiler's ECMAScript early-error pass. Default package-oriented
  `allowJs` behavior is unchanged.
- FYI fixture graphs now always compile with `allowJs: true`. Parse/early
  negatives enable strict grammar and early-error checks without semantic
  analysis. Resolution negatives retain full linked-program diagnostics and
  require the deliberate `ensure-linking-error_FIXTURE.js` TS2459 signal.
- Transported the declared negative phase to the worker so a resolution test
  cannot pass on an unrelated entry diagnostic. Missing module diagnostics and
  thrown graph/compiler failures remain hard failures.
- Added focused coverage which verifies every literal entry and fixture against
  the pinned Test262 checkout, exercises the exact 14 paths in both targets,
  inspects the real parse and resolution diagnostics, and proves a thrown graph
  collision is never accepted as a negative pass.

## Validation evidence

- Pre-fix exact GC reproduction: `import-attribute-key-string-double.js` failed
  with `Cannot read properties of undefined (reading 'kind')`.
- Exact FYI path lists: **14/14 GC** and **14/14 standalone**, all accepted in
  compile phase with `reachedTest: false`.
- Focused Vitest suites: **20/20 pass** across #3506, #3491, and #3492. This
  includes the missing-static-fixture discovery guard, #3491 resolution
  false-pass control, #3492 missing-dynamic parse control, and omitted-graph
  execution control.
- Resolution evidence: all five applicable exact paths carry TS2459 from
  `ensure-linking-error_FIXTURE.js`; none depends on a missing-module message.
- `pnpm run typecheck`, focused Prettier, issue-ID/index, Test262 hard-error,
  oracle-ratchet, and integration-base LOC gates pass.
- Local Node is v24.4.1, so the exact-path CLI samples are explicitly
  non-authoritative runtime smokes. Every affected test terminates during
  compilation, before Node runtime/Unicode behavior; the focused tests assert
  that boundary directly.
