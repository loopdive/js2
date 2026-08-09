---
id: 3503
title: "Test262 dynamic fixture discovery must not abort the corpus"
status: done
sprint: 73
completed: 2026-07-20
created: 2026-07-20
updated: 2026-07-21
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: test262-runner
goal: test262-conformance
lane: A
related: [3492, 3494]
files:
  - scripts/test262-fixture-graph.mjs
  - scripts/test262-worker.mjs
  - tests/test262-shared.ts
  - tests/issue-3492-test262-fyi-top-level-await-parity.test.ts
  - tests/test262-oracle-version.ts
---

# #3503 — Test262 dynamic fixture discovery must not abort the corpus

## Problem

The first complete FYI corpus run after #3492 stopped before executing any
tests. A parse-negative dynamic-import test names `./empty_FIXTURE.js`, but the
pinned Test262 directory intentionally has no such file: parsing must throw
before the import can be evaluated. Eager fixture discovery treated that
runtime-only edge like a required static module and aborted all selected tests.

## Acceptance criteria

- Missing static fixture imports remain hard discovery errors.
- Literal dynamic fixture imports are inventoried without requiring their
  target to exist during discovery.
- Parse/early/resolution-negative tests reach compiler diagnostics before the
  standalone dynamic-loader policy is applied.
- Executable standalone dynamic fixture imports remain explicit #3494
  per-test failures; no test source, metadata, or fixture is modified.
- A complete FYI GC run can start and, after it exits, the complete standalone
  run starts with one worker.

## Validation

- Run the focused #3491/#3492 fixture graph tests.
- Run the exact parse-negative reproducer through FYI GC and standalone.
- Run typecheck, formatting, issue-ID, and oracle-version gates.
- Run the complete FYI corpus serially in GC and standalone lanes.

## Implementation summary

- Dynamic fixture inventory now retains missing runtime-only edges as `null`
  entries instead of resolving them as required static files.
- Static fixture discovery remains strict and continues to reject missing
  modules immediately.
- Standalone's #3494 policy now applies only to executable tests. Compile-time
  negative tests reach the compiler first and are scored against their declared
  error type and phase.
- The exact reproducer passes in the compile phase in both GC and standalone,
  with `reachedTest: false`.
- The focused fixture suites pass 15/15, and the complete original reader now
  discovers all 52,995 FYI records without aborting. Typecheck, formatting,
  issue-ID, oracle-version, and oracle-ratchet gates pass.
