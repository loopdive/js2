---
id: 4776
title: "ES2015 standalone Symbol.prototype.valueOf borrowed calls"
status: in-progress
sprint: current
created: 2026-08-27
updated: 2026-08-27
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: Symbol.prototype.valueOf
es_edition: es6
goal: standalone-mode
related: [2163, 2866, 4444]
assignee: "ttraenkler/es6-next-residual"
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/symbol-proto-valueof.ts
  - tests/issue-4776-symbol-prototype-valueof.test.ts
  - plan/issues/4776-es2015-symbol-prototype-valueof-standalone.md
loc-budget-allow:
  - src/codegen/array-object-proto.ts
---

# #4776 — ES2015 standalone `Symbol.prototype.valueOf` borrowed calls

## Problem

The two ES2015 Test262 rows that borrow `Symbol.prototype.valueOf` through
`Function.prototype.call` fail under `--target standalone` with the native
refusal `TypeError: Symbol.prototype.valueOf is not yet implemented in
--target standalone`. The host lane already passes both rows. The direct
`symbol.valueOf()` path is covered by #2163 and is not part of this issue.

## Exact cohort and baseline (2026-08-27)

The cohort is exactly these two maintained ES2015 rows:

- `test/built-ins/Symbol/prototype/valueOf/this-val-symbol.js`
- `test/built-ins/Symbol/prototype/valueOf/this-val-obj-symbol.js`

Both were run solo through `tests/test262-runner.ts` from the pinned
`upstream/main` base `641bb706d676c97332f7cc276382ea0df3189304`, with the
repository's Test262 submodule at `b363f29d3c43c626dc852744ad64a0b48a003693`.
The authoritative baseline is **host 2/2 pass** and **standalone 0/2 pass,
2/2 fail, 0 compile errors, 0 timeouts, 0 skips**. Standalone's identical
failure is the `Symbol.prototype.valueOf` refusal above; no host failure or
compile error belongs in this denominator.

## Implementation plan

1. Extend the existing standalone native-prototype closure for
   `Symbol.prototype.valueOf` in the Symbol carrier subsystem. Accept a boxed
   native `$Symbol` receiver and return its identity-stable carrier; accept a
   standalone `Object(symbol)` wrapper's internal `[[PrimitiveValue]]` slot
   when present; throw a catchable TypeError for all other receivers.
2. Keep the existing `Symbol.prototype` glue, closure identity, metadata, and
   host/GC lowering unchanged. Do not alter `Object(symbol)` construction,
   Symbol key storage, direct `symbol.valueOf()`, or unrelated prototype
   methods.
3. Add a focused regression that runs the exact two Test262 files in both
   host and standalone modes, plus direct wrong-receiver controls proving the
   new body does not turn invalid calls into values.
4. Rerun the exact two-row host and standalone cohort, focused controls, and
   mandatory type/lint/format checks. Record residuals, artifacts, commit, and
   PR handoff here.

## Evidence and handoff before implementation

The failure is localized: `ensureSymbolNativeProtoGlue` advertises
`valueOf`, `resolveStandaloneProtoMemberValueClosure` materializes its
identity-stable closure, and `makeGlue` currently routes the Symbol member to
`emitProtoMemberBodyRefusal`. `Symbol` already has a native `$Symbol` carrier
and `__box_symbol`; the analogous wrapper value-of implementation in
`wrapper-proto-value-of.ts` provides the catchable brand-check pattern. This
is a bounded one-member closure-body fix. The adjacent Symbol rows
`this-val-non-obj.js` and `this-val-obj-non-symbol.js` are already passing and
remain controls; generator, function metadata, and active issues #1691,
#4768, and #4770 are excluded.

## Implementation

`makeGlue` now routes only `Symbol.prototype.valueOf` to a new standalone
body in `src/codegen/symbol-proto-valueof.ts` (with one narrow wiring import in
`src/codegen/array-object-proto.ts`). The body requests the existing
native `$Symbol` carrier even when the prototype member is read before the
first Symbol expression, returns a matching carrier unchanged, and also
recovers a `$Symbol` from an internal `[[PrimitiveValue]]` slot on a native
`$Object` wrapper. A non-matching receiver reaches the shared in-module
catchable TypeError builder. The Symbol glue, closure metadata/identity, host
path, and direct `symbol.valueOf()` lowering remain unchanged.

## Post-fix evidence (2026-08-27)

The exact cohort was rerun through `scripts/harness-flip-probe.ts` with its
structural must-pass/must-fail controls. Both lanes report **2/2 pass, 0 fail,
0 compile errors, 0 compile timeouts, 0 skips**:

- host artifact: `.tmp/issue-4776-after-host.jsonl`
- standalone artifact: `.tmp/issue-4776-after-standalone.jsonl`

