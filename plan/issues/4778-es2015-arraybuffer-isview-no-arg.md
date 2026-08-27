---
id: 4778
title: "ES2015 standalone ArrayBuffer.isView no-argument call"
status: in-progress
created: 2026-08-27
updated: 2026-08-27
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: typed-arrays
es_edition: 2015
goal: standalone-mode
sprint: current
assignee: "ttraenkler/es6-next-bounded-fix-3"
related: [965, 1472, 2594]
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
---

# #4778 — standalone `ArrayBuffer.isView()` no-argument call

## Scope and measured baseline

This issue is a one-row, exact official ES2015 cohort.  The branch starts at
upstream `main` commit `03ebf325013a241d5609a457fbdfea78bdf48ee2`; the pinned
Test262 checkout is `b363f29d3c43c626dc852744ad64a0b48a003693`.  The edition map
places the target in the ES2015 set (11,704 non-`intl402` paths).  The exact
target is:

```text
test/built-ins/ArrayBuffer/isView/no-arg.js
```

Through `scripts/harness-flip-probe.ts` and the assembled official harness,
with the positive must-pass/must-fail controls, two workers, and the pinned
QuickJS standalone artifact, the current-main baseline is:

| lane | result | evidence |
| --- | --- | --- |
| JS-host | **1/1 pass** | `.tmp/issue-4778/baseline/host.jsonl` |
| standalone | **0/1 pass**; 1 `compile_error` | `.tmp/issue-4778/baseline/standalone.jsonl` |

The standalone diagnostic is the existing `__get_builtin` dynamic-shape
codegen error.  The host lane already routes through the host implementation.
Focused controls in the same official `ArrayBuffer.isView` family remain
passing in both lanes at baseline:

```text
test/built-ins/ArrayBuffer/isView/arg-is-not-object.js
test/built-ins/ArrayBuffer/isView/arg-is-arraybuffer.js
test/built-ins/ArrayBuffer/isView/arg-has-no-viewedarraybuffer.js
```

Each control measured 3/3 pass in both host and standalone lanes.  The
nearby typed-array/DataView and indirect-call rows are deliberately excluded:
they exercise broader carrier and call-value residuals, not the missing
zero-argument arity case.

## Root cause hypothesis

`compileNamespaceStaticCall` recognizes the `ArrayBuffer.isView` namespace
only when `expr.arguments.length >= 1`.  A no-argument call therefore falls
through to generic dynamic-shape dispatch.  In standalone mode that dispatch
requests `__get_builtin`, which is forbidden and rejects the whole module at
compile time.  ECMAScript §25.1.4.1 treats the omitted `arg` as `undefined`
and returns `false`; no argument needs evaluation or a host import.

The existing one-or-more-argument standalone implementation from #2594 is
out of scope and must remain unchanged.  JS-host behavior must also remain on
the existing host helper path.

## Implementation plan

1. Extend the existing `ArrayBuffer.isView` namespace arm with a narrow
   standalone-only zero-argument branch that emits `i32.const 0` and returns an
   `i32` result.  Keep the current host route and all argument-bearing static
   and runtime fallback paths untouched.
2. Add a focused regression test that runs the exact Test262 target plus the
   three passing controls through `runTest262File` in host and standalone
   lanes, and asserts that the standalone compiled module remains host-import
   free.
3. Rerun the exact one-row cohort, controls, compiler/type/lint/format gates,
   and the local A/B harness probe on the finished branch.

## Acceptance

- `no-arg.js` passes in both host and standalone lanes through the assembled
  official harness.
- All three pinned controls remain 3/3 pass in both lanes.
- The standalone target module contains no `env::__get_builtin` or other JS
  host import for the no-argument call.
- Argument-bearing `ArrayBuffer.isView` lowering and JS-host behavior are
  unchanged.

## Test results

To be filled with post-change command output, focused test counts, exact
host/standalone rows, and the local-vs-local A/B partition.

## Intended files

- `src/codegen/expressions/call-namespace-static.ts`
- `tests/issue-4778-arraybuffer-isview-no-arg.test.ts`
- this issue record
