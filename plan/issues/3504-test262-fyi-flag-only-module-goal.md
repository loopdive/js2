---
id: 3504
title: "Test262 FYI worker must preserve flag-only Module goal"
status: done
sprint: 73
created: 2026-07-20
updated: 2026-07-21
completed: 2026-07-20
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: test262-runner
goal: test262-conformance
lane: A
es_edition: es2015
language_feature: module-goal
related: [3419, 3473, 3489]
files:
  - scripts/run-test262-fyi.mjs
  - tests/issue-3504-test262-fyi-module-goal.test.ts
---

# #3504 — Test262 FYI worker must preserve flag-only Module goal

## Problem

The Test262 project runner passes four parse-negative Module tests that the
test262.fyi original-harness GC lane fails on the same pinned Test262 revision:

| Path                                                             | CI oracle v8 | FYI GC at `422608b`                                         |
| ---------------------------------------------------------------- | ------------ | ----------------------------------------------------------- |
| `language/module-code/early-dup-top-function-async-generator.js` | pass         | fail: expected `SyntaxError`, compiled without a diagnostic |
| `language/module-code/early-dup-top-function-async.js`           | pass         | fail: expected `SyntaxError`, compiled without a diagnostic |
| `language/module-code/early-dup-top-function-generator.js`       | pass         | fail: expected `SyntaxError`, compiled without a diagnostic |
| `language/module-code/early-dup-top-function.js`                 | pass         | fail: expected `SyntaxError`, compiled without a diagnostic |

All four sources carry `flags: [module]` but intentionally contain no static
`import`, `export`, or `import.meta` syntax. Their duplicate top-level function
declarations are therefore legal under Script goal and an early `SyntaxError`
only under Module goal.

## Evidence (2026-07-20)

- The authoritative FYI full serial GC result used project commit
  `422608b2d021fc474b4b5b1b607d71c47d363e1b`, Test262 revision
  `63829c6d925e24a3f5f307b08754aaa1c412c6a6`, and the pinned Node 25.9.0 /
  Unicode 17 runtime. Each exact path failed before reaching the test with the
  same missing-early-error signature above.
- The current CI oracle-v8 baseline uses the identical Test262 revision and
  records all four exact paths as `pass`, `reached_test: false`, `strict: both`.
- A historical CI control at a project commit ancestral to `422608b` also
  records all four as passing, excluding a later compiler-only fix as the
  explanation for the mismatch.
- A focused local replay on the integration commit reproduces 0/4 in both GC
  and standalone. This Node 24 replay is non-authoritative for baseline
  comparison but confirms the target-independent IPC defect.
- `scripts/run-test262-fyi.mjs::testWorkerOptions` transports negative phase,
  expected error type, original-harness, and async metadata but omits
  `inferModuleStrictArguments`. The unified worker consequently receives
  `undefined`, while the project runner explicitly sends the Test262
  Module-goal classification.

## Acceptance criteria

- Transport the original reader's `module` flag through `FyiSourceExecutor` to
  the unified worker as an explicit `inferModuleStrictArguments` boolean.
- All four exact paths pass the FYI GC and standalone lanes by observing the
  expected early `SyntaxError`.
- A Script-goal duplicate top-level function remains legal and resolves to the
  last declaration.
- Comments and strings containing `import` or `export` remain Script goal.
- Preserve test262.fyi's literal harness assembly and pinned Test262 sources;
  do not rewrite, delete, or de-duplicate declarations.

## Implementation

`testWorkerOptions` now maps test262.fyi's parsed `flags.module` bit to an
explicit `inferModuleStrictArguments` boolean in every unified-worker request.
The existing `runSource` spread transports that option unchanged for both
single-source and fixture-graph execution and for both GC and standalone.

The change does not inspect source text or paths. Unflagged records therefore
receive explicit Script goal even when comments or string literals mention
module keywords, while flagged records select Module goal without needing
static module syntax. No Test262, test262.fyi reader, runtime shim, or harness
source changed.

## Validation results (2026-07-20)

- Focused #3504 regression: **5/5 pass**, covering all four exact records in
  both GC and standalone plus dual-target Script last-wins and comment/string
  controls.
- Related FYI runner, #3489 classifier, and #3419 duplicate-declaration suites:
  **32/32 pass**.
- Exact FYI CLI replay: **4/4 GC** and **4/4 standalone** pass on the integration
  commit, each as a parse-negative verdict before reaching test execution. The
  local Node 24 run used the explicit non-authoritative smoke switch; the
  source, harness assembly, worker, targets, and negative classifier are the
  production paths.
- `pnpm run typecheck`: pass.
- Prettier check on all changed files: pass.
- Issue-ID, issue-index, issue/spec-coverage, verdict-oracle, and Test262
  hard-error gates: pass. The oracle gate recognizes the already integrated
  oracle-v9 bump; #3504 changes transport metadata without changing verdict
  classification logic.
