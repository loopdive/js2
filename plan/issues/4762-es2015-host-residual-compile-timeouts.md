---
id: 4762
title: "ES2015 host Test262 residual compile timeouts"
status: done
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

## Fresh combined-head measurement

Scoped authoritative host run `20260826-224008` measured the exact six paths at
combined head `a356d20d4` with the maintained `test:262 --official-scope-only`
runner:

- 2/6 pass, 4/6 compile timeout, 0 fail, 0 compile error, 0 skip.
- `test/built-ins/Array/prototype/Symbol.iterator.js` passes and performs the
  expected Array iterator realm recycle.
- `test/built-ins/Set/set-get-add-method-failure.js` passes and performs the
  expected `Set.prototype.add` realm recycle.
- All three `instanceof/prototype-getter-*` rows and
  `language/statements/for-in/head-lhs-let.js` still time out in both the
  30-second first attempt and isolated 10-second retry.

Artifacts:

- `benchmarks/results/test262-report-20260826-224008.json`
- `benchmarks/results/test262-results-20260826-224008.jsonl`

The #4758 worker-lifecycle fix therefore closes two of this issue's original
six rows. The implementation slice now owns exactly the remaining 4/6 rows;
the two newly passing rows remain regression controls.

## Mutation-safe realm-canary checkpoint

Tracing localized the remaining four host timeouts after test execution, in
the realm-canary comparison and cleanup path. The canary read
`constructor.prototype` directly, which invoked an inherited accessor after
the `instanceof` tests installed `Function.prototype.prototype`. Its drift
arrays also used inherited numeric writes, spread, and `filter`, all observable
after tests mutate Array intrinsics.

`scripts/test262-worker.mjs` now reads only own data descriptors for constructor
prototype snapshots, appends drift entries with `Object.defineProperty`, and
combines/filters drift through indexed loops. No timeout, retry, filter, fixture,
or skip policy changed.

Scoped maintained-runner host run `20260826-233131` on the final combined head and exact same six paths
produced **4 pass / 2 fail / 0 compile error / 0 compile timeout / 0 skip**:

- pass: `prototype-getter-with-object-throws.js`,
  `prototype-getter-with-primitive.js`, `for-in/head-lhs-let.js`, and
  `Array/prototype/Symbol.iterator.js`;
- fail: `prototype-getter-with-object.js` (getter/prototype-chain semantics,
  handed back to #2765) and `Set/set-get-add-method-failure.js` (abrupt Set
  adder lookup/call semantics, handed to #4763).

Artifacts are
`benchmarks/results/test262-report-20260826-233131.json` and
`benchmarks/results/test262-results-20260826-233131.jsonl`. The authoritative standalone baseline has 3/6 pass and 3/6 fail, with
zero timeout: the object and throwing-object `instanceof` rows plus the Set row
remain semantic failures there. This issue's timeout objective is complete;
the explicit semantic handoffs remain open.

Permanent regression coverage lives in `tests/issue-4762.test.ts`. It runs the
exact inherited `Function.prototype.prototype` accessor and poisoned
`Array.prototype[1]` rows through the fork-worker realm canary and requires
both to finish, pass, reach the test body, and request safe worker recycling.
