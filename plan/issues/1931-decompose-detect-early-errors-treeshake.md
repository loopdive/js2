---
id: 1931
title: "Decompose detectEarlyErrors (3,350-line function) and run it on every path; wire or delete the dead treeshake option"
status: done
completed: 2026-06-17
assignee: ttraenkler/cs-1931
sprint: 63
created: 2026-06-10
updated: 2026-06-17
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: conformance
---
# #1931 — Decompose detectEarlyErrors; wire or delete treeshake

## Problem

- `detectEarlyErrors` (`src/compiler/validation.ts:171-3527`) is a **single
  ~3,350-line function** containing 55+ nested closures reimplementing
  ECMA-262 early errors (strict-mode rules, TDZ, duplicate lexical
  declarations, labels, assignment targets, private names…). The purpose is
  right — TS doesn't enforce ES early errors and test262 `negative.phase:
  parse` demands them — but nested closures are individually untestable, and
  per-node dispatch is one giant `visit` re-checking dozens of patterns.
- It runs **only on the single-source path** — `compileMultiSource` /
  `compileFilesSource` skip ES early errors entirely.
- Stale comment at `validation.ts:215-217` claims "we add export {}
  synthetically" — no code does.
- Separately: the public `CompileOptions.treeshake` (`src/index.ts:194`) is
  **dead code** — never read by any compile path; `treeshake()` is only
  re-exported (`index.ts:443`). A documented option that does nothing.

## Proposed approach

1. Split into per-concern rule modules under `src/compiler/early-errors/`
   (`strict-mode.ts`, `tdz.ts`, `duplicates.ts`, `labels.ts`,
   `assignment-targets.ts`, `private-names.ts`, …) sharing **one** AST walk
   via a rule registry; each rule unit-testable with small fixtures.
2. Call from the unified pipeline driver (#1927) so all entry points get ES
   early errors; until #1927 lands, add the call to both multi paths.
3. Delete the stale comment; keep behavior identical (test262 parse-negative
   results must not regress — that's the acceptance oracle).
4. `treeshake`: either invoke `treeshake()` when the option is set (with a
   test showing a dropped unused export) or remove the option from the
   public API and docs. Decide with the PO; the review recommends wiring it,
   since the implementation exists.

## Acceptance criteria

- No function in validation.ts exceeds ~300 lines; rules have direct unit
  tests.
- Multi-source compile rejects a duplicate-`let` early error (test).
- test262 parse-negative bucket unchanged or improved.
- `treeshake` option either functional (test) or gone.

## Source

Compiler quality review 2026-06. Related: #1927.

## Resolution (2026-06-17)

Decomposed `detectEarlyErrors` into per-concern modules under
`src/compiler/early-errors/`, sharing one AST walk via an `EarlyErrorContext`:

- `context.ts` — `EarlyErrorContext` (sourceFile, errors, pos, addError) + factory.
- `predicates.ts` — 34 pure, stateless predicate/collection helpers (strict-mode,
  assignment-target, inside-iteration/function, binding-name collection, …),
  each individually unit-testable.
- `assignment.ts` — AssignmentPattern validators.
- `duplicates.ts` — duplicate params/lexical/private-name/switch-case rules.
- `labels.ts` — duplicate-label rules.
- `tdz.ts` — temporal-dead-zone reference checks.
- `node-checks.ts` — the per-node dispatch (the former `visit` walk).
- `module-rules.ts` — export-default, duplicate-export-names, module-item
  position, reserved yield/await, HTML close comments, duplicate constructors.
- `index.ts` — thin orchestrator (the new `detectEarlyErrors`).

`validation.ts` shrank from 3,647 → 283 lines; the largest remaining function
there is `validateSafeMode` (117 lines). `detectEarlyErrors` is re-exported from
`validation.ts` so existing import sites are unchanged.

**Behaviour-preserving**: a 447-case oracle (snippets covering each rule + 400
test262 `negative.phase: parse` files) produces byte-identical output before and
after the refactor.

**Run on every path**: `compileMultiSource` and `compileFilesSource` now run
`detectEarlyErrors` on every user source file (skipping allowJs deps), so a
duplicate-`let` is rejected in multi-file compiles too (was previously skipped).
The single-source `compile()` path used by test262 is unchanged.

**treeshake**: the dead `CompileOptions.treeshake` flag (never read by any
compile path) was removed. The standalone `treeshake()` helper stays exported
and is still exercised by `tests/resolve.test.ts`.

Also fixed the stale `isStrictMode` doc comment that claimed modules are treated
as strict ("we add export {} so all are modules") — they are not.

Tests: `tests/issue-1931.test.ts` — 20 unit/integration tests covering
predicates, rule modules, full `detectEarlyErrors`, and the multi-source
duplicate-`let` rejection.
