---
id: 4585
title: "Restore npm compatibility refresh publication"
status: in-progress
created: 2026-08-21
updated: 2026-08-21
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, npm-compat, dogfood
goal: correctness
sprint: current
depends_on: [4577, 4578]
assignee: ttraenkler/codex
horizon: s
related: [3781, 3958, 3982, 4130]
origin: "The live npm dashboard retained its pre-#4578 Acorn/clsx snapshot because both post-fix aggregate refreshes aborted before publication."
files:
  - src/codegen/ambient-parse-import.ts
  - src/codegen/extern-declarations.ts
  - tests/dogfood/react-dom-upstream-suite.mjs
  - tests/dogfood/react-dom-upstream-suite.test.ts
  - tests/issue-4585-npm-compat-refresh-resilience.test.ts
  - plan/issues/4585-npm-compat-refresh-resilience.md
---

# #4585 — restore npm compatibility refresh publication

## Problem

The public npm compatibility page still shows the Acorn and clsx regression
that #4578 fixed. The page itself is current, but its committed aggregate is
from before the fix because two later refreshes aborted before writing their
artifacts:

- Acorn projected the same ambient `env.parseInt` slot twice when legacy and
  prepared IR consumers shared the global.
- ReactDOM's production oracle admitted upstream tests which call the
  development-only `React.captureOwnerStack` API; a late callback threw outside
  the awaited test body and terminated the aggregate process.

## Scope

- Preserve the compiler's exact ambient `parseInt`/`parseFloat` import identity
  when the TypeScript library declaration is registered.
- Keep duplicate serialized adapter bindings fail-closed; do not weaken the
  runtime manifest validator.
- Reject exact `React.captureOwnerStack()` call sites before a production
  ReactDOM run, report the reason, and retain them in development runs.
- Regenerate and publish the complete npm compatibility aggregate only after
  every package finishes and the fixed Acorn/clsx measurements are present.

## Acceptance criteria

- [x] The Acorn parse shape emits one physical and one projected
      `env.parseInt` binding, builds `importObject`, instantiates, and executes.
- [x] A caller-mutated manifest containing a duplicate binding remains rejected.
- [x] Production ReactDOM filtering is AST-based, ignores text-only near misses,
      records an explicit reason, and leaves the development corpus unchanged.
- [x] The pinned Acorn dogfood suite completes without the adapter-manifest
      exception.
- [ ] A fresh aggregate refresh completes and the live page serves a post-#4578
      timestamp and corrected Acorn/clsx measurements.

## Non-goals

- Hiding a regression by changing benchmark baselines or historic result rows.
- Treating development React artifacts as the production npm package.
- Weakening manifest ownership or duplicate-import validation.

## Checkpoint evidence

- Syntactic and checker lib scanners both emit exactly one physical and one
  projected `env.parseInt` binding for the reduced Acorn shape; it instantiates
  and returns `30`. The forged duplicate remains rejected.
- The pinned Acorn suite completes with `3494/3518` passing and no manifest
  exception.
- The pinned ReactDOM corpus records `78` production-incompatible call sites:
  `1923` admitted + `80` rejected = all `2003` upstream tests. Development
  retains all `2001` non-skipped tests.
- Focused parse/standalone tests pass `16/16`; ReactDOM infrastructure passes
  `5/5` with its heavy suite deliberately skipped. Typecheck, formatting, lint,
  LOC/function/oracle/dead-export, IR-fallback, and issue gates pass.
