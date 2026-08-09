---
id: 3509
title: "Standalone deferred dynamic import must trap only when invoked"
status: done
sprint: 73
created: 2026-07-21
updated: 2026-07-21
completed: 2026-07-21
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
es_edition: es2020
language_feature: dynamic-import
task_type: bug
area: compiler
goal: test262-conformance
lane: A
related: [3494]
files:
  - src/compiler.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - scripts/test262-worker.mjs
  - tests/test262-shared.ts
  - tests/issue-3509.test.ts
  - tests/issue-3492-test262-fyi-top-level-await-parity.test.ts
loc-budget-allow:
  - src/compiler.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls.ts
---

# #3509 — Standalone deferred dynamic import runtime trap

## Problem

Standalone capability validation and the Test262 runners currently report a
fatal diagnostic for every `import()` expression / dynamic fixture graph. That
blanket refusal is too early for a dynamic import nested in an ordinary arrow
or function expression that is never called: the program needs no loader and
must be able to finish normally. It also makes syntax-validity tests fail before
their exported test entry is reached.

The honest bounded behavior is to compile an ordinary deferred function body
without `env.__dynamic_import`, then throw a native in-module `TypeError` only
if execution reaches the unsupported import. This does not manufacture a
module namespace or a fulfilled Promise. Executable module loading remains the
module-record work tracked by #3494.

## Evidence (2026-07-21)

The completed standalone CI-pass/FYI-fail comparison at
`/private/tmp/fyi-full-serial-422608b-standalone-ci-pass-fyi-fail.md` identifies
eight official Test262 rows with the same unsupported-runtime signature. All
eight declare an ordinary nested arrow containing a literal dynamic import and
never invoke it. They are the four suffix variants under each of these two
generated template groups:

- `nested-arrow-`
- `nested-arrow-assignment-expression-`

The four suffixes, for **8 total rows**, are:

- `import-attributes-trailing-comma-first.js`
- `import-attributes-trailing-comma-second.js`
- `nested-imports.js`
- `script-code-valid.js`

`src/compiler.ts`, `src/codegen/expressions/calls.ts`, and the Test262 runner
previously rejected the syntax or graph before distinguishing an eager import
from a lifted closure body that cannot execute during module initialization.

The comparison also contains 20 other syntax-valid dynamic-import rows outside
this bounded group: async-arrow and `with` forms execute through different
lowering/evaluation paths in the FYI harness. They remain honest failures, as
does `language/module-code/top-level-await/module-graphs-does-not-hang.js` under
#3494; none may acquire a host loader or a fake successful import.

## Acceptance criteria

- All eight official uncalled-arrow rows described above compile and reach the
  exported test entry under standalone.
- Neither the eight deferred cases nor their runtime-trap lowering imports
  `env.__dynamic_import`.
- Invoking an equivalent ordinary function containing `import()` fails
  deterministically at runtime with the in-module unsupported-import error; no
  module is loaded and no false Promise/namespace success is returned.
- Representative executed async-IIFE and `with` cases remain failures, and the
  top-level-await module graph remains the explicit #3494 failure.
- The default JS-host target preserves its existing `env.__dynamic_import`
  lowering.
- No Test262 source, project runner, or FYI harness rewrite is used.

## Validation

- `tests/issue-3509.test.ts` covers the 2 × 4 official deferred shapes, nested
  imports, deterministic invocation failure, executed async-IIFE, executed
  `with`, the #3494 TLA module graph, and unchanged host lowering.
- Run focused #3509 and #3494 tests, TypeScript typecheck, Prettier check,
  issue/spec coverage, Test262 hard-error, and IR-fallback gates.

## Implementation

- Capability validation exempts only ordinary arrow/function-expression
  bodies; async, generator, named-declaration, `with`, and top-level imports
  retain the #3494 compile failure.
- Lifted ordinary closures and inlined ordinary IIFEs carry an explicit
  FunctionContext marker. Their standalone `import()` evaluates arguments in
  order, then throws an in-module `TypeError`; it never registers
  `env.__dynamic_import` or synthesizes a Promise/namespace result.
- Both Test262 lanes now let compiler capability validation decide whether the
  recorded dynamic fixture is eager. Dynamic fixtures remain separate metadata
  and are never promoted to static `compileMulti` edges.
- Host codegen retains the existing `env.__dynamic_import` lowering.

## Test results (2026-07-21)

- Focused Vitest: **21 passed**, **1 existing #3494 todo** across
  `tests/issue-3509.test.ts` and
  `tests/issue-3494-standalone-literal-dynamic-import.test.ts`.
- Runner parity control: `tests/issue-3492-test262-fyi-top-level-await-parity.test.ts`
  passes with eager dynamic graph rejection still attributed to #3494.
- Authoritative original FYI harness, Node **v25.9.0**, Unicode **17.0**, one
  worker, standalone: exact #3509 set **8/8 passed**, **8/8 reached the test**,
  **0 failed**.
- Project Vitest Test262 runner, `TEST262_TARGET=standalone`,
  `TEST262_WORKERS=1`, exact `TEST262_PATH_FILTER`: **8/8 passed**, **0 failed**,
  **0 compile errors**, **0 skipped**.
- Authoritative #3494 control set: the 20 async-arrow/`with` rows plus the TLA
  module graph remain **0/21 passed**, all with the explicit unsupported dynamic
  import diagnostic.
- `pnpm run typecheck`: pass.
- `pnpm run format:check`: pass.
- Issue index, issue/spec coverage, issue-ID, Test262 hard-error, and IR fallback
  gates: pass (IR unintended fallback delta **0**).
