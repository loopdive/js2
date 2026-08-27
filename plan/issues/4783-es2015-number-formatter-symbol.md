---
id: 4783
title: "ES2015 Number formatter Symbol-argument coercion"
status: review
created: 2026-08-27
updated: 2026-08-27
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: number-formatting
es_edition: 2015
goal: standalone-mode
sprint: current
assignee: "ttraenkler/es2015-next-bounded-fix-7"
related: [3175, 3181]
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# #4783 — ES2015 Number formatter Symbol-argument coercion

## Scope and exact baseline

This is one bounded, three-row official ES2015 standalone cohort.  The branch
starts at upstream `main` commit `84e86be2afb511fc8547cf2012abf4bbaa7200a2`.
The pinned Test262 checkout is the checkout already used by the upstream
baseline artifact.  The exact target rows are:

```text
test/built-ins/Number/prototype/toExponential/return-abrupt-tointeger-fractiondigits-symbol.js
test/built-ins/Number/prototype/toFixed/toFixed-tonumber-throws-typeerror-symbol.js
test/built-ins/Number/prototype/toPrecision/return-abrupt-tointeger-precision-symbol.js
```

Fresh focused runs on this branch's upstream `main` head used the assembled
official harness, a two-worker compiler pool, and the pinned QuickJS artifact.
All three rows were reached with no skip or timeout.  The authoritative
pre-change verdicts are:

| lane | target rows | result | diagnostic |
| --- | ---: | --- | --- |
| JS-host | 3 | 1 pass, 2 fail | no throw for `toExponential`; wrong `RangeError` for `toFixed` |
| standalone | 3 | 0 pass, 3 fail | no throw; wrong `RangeError`; non-object thrown value |

Baseline artifacts (SHA-256):

```text
.tmp/issue-4783/baseline/host.jsonl       1e8c5bb0fa9c6fc7a03f27f7f94d1a97b43f8870ff68bb95f2408ba86df6ca99
.tmp/issue-4783/baseline/standalone.jsonl  dc31e9fcde5b5bbb147d0b03878c618caf0b06aebce323719dfd08664bead25a
```

The host and standalone JSONL artifacts are kept in the worktree's ignored
`.tmp/issue-4783/baseline/` directory; their corresponding report JSON files
contain `1/3` and `0/3` passes respectively.  The host lane also reports the
expected pre-existing dynamic host imports; this cohort is about verdict
correctness, not removing host imports.

The scope is deliberately limited to these three direct dot-call rows;
element-access, dynamic receiver, BigInt, range, and no-argument formatter rows
are excluded.

The positive controls for the A/B runs are:

```text
test/built-ins/Number/prototype/toExponential/nan.js
test/built-ins/Number/prototype/toFixed/return-type.js
test/built-ins/Number/prototype/toPrecision/nan.js
```

## Root-cause hypothesis

The direct Number formatter lowering compiles a statically known `Symbol()`
argument as its internal `i32` symbol handle, then treats that compiler result
as an already numeric value in `coerceNumberMethodArgToF64`.  ECMAScript
`ToNumber(Symbol)` must instead throw a `TypeError`.  The three target rows
exercise the same direct formatter argument boundary and currently observe
missing or wrong exception values in standalone mode.

## Implementation plan

1. Reserve this issue and keep the change in the direct Number formatter call
   lowering only; do not broaden generic coercion or element-access paths.
2. Detect a statically known Symbol formatter argument before the `i32` to `f64`
   conversion and emit the existing real `TypeError` path after evaluating the
   receiver and argument in source order.
3. Add a focused regression test for the three exact official rows and the
   three positive formatter controls, asserting host and standalone behavior
   and no new standalone host import.
4. Run authoritative host and standalone A/B probes with exactly two compiler
   workers, controls, repeat determinism, focused unit/type/lint/format gates,
   and record the verdict diff and artifacts here.

## Acceptance criteria

- Each of the three exact target rows passes under the assembled official
  Test262 harness in both JS-host and standalone lanes.
- The mandatory positive formatter controls remain passing in both lanes.
- The target change is exactly three fail-to-pass flips, with zero
  pass-to-fail, new compile errors, skips, host-import leaks, or nondeterminism.
- Symbol arguments in the direct formatter calls produce a real `TypeError`,
  while non-Symbol formatter coercion and dynamic/element access remain
  unchanged.
- The final branch is based on current upstream `main`, has a checked-in issue
  handoff, and is represented by one upstream `loopdive/js2` PR.

## Test results

The implementation routes the statically known Symbol argument through
`emitSymbolArgToNumberThrow` before the existing numeric formatter coercion in
all three direct-call branches.  Receiver and argument evaluation order is
unchanged, and dynamic/element-access calls remain on their existing paths.

The post-change authoritative runs used the same pinned Test262 checkout,
QuickJS artifact, exact six-row filter, and two compiler workers as the
baseline.  They reached every row with no skip, compile error, or timeout:

| lane | run | target result | controls | report JSONL SHA-256 |
| --- | --- | --- | --- | --- |
| JS-host | `20260827-193607` | 3/3 pass | 3/3 pass | `3f5c605c72a0ff1b2284d054c3b5c0948d27d0c3e63e4b6c4f7eb109c11046a9` |
| standalone | `20260827-193728` | 3/3 pass | 3/3 pass | `5cf62ce45edffb240eb57f01ab4cc4a806658c55bd0424b17b02cd358d1d0283` |

Compared with the baseline artifacts above, this is exactly two host
fail-to-pass flips and three standalone fail-to-pass flips, with zero
pass-to-fail losses.  The host's pre-existing dynamic host-import diagnostics
are unchanged for this cohort; the standalone direct-compile probes succeed
with zero `env` imports.

Repeat runs with the same filter and worker limit were also clean:

| lane | repeat run | result | report JSONL SHA-256 |
| --- | --- | --- | --- |
| JS-host | `20260827-194701` | 6/6 pass | `16a448062e72256a434424b028fe3e65f0031ded3b71cbbd78ec74983756b0d9` |
| standalone | `20260827-195645` | 6/6 pass | `4ee2c4319d0ec33b525a723a0c5bba6c7aee3c206a25aab6c671950ab7582bc3` |

Focused regression coverage passed `13/13` (six authoritative rows in each
lane plus three standalone no-host-import probes).  The focused source gates
also passed: Prettier, Biome, TypeScript 7, and TypeScript 5.  `git diff
--check` is clean.

## Handoff

- Worktree: `/private/tmp/js2-es2015-next-bounded-fix-7`
- Branch: `codex/es2015-next-bounded-fix-7`
- Plan checkpoint: `2fad13936`
- Implementation checkpoint: `1dcffcdb0`
- Current-upstream sync checkpoint: `a43dc325b` (merged `upstream/main` at `4d1001a8`)
- Upstream PR: to be opened from `ttraenkler:codex/es2015-next-bounded-fix-7` against `loopdive/js2:main`
- Merge/queue state: hold until the upstream PR is current and CI plus ARM are green; no queue request has been made

## Intended files

- `src/codegen/expressions/call-receiver-method.ts`
- one focused regression test under `tests/`
- this issue record
