---
id: 3492
title: "Test262 runners must not false-pass omitted fixture module graphs"
status: done
sprint: 73
completed: 2026-07-20
created: 2026-07-20
updated: 2026-07-21
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: test262-runner
goal: test262-conformance
lane: A
related: [2932, 3362, 3473, 3490, 3491, 3493, 3494]
files:
  - scripts/test262-fixture-graph.mjs
  - scripts/run-test262-fyi.mjs
  - scripts/test262-fyi-reader.mjs
  - scripts/test262-worker.mjs
  - tests/test262-shared.ts
  - tests/test262-vitest.test.ts
  - tests/test262-oracle-version.ts
  - tests/issue-3492-test262-fyi-top-level-await-parity.test.ts
---

# #3492 — Test262 runners must not false-pass omitted fixture module graphs

## Problem

The integrated FYI runner closes the complete 970-path host gap, but an
authoritative Node 25 rerun of the historical 3,472-path standalone gap reports
two failures which the project runner calls passes. Both are official
top-level-await module-graph tests:

```text
language/module-code/top-level-await/module-graphs-does-not-hang.js
language/module-code/top-level-await/pending-async-dep-from-cycle.js
```

The pass gap is not a FYI-harness regression. The project runner's local
`resolveFixtures` regex recognizes only `import ... from` declarations. Both
tests use bare side-effect imports, so the project runner silently compiles the
entry without its fixture graph and then stamps `reached_test: true`. The FYI
lane links the static graph and exposes two real compiler gaps instead. The
runners must share one graph oracle and agree on the honest failures; neither
may drop dependencies or manufacture completion.

## Evidence (2026-07-20)

- Exact authoritative FYI host gap: **970/970 pass** on Node 25.9.0.
- Exact authoritative FYI standalone gap: **3,470/3,472 pass**.
- `module-graphs-does-not-hang.js`: runtime failure,
  `async completion marker not observed` before explicit classification.
- `pending-async-dep-from-cycle.js`: runtime failure,
  `illegal cast [in __module_init()]`.
- The project runner reports **2/2 pass**, but its fixture regex returns an
  empty list for both entries. Those passes do not exercise the dependencies.
- `module-graphs-does-not-hang.js` contains a literal dynamic fixture import.
  The standalone backend documents dynamic import as host-only and cannot run
  it yet (#3494). Promoting it to an eager static edge would change semantics.
- `pending-async-dep-from-cycle.js` reduces to the standalone compiler failure
  `globalThis.logs = []; globalThis.logs.push(...)`, independent of the cycle:
  direct global property re-read traps with `illegal cast` while a local alias
  succeeds (#3493).

## Acceptance criteria

- Both runners use one recursive fixture discovery implementation which
  recognizes bare imports, binding imports/exports, and transitive cycles.
- Literal dynamic fixture imports are inventoried separately and fail
  explicitly in standalone until #3494 lands; they are never rewritten into
  eager static imports.
- The exact two paths produce the same honest failures in both runners under
  Node 25, with `reached_test: false`.
- Do not weaken Test262 source, metadata, fixtures, or expected verdicts.
- The corrected standalone comparison is **3,470/3,472 in both runners**.
- Add controls proving bare-import fixture side effects execute before a pass
  can be recorded and omitted graphs cannot set `reached_test: true`.
- Bump the honest oracle version because two project rows intentionally change
  from false pass to honest failure.

## Validation

- Run `tests/issue-3492-test262-fyi-top-level-await-parity.test.ts`.
- Run both exact paths through both standalone runners with Node 25 and fresh
  workers; require matching failures and `reached_test: false`.
- Rerun `/private/tmp/fyi-standalone-gap-3472.paths`; require 3,470/3,472 with
  only #3493 and #3494 remaining.
- Run issue-ID, oracle-version, typecheck, format, and focused runner gates.

## Implementation summary

- Extracted one fixture-graph oracle shared by the project and FYI runners. It
  recognizes bare side-effect imports, binding imports/exports, transitive
  cycles, and literal dynamic fixture imports without reading comments or
  template examples as dependencies.
- Kept dynamic fixtures separate from the eager static graph. Standalone now
  reports the real unsupported-loader boundary with `reached_test: false`
  instead of dropping the dependency or rewriting its semantics.
- Replaced both project-runner regex copies with the shared recursive graph and
  transported the same rooted virtual files used by the FYI worker.
- Exposed the worker's real `reachedTest` bit in FYI reports and bumped the
  honest oracle from v8 to v9 because the two false project passes are now
  intentional failures.
- Verified under Node 25 that both exact paths now agree across runners:
  dynamic fixture import is an explicit #3494 compile error; the static pending
  cycle reaches the #3493 `illegal cast` compiler failure.
- Tried entry-first versus entry-last virtual file insertion and reduced the
  cycle to equivalent single-source probes. File insertion order did not affect
  the trap; the minimal direct `globalThis` property re-read proved this is a
  compiler representation bug, not a harness scheduling defect.
- Focused graph/worker suites, TypeScript, Prettier, issue-ID, oracle-version,
  oracle-ratchet, hard-error, and LOC gates pass. The exact historical
  3,472-path FYI standalone rerun passes 3,470 tests and reports only the two
  honest #3493/#3494 failures above.