The focused Vitest regression
`tests/issue-4776-symbol-prototype-valueof.test.ts` reports **8/8 passed**:
the two exact cohort rows and two incompatible-receiver controls in both host
and standalone lanes. TypeScript 7 typecheck, focused Biome lint, focused
Prettier check, and `git diff --check` pass. The full-repository Biome command
still reports pre-existing diagnostics outside this change; the two changed
files are clean under the same rule set.

The adjacent `Symbol.prototype.valueOf` `length.js`, `name.js`, and
`prop-desc.js` metadata rows remain host failures owned by #4770; they are not
part of this behavior-only cohort. No standalone residual in the selected
two-row cohort remains.

## Refreshed-upstream verification (2026-08-27)

The branch was synchronized with the current `upstream/main` tip
`842ea5ca0b161df9fd0d26865075cc1184434361` by the non-rewriting merge commit
`1e32242a9e9fa84ad6db61394104495803f78f42`. Its delta from that upstream tip
remains limited to the four files listed in this issue. The behavior fix is
`a8e36e8ce3119cd754e277adf0dac22856c8a3ea`.

The exact two-row cohort was rerun on that refreshed branch with the
structural harness controls: host **2/2 pass** and standalone **2/2 pass**,
with 0 failures, compile errors, compile timeouts, or skips in either lane.
The focused regression was rerun with at most two workers and reports **8/8
passed**. The refreshed harness artifacts are:

- host: `.tmp/issue-4776-after-refresh-host.jsonl`
  (`049c3294a6df45e227dd613e42d4824bb9470c2e95070ca937ca3f373993754a`)
- standalone: `.tmp/issue-4776-after-refresh-standalone.jsonl`
  (`314597e80e43844d023467c8e8c0efeb17390b8cae1d07bd49b6e222d1c09b83`)

PR #5065 remains a draft with the hold label while refreshed upstream CI is
pending; no ready or merge-queue action has been taken. The final handoff
requires refreshed CI to be fully green and the PR to be clean/mergeable,
with `mergeQueueEntry: null` verified before any ready/enqueue change.

## Current-upstream verification (2026-08-27; final baseline refresh)

After upstream PR #5060 merged, the branch was refreshed to
`upstream/main` `a2c8c260fd0f1cf9b679cedc487e48f1c26def02` through the
non-rewriting merge commit `08836b92def22e55990eb59f5ff3c2e97eda6e6f`. Its
delta from that upstream tip remains limited to the four files listed in this
issue; the behavior fix remains `a8e36e8ce3119cd754e277adf0dac22856c8a3ea`.

The exact two-row cohort was rerun on this current branch with structural
harness controls: host **2/2 pass** and standalone **2/2 pass**, with 0
failures, compile errors, compile timeouts, or skips in either lane. The
focused regression again reports **8/8 passed** with `TEST262_WORKERS=2`.
The current harness artifacts are:

- host: `.tmp/issue-4776-after-refresh3-host.jsonl`
  (`049c3294a6df45e227dd613e42d4824bb9470c2e95070ca937ca3f373993754a`)
- standalone: `.tmp/issue-4776-after-refresh3-standalone.jsonl`
  (`314597e80e43844d023467c8e8c0efeb17390b8cae1d07bd49b6e222d1c09b83`)

PR #5065 remains draft with `hold`; this final baseline-refresh checkpoint is
pending remote push and CI. No ready or merge-queue action has been taken, and
the handoff still requires clean/mergeable status with `mergeQueueEntry: null`
before any ready/enqueue change.

## Final ancestry verification (2026-08-27)

Upstream main advanced once more through the artifact-only npm-compat refresh
PR #5066. The branch merged its tip
`03ebf325013a241d5609a457fbdfea78bdf48ee2` without rewriting history at
`a6d3b8a08f0de2b97e68dec0adf0f74ffb7e8d83`. The exact cohort remains host
**2/2 pass** and standalone **2/2 pass**, with zero failures, compile errors,
compile timeouts, or skips. Focused coverage remains **8/8 pass** with at most
two workers. The final artifacts are:

- host: `.tmp/issue-4776-after-refresh4-host.jsonl`
  (`049c3294a6df45e227dd613e42d4824bb9470c2e95070ca937ca3f373993754a`)
- standalone: `.tmp/issue-4776-after-refresh4-standalone.jsonl`
  (`314597e80e43844d023467c8e8c0efeb17390b8cae1d07bd49b6e222d1c09b83`)

The remaining landing gates are the evidence commit's normal hooks, refreshed
upstream CI, and final CLEAN/MERGEABLE verification before removing `hold` and
marking PR #5065 ready.

## Acceptance

- Both exact rows pass in host and standalone after the change.
- Standalone has no host imports and no compile errors/timeouts/skips.
- Invalid receiver controls continue to throw their expected TypeError.
- No direct-symbol, Symbol-registry, or host-lane regressions are introduced.
- The final PR remains draft with the hold label until all checks are green and
  `mergeQueueEntry` is verified as `null`.
