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

The post-change authoritative runs on the final synchronized branch used the
same pinned Test262 checkout, QuickJS artifact, exact six-row filter, and two
compiler workers as the baseline.  They reached every row with no skip,
compile error, or timeout:

| lane | run | target result | controls | report JSONL SHA-256 |
| --- | --- | --- | --- | --- |
| JS-host | `20260827-205002` | 3/3 pass | 3/3 pass | `9c27b2f9d65c1137d2eb2b9404e0e4c53fef7f61a42a299a77b895aa77eec740` |
| standalone | `20260827-205116` | 3/3 pass | 3/3 pass | `840d477b79d93b66ad0ecc12132017f386415b360a3985358f29a51fecfe74b5` |

Compared with the baseline artifacts above, this is exactly two host
fail-to-pass flips and three standalone fail-to-pass flips, with zero
pass-to-fail losses.  The host's pre-existing dynamic host-import diagnostics
are unchanged for this cohort; the standalone direct-compile probes succeed
with zero `env` imports.

Repeat runs with the same filter and worker limit were also clean:

| lane | repeat run | result | report JSONL SHA-256 |
| --- | --- | --- | --- |
| JS-host | `20260827-205314` | 6/6 pass | `9762bdc286b715163201add940bdcc25fadab475754bdfe1fa49f6c19125b8aa` |
| standalone | `20260827-205454` | 6/6 pass | `0c76b1bc7f3b14b884782a983a74c429133b1b8b0f46054108fb48ff620d217a` |

Focused regression coverage passed `13/13` after the final sync (six
authoritative rows in each lane plus three standalone no-host-import probes).
The focused source gates also passed: Prettier, Biome, TypeScript 7, and
TypeScript 5.  `git diff --check` is clean.

## Handoff

- Worktree: `/private/tmp/js2-es2015-next-bounded-fix-7`
- Branch: `codex/es2015-next-bounded-fix-7`
- Plan checkpoint: `2fad13936`
- Implementation checkpoint: `1dcffcdb0`
- Current-upstream sync checkpoint: `00fd1834c` (contains upstream `main` at `db872cf39ffcda8775fa11b0385c896337ab611e`)
- Upstream PR: [#5079](https://github.com/loopdive/js2/pull/5079), from `ttraenkler:codex/es2015-next-bounded-fix-7` against `loopdive/js2:main`
- PR state at handoff: open, ready/non-draft, `MERGEABLE`/`CLEAN`, head `a5be883a22742d89b69a04e299ccb9a02eec8a68`; all visible required checks and ARM passed, with no comments, reviews, or hold labels observed
- Merge/queue state: ready for the one-time auto-merge arm and merge-queue enqueue; no queue mutation was made from this context because that consequential remote action requires explicit parent/user authorization

## Intended files

- `src/codegen/expressions/call-receiver-method.ts`
- one focused regression test under `tests/`
- this issue record
