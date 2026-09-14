---
id: 5393
title: "Extend differential auditing to general JavaScript behavior"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: test
area: compiler
goal: correctness
assignee: "ttraenkler/codex-js-soundness"
depends_on: [5387]
---

## Request

After repairing PR 5748's CI failures, extend the differential audit from
TypeScript type-flow hazards to general JavaScript behavior. Preserve the
requirement to file measured defects and reject unsupported semantics instead
of silently changing program behavior.

## Method

Reuse the repository's general-JavaScript differential corpus with fresh
processes, Node reference execution, both Wasm targets, and normal/optimized
compilation. Preserve observable output and completion distinctions. Include
runtime-dependent inputs, state changes, evaluation order, exceptions, identity,
prototypes/descriptors, collections, numeric edges, closures, generators, and
asynchronous behavior. Validate the audit instrument with positive controls and
known divergences. Report mismatches, explicit compiler refusals, harness
limitations, and unmeasured behavior separately.

No finite audit can prove equivalence for all JavaScript programs. "No finding"
is not a general soundness certificate. Unknown or unsupported observations must
remain visible in the result, and compile errors do not count as conformance.

## Acceptance criteria

- [x] Repair the predecessor's CI regressions without expanding failure baselines.
- [x] Commit a broader, reproducible JavaScript corpus and exact execution records.
- [x] Exercise host/standalone and normal/optimized compilation with Node references.
- [x] File new measured defect families or link matching existing issues.
- [x] Add narrow source-located refusals or repairs for confirmed silent divergences.
- [x] Verify matching controls and rerun affected equivalence/quality checks.

## Findings

The committed manifest contains 168 programs: 120 existing corpus specimens and
48 additional JavaScript programs. Fresh-process observation preserves exact
output and distinguishes normal completion, program exceptions, compiler failures,
and unsupported observation protocols. The baseline records 118 divergences
(output, completion, or invalid Wasm), 528 matches, 10 refusals, and 16 unknowns
across 672 comparisons. Repairs and source-located refusals cover every measured
divergence in that manifest. Separate minimized controls cover Number parameter
shadowing and primitive console formatting outside its denominator.

See [the audit report](../audit/javascript-soundness-2026-09-08/README.md) for
final candidate counts, exact records, reproduction, and observation limits.
CI repair validation is recorded in the preceding TypeScript audit directory.

## Bounded PR5748 guard repair (2026-09-15)

Base: fetched `upstream refs/pull/5748/head`, verified as
`9b36161f94ab1108b1ed0e1917a828ee3d3dad58`. Isolated branch
`codex/5748-guard-repair-20260914`, worktree
`/Users/thomas/Code/js2/.codex-worktrees/5748-guard-repair-20260914`.
The parent owns current-main integration and the compiler inventory conflict.
This patch does not modify that worktree, inventory policy, code generation,
audit baseline/candidate records, or conformance expectations.

The original six host files all reproduced their recorded compile refusals
before edits, using `runTest262File`, original harness assembly, strict reruns,
Node v22.23.2, and unchanged test262 source hashes. The existing three guard
suites passed 85/85 on the same head.

The array-prototype guard now requires a concrete literal prototype origin,
matching the measured inherited-slot defect. Proxy and TypedArray prototype
operations are not inferred unsound from the array receiver alone. Unknown
prototype origins remain unclassified, not certified correct. The original
literal failure remains refused on both targets; immutable-manifest aliased
literal controls remain refused in host mode with optimization off/on.

The enumeration guard permits descriptor-created permanent own properties
that cover every literal prototype key, provided neither prototype nor
receiver escapes or is mutated. Partial shadows, configurable shadows,
accessors, indirect prototype mutation and later ordinary assignments do not
establish that proof. Executed enumerable and non-enumerable shadow controls
preserve exact key output.

Five formerly passing files are restored locally: both Array indexOf/
lastIndexOf prototype tests, both TypedArray Set prototype-chain tests,
and for-in/order-enumerable-shadowed. Their assertions and strict reruns
are unchanged. The sixth, dynamic-import/yield-star, remains refused;
[the generator handoff](5398-generator-iterator-semantic-safety.md#pr5748-bounded-repair-handoff-2026-09-15)
records why a blanket exemption would hide actual wrong values and proposes
the additional frontend scope needed. This is a partial unblock, not permission
to remove the existing PR hold.

Raw local evidence remains under this worktree's `.tmp/`:

- `guard-regressions-before.log`: all six original located refusals and source hashes.
- `raw-controls-focused.log`: eight diagnostic-filtered host observations;
  original array `7 -> NaN`, enumeration `ba -> empty`, generator `1 7 -> 1 0`;
  complete descriptor shadows match, partial descriptors lose inherited keys;
  executed array delegation replaces undefined completion with 0.
- `syntax-only-probe.log`: the uncalled import generator passes only after
  filtering the diagnostic; this is not runtime delegation evidence.
- `guard-final-validated.log`: focused retained guards, immutable-manifest
  refusal controls with host optimization off/on, and five original files.
- `typecheck.log`: typecheck output for the final production source.

An accidental broad test selection in the first temporary probe configuration
was cancelled and is excluded from validation. No full conformance sweep or
CI restart is claimed. The committed September 8 raw audit records are intact.

Final scoped validation: 116/116 tests pass across the three original guard
suites and `tests/issue-5393-guard-regressions.test.ts`. This includes all 85
original tests unchanged, 18 additional guard controls, five original-harness
pass cases, and eight immutable-manifest host refusal checks (four programs,
optimization 0/2). Typecheck, function budget, LOC budget, oracle ratchet and
diff checks pass. No new budget allowance or baseline expansion was needed.
