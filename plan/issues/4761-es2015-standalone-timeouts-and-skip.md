---
id: 4761
title: "ES2015 standalone Test262 compile timeouts and compiler-hang skip"
status: in_progress
created: 2026-08-26
updated: 2026-08-26
priority: critical
horizon: s
feasibility: medium
reasoning_effort: max
task_type: conformance
area: typedarray, control-flow, test262
es_edition: es2015
goal: test262-conformance
parent: 4753
assignee: ttraenkler/codex-es6-closeout
files:
  - src
  - scripts
  - tests
  - plan/issues/4761-es2015-standalone-timeouts-and-skip.md
---

# #4761 — ES2015 standalone Test262 timeouts and skip

## Problem

The complete standalone run `20260826-194014` at exact code head `0bed210fd`
contains two compile timeouts and one compiler-hang skip in the 11,704-row
ES2015 bucket:

- `test/built-ins/TypedArray/prototype/byteOffset/detached-buffer.js` —
  `compile_timeout`, 10 seconds.
- `test/built-ins/TypedArray/prototype/Symbol.toStringTag/detached-buffer.js` —
  `compile_timeout`, 10 seconds.
- `test/language/statements/for-of/body-put-error.js` — `skip`, listed as a
  compiler hang.

The authoritative JSONL is
`/private/tmp/js2-es6-authoritative-measure4/benchmarks/results/test262-standalone-results-20260826-194014.jsonl`.
No timeout increase, skip-list expansion, or reclassification can close these
rows.

## Implementation plan

1. Run each exact path as a fresh solo process in host and standalone modes,
   with pass/fail harness controls, and record wall time and final disposition.
2. For the two detached-buffer rows, reduce the shared compiler/runtime path
   and determine whether the hang is compilation, adapter initialization, or
   execution misclassified by the runner.
3. For `body-put-error.js`, remove the historical hanging-test exemption only
   after reproducing the compiler path under a bounded process and reducing the
   responsible control-flow pattern.
4. Implement the narrow shared fixes with focused regressions and adjacent
   controls. Do not raise timeouts or add filters, fixture rewrites, or skips.
5. Rerun all three exact rows in both lanes, run TypeScript 5/7, formatting,
   lint, budgets, ratchets, and issue gates, then commit and push a clean branch
   for integration into the sole draft PR #5010.

## Acceptance

- All three rows have fresh solo host and standalone dispositions.
- Each row passes in both maintained lanes without an exemption or timeout
  increase.
- Focused regressions and controls pass, and repository gates remain green.
- The issue records exact artifacts, denominators, and any unrelated handoff.
