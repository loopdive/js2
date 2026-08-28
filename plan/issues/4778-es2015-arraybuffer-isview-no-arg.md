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

The implementation adds only the standalone zero-argument arm in
`src/codegen/expressions/call-namespace-static.ts`; the existing host route and
argument-bearing arm are unchanged.

The final exact post-change harness run on refreshed upstream
`fb4efeaa5cb2a374d9b6ff87b4eca217a2ab78f1` (including merged #5074) used the
same pinned artifact, two-worker limit, and mandatory positive controls as the
baseline:

| lane | target cohort + controls | result | evidence |
| --- | ---: | --- | --- |
| JS-host | 4/4 | **4 pass**, 0 fail/compile error/skip | `.tmp/issue-4778/final-fb4efeaa5/host.jsonl` |
| standalone | 4/4 | **4 pass**, 0 fail/compile error/skip | `.tmp/issue-4778/final-fb4efeaa5/standalone.jsonl` |

The target's local A/B partition is exactly one standalone `compile_error →
pass` gain, zero losses, and zero other changes:

```text
before: 1 file, compile_error 1
after:  4 files, pass 4 (target plus three controls)
target: fail -> pass 1; pass -> fail 0; other 0
```

The host target remains `pass → pass` (zero flips).  The three pinned controls
were independently measured 3/3 pass in each baseline lane and are 3/3 pass
in each post-change lane:

```text
test/built-ins/ArrayBuffer/isView/arg-is-not-object.js
test/built-ins/ArrayBuffer/isView/arg-is-arraybuffer.js
test/built-ins/ArrayBuffer/isView/arg-has-no-viewedarraybuffer.js
```

Focused Vitest regression: `tests/issue-4778-arraybuffer-isview-no-arg.test.ts`
passed **9/9**, including host and standalone runs for all four pins, plus a
direct standalone compile assertion that `result.imports` is empty.  The
standalone target therefore no longer emits `env::__get_builtin` for the
omitted-argument call.  The adjacent `tests/issue-2594.test.ts` suite was
rerun with the new test and remained **16/16** green.  Repeated target probes
reported `nondeterministic: 0` in both host and standalone lanes.

The branch was refreshed with a non-rewriting upstream merge commit
`7b2dcc224` before this rerun.  The final evidence checkpoint and pushed head
are recorded with the PR handoff.

## Latest-main readiness verification (2026-08-27)

After upstream advanced again through #5067, the branch non-rewriting merged
current `upstream/main` at `db872cf39ffcda8775fa11b0385c896337ab611e`.
The exact four-row official cohort was then exercised through
`runTest262File` in both lanes with the pinned QuickJS artifact and at most two
compiler workers: host **4/4 passed** and standalone **4/4 passed**. The direct
standalone no-host-import assertion also passed. Together with the adjacent
#2594 controls, the focused verification is **16/16 passed** with zero losses.

Handoff: PR #5072 remains draft plus `hold` until this checkpoint is pushed
with normal hooks and the refreshed required checks are green. It may be
marked ready and enqueued only while current, mergeable, and thread-clean.

## Intended files

- `src/codegen/expressions/call-namespace-static.ts`
- `tests/issue-4778-arraybuffer-isview-no-arg.test.ts`
- this issue record
