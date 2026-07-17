---
id: 1315
title: "import.defer / import.source missing early error detection — 157 negative tests false-pass"
horizon: m
status: ready
created: 2026-05-07
updated: 2026-06-19
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: modules, import-defer, import-source
goal: spec-completeness
sprint: current
---
# #1315 — `import.defer` / `import.source` early error detection gap (157 negative tests)

## Problem

157 tests with `negative: { phase: parse/early, type: SyntaxError }` are passing through the compiler and instantiating successfully. They should be rejected at parse/early-error time with `SyntaxError`.

Sample failing tests (all import.defer/import.source related):
```
test/language/expressions/dynamic-import/syntax/valid/nested-async-arrow-function-await-import-defer-assignment-expr-not-optional.js
test/language/expressions/dynamic-import/syntax/valid/nested-async-arrow-function-return-await-import-defer-no-rest-param.js
test/language/expressions/dynamic-import/catch/nested-async-gen-await-import-defer-specifier-tostring-abrupt-rejects.js
```

Additionally, 27 tests produce `Internal error compiling expression: Debug Failure. False expression: Trying to get the type of import.defer in import.defer(...)` — the compiler crashes instead of producing a clean unsupported-feature error.

## Root cause

Two gaps:

1. **Early error detection**: `import.defer(...)` and `import.source(...)` are Stage 3 proposals. In contexts where they are syntactically invalid (e.g. `await import.defer(...)` in certain positions), the compiler should raise a `SyntaxError` at parse/early-error time. Currently these constructs are not recognized and pass through without the required early error check.

2. **Compiler crash on `import.defer` type resolution**: TypeScript's checker throws `Debug Failure` when asked for the type of `import.defer(...)` — the compiler doesn't handle this node type and crashes with an internal error instead of a clean "unsupported feature" message.

## Fix approach

1. In `detectEarlyErrors()` (or equivalent early-error pass): recognize `import.defer` / `import.source` call expressions and emit `SyntaxError` in the restricted contexts per the Stage 3 spec.

2. In the codegen expression handler: add a case for `import.defer` / `import.source` AST nodes that emits a clean "unsupported feature: import.defer" compile error (matching the `unsupported_feature` pattern) rather than crashing with a Debug Failure.

## Acceptance criteria

- The 27 `Debug Failure` compile errors disappear — replaced by a clean "unsupported feature" error.
- The 157 negative-test false-passes flip to `pass` (compiler raises SyntaxError at the right phase).
- No regressions in module tests.

## Refreshed standalone evidence - 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The standalone root-cause classifier assigns **153** rows primarily to the
`import.defer` / `import.source` syntax and early-error family. This is
effectively the same size as the original 157 negative-test false-pass report,
but in the standalone artifact it is mixed with proposal syntax compile errors
and module-loader/runtime diagnostics. The root cause remains the same:
recognize the proposal forms in early-error detection and produce deliberate
syntax/unsupported-feature diagnostics instead of falling through into generic
codegen or runtime behavior.

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).
