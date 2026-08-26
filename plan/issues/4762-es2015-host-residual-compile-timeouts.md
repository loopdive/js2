---
id: 4762
title: "ES2015 host Test262 residual compile timeouts"
status: in_progress
created: 2026-08-26
updated: 2026-08-26
priority: critical
horizon: s
feasibility: medium
reasoning_effort: max
model: gpt-5.6-luna
task_type: conformance
area: codegen, runtime, test262
es_edition: es2015
goal: test262-conformance
parent: 4753
assignee: ttraenkler/codex-es6-closeout
files:
  - src
  - scripts
  - tests
  - plan/issues/4762-es2015-host-residual-compile-timeouts.md
---

# #4762 — ES2015 host residual compile timeouts

## Problem

After issue #4758 removes the 40 destructuring worker-lifecycle timeouts, the
complete authoritative host run `20260826-180615` has six other
`compile_timeout` rows in the 11,704-row ES2015 bucket:

- `test/language/expressions/instanceof/prototype-getter-with-object-throws.js`
- `test/language/expressions/instanceof/prototype-getter-with-object.js`
- `test/language/expressions/instanceof/prototype-getter-with-primitive.js`
- `test/language/statements/for-in/head-lhs-let.js`
- `test/built-ins/Array/prototype/Symbol.iterator.js`
- `test/built-ins/Set/set-get-add-method-failure.js`

All six were recorded as ten-second timeouts in
`/private/tmp/js2-es6-authoritative-measure3/benchmarks/results/test262-results-20260826-180615.jsonl`.
They span at least four apparent semantic families, so a shared classification
must be proven rather than assumed.

## Implementation plan

1. Run each exact path alone in fresh host and standalone processes with
   pass/fail harness controls. Record compile, instantiate, and execution phase
   timing so a lifecycle failure is not mislabeled as compiler work.
2. Reduce the three `instanceof` rows together; treat `for-in`, Array iterator,
   and Set accessor failure as independent until traces prove a shared mutable
   intrinsic or callback boundary.
3. Implement only proven shared roots. If the six rows split, update this issue
   with exact dispositions and create one child issue plan per implementation
   cluster before changing unrelated subsystems.
4. Add focused regressions and controls. Do not raise timeouts, add skips or
   filters, rewrite fixtures, or substitute oracle-only behavior.
5. Rerun every owned path in both lanes, then run TypeScript 5/7, formatting,
   lint, budgets, ratchets, and issue gates. Commit and push clean checkpoints
   for integration into the sole upstream draft PR #5010.

## Acceptance

- All six rows have fresh solo host and standalone dispositions.
- Zero owned row remains a compile timeout, skip, or unrecorded process hang.
- Every implemented semantic cluster passes its exact pins and controls in both
  lanes; distinct failures have explicit issue-backed handoffs.
- No timeout, filter, fixture, skip, or oracle workaround is introduced.
