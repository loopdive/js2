---
id: 4779
title: "ES2015 standalone BigInt.prototype.toString rejects Symbol radix"
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
language_feature: BigInt.prototype.toString
es_edition: es6
goal: standalone-mode
related: [1644, 1564]
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
assignee: "ttraenkler/es6-next-bounded-fix-4"
files:
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/js-errors.ts
  - tests/issue-4779-bigint-tostring-symbol-radix.test.ts
  - plan/issues/4779-es2015-bigint-tostring-symbol-radix-standalone.md
---

# #4779 — ES2015 standalone `BigInt.prototype.toString` rejects Symbol radix

## Problem

The maintained ES2015 Test262 row
`built-ins/BigInt/prototype/toString/radix-tointegerorinfinity-throws-symbol.js`
passes in host mode but fails under `--target standalone`. The standalone
BigInt `toString` lowering currently sends a statically-created `Symbol` radix
through its numeric (`f64`) conversion path instead of applying the specified
`ToNumber` abrupt completion. The resulting failure is reported as
`Thrown value was not an object!`, rather than as a catchable `TypeError`.

This issue owns exactly that one standalone residual. It does not reopen the
completed BigInt formatting work in #1644, change host BigInt behavior, or
bundle adjacent invalid-radix and receiver cohorts without solo evidence.

## Exact cohort and baseline (2026-08-27)

The cohort is exactly one maintained ES2015 row:

- `test/built-ins/BigInt/prototype/toString/radix-tointegerorinfinity-throws-symbol.js`

The row was run alone through `tests/test262-runner.ts` using an absolute
`test262/test/...` path from upstream/main commit
`6e3fdf2166a33d76260791b8df0bb4bf5f503324`, with the Test262 submodule at
`b363f29d3c43c626dc852744ad64a0b48a003693`. The accurate baseline is:

- host: **1/1 pass, 0 fail, 0 compile errors, 0 timeouts, 0 skips**
- standalone: **0/1 pass, 1 fail, 0 compile errors, 0 timeouts, 0 skips**

Standalone compilation succeeds with no host imports; only execution fails.
The observed standalone assertion is `Test262Error: If _radix_ is Symbol,
BigInt.prototype.toString must throw a TypeError Thrown value was not an
object! | at L22: assert.throws(TypeError...)`.

## Implementation plan

1. Add a narrow static `Symbol`/unsupported numeric radix guard in the
   standalone BigInt `toString` method lowering. Evaluate the radix expression
   and emit the shared native standalone TypeError object on the abrupt path,
   preserving the existing ordinary numeric radix conversion and formatting.
2. Keep host BigInt lowering, receiver checks, string formatting, and unrelated
   call dispatch unchanged. Do not add imports, harness exemptions, skips, or
   fixture rewrites.
3. Add a focused regression that runs this exact row in host and standalone
   modes and controls ordinary numeric radix formatting and invalid-radix
   TypeError behavior.
4. Rerun the exact one-row A/B cohort with at most two workers, focused tests,
   and mandatory type/lint/format checks. Record artifacts, residuals, commit,
   and PR handoff here.

## Acceptance criteria

- The exact row passes in both host and standalone modes.
- Standalone reports no compile errors, compile timeouts, skips, or host
  imports for the row.
- A statically-created Symbol radix throws a catchable `TypeError` in
  standalone mode, while ordinary numeric radix values retain existing native
  formatting.
- Host behavior and unrelated BigInt prototype rows do not regress.
- The dedicated upstream PR follows the repository Description/CLA template,
  stays non-draft with `hold` until current-main verification and green CI prove it
  mergeable, and keeps `mergeQueueEntry: null` before readiness.

## Evidence and handoff before implementation

The failure is localized to the non-host BigInt `toString` radix branch in
`src/codegen/expressions/call-receiver-method.ts`, which compiles the first
argument as `f64`, floors it, range-checks it, and calls the native radix
formatter. The existing `emitSymbolArgToNumberThrow`/`emitThrowTypeError`
helpers provide the intended catchable standalone error representation. The
standalone native formatter itself remains a pure `(i64, i32) -> externref`
operation and should not be changed for this one argument-conversion defect.

## Implementation

`compileReceiverMethodCall` now invokes the shared
`emitSymbolArgToNumberThrow` guard before the standalone BigInt radix path.
This evaluates a statically-created Symbol argument and emits the in-module
TypeError constructor, so the native `(i64, i32) -> externref` formatter never
sees a Symbol's i32 carrier. The host BigInt path and ordinary numeric radix
lowering remain unchanged. The focused regression covers the exact Symbol row
and the maintained radix-2-through-36 formatting control in both lanes.

## Post-fix evidence (2026-08-27)

The exact one-row cohort was rerun through `scripts/harness-flip-probe.ts`
with its structural must-pass/must-fail controls and a 120-second per-row
timeout. Both lanes report **1/1 pass, 0 fail, 0 compile errors, 0 compile
timeouts, 0 skips**. The standalone A/B changed the row from **fail → pass**;
the host A/B remained **pass → pass**, with no losses. The standalone
assemblies compile successfully with **zero imports** in both primary and
strict variants.

Artifacts and SHA-256 digests:

- after host: `.tmp/issue-4779-after-host.jsonl`
  (`eb6ca9a1821717281dc3ee7fe905c68754e459b26929d1461fcbd97e9f96ed57`)
- after standalone: `.tmp/issue-4779-after-standalone.jsonl`
  (`2fc26a3e448742646bff5228ab589e4e32cf005bb42977bdf87811bdc2a77412`)
- before host: `/private/tmp/issue-4779-before-host.jsonl`
  (`eb6ca9a1821717281dc3ee7fe905c68754e459b26929d1461fcbd97e9f96ed57`)
- before standalone: `/private/tmp/issue-4779-before-standalone.jsonl`
  (`3ab320cdae432fd8c533f347466f9d0df342f9ccb08e188d673d3edbd5b1109d`)

`tests/issue-4779-bigint-tostring-symbol-radix.test.ts` reports **4/4 passed**
with `TEST262_WORKERS=2`. TypeScript 7 and TypeScript 5.9 typechecks,
focused Biome lint, focused Prettier check, `git diff --check`, issue-ID,
LOC-budget, and function-budget gates pass. The full repository Biome suite
was not needed for this bounded change; no unrelated files are modified.

## Handoff

The implementation is ready for a dedicated upstream PR from
`ttraenkler:codex/es2015-next-bounded-fix-4` to `loopdive/js2:main`. Keep the
PR non-draft with `hold` until it is rebased or non-rewriting-merged onto the
current upstream tip, the exact A/B and focused checks are rerun there, CI is
green, and GitHub reports CLEAN/MERGEABLE with `mergeQueueEntry: null`. The
branch currently has the issue-plan checkpoint `e985e13`; the implementation
checkpoint follows after this evidence update.

## Current-main refresh (2026-08-27)

The branch was refreshed without rewriting onto upstream/main
`4d1001a8cf9dc8f0fd0cbd83385d82e3e3110141` (PR #5070) by merge commit
`2355aa791c3355c53fd2a1bfd77b0d24219bc9d4`. The exact one-row cohort was
rerun with structural harness controls and a 120-second timeout: host **1/1
pass** and standalone **1/1 pass**, with zero failures, compile errors,
compile timeouts, or skips. The focused regression again reports **4/4
passed** with `TEST262_WORKERS=2`; no losses were observed.

Refreshed artifacts are `.tmp/issue-4779-refresh-host.jsonl`
(`eb6ca9a1821717281dc3ee7fe905c68754e459b26929d1461fcbd97e9f96ed57`) and
`.tmp/issue-4779-refresh-standalone.jsonl`
(`2fc26a3e448742646bff5228ab589e4e32cf005bb42977bdf87811bdc2a77412`).
The PR remains non-draft+hold because queued PR #5074 will advance upstream main;
after #5074 lands, perform one final minimal sync and repeat these checks
before readiness. Keep `mergeQueueEntry: null` until then.

## Final current-main verification (2026-08-27)

After #5074 landed, upstream advanced further through #4781 to
`fb4efeaa5cb2a374d9b6ff87b4eca217a2ab78f1`. The branch was synchronized to
that exact current tip by non-rewriting merge commit
`a94a1e5feecd4734d527f72651a7cbce918bba61`. The exact Test262 row again
reports **host 1/1 pass** and **standalone 1/1 pass**, with zero failures,
compile errors, compile timeouts, or skips. The focused regression remains
**4/4 passed** with `TEST262_WORKERS=2`; no losses were observed.

Final artifacts:

- `.tmp/issue-4779-final-host.jsonl`
  (`eb6ca9a1821717281dc3ee7fe905c68754e459b26929d1461fcbd97e9f96ed57`)
- `.tmp/issue-4779-final-standalone.jsonl`
  (`2fc26a3e448742646bff5228ab589e4e32cf005bb42977bdf87811bdc2a77412`)

The implementation and issue handoff are complete. PR #5073 must remain
non-draft+hold until its body uses the exact durable CLA prompt/link, all checks
are green on this final head, GitHub reports CLEAN/MERGEABLE, and
`mergeQueueEntry` is confirmed null before readiness and enqueue.

## Stacked regression repair and handoff (2026-08-27)

After PR #5079 merged, upstream/main advanced to
`893d0a17ed47b7f6c4f7084cc532adf250e80275`. The first merge-group candidate
for this PR used synthetic head `77e9132303e7b1239b7fe2e94789188a0097f06c`
and failed the required quality job `98659868552` in run `33112846540`.
Lint reported `noRedeclare` and TypeScript reported TS2300 for duplicate
`emitSymbolArgToNumberThrow` imports in this file: line 133 from #4779 and
line 136 from #4783. Format passed. The Test262 run `33112846318` was
cancelled after this fail-fast quality failure, so it produced no aggregate
or regression verdict; Differential `33112846321` and CLA `33112846093`
passed. This is a genuine stacked source conflict, not runner
infrastructure: both PRs added the same helper import while their other
call sites can share one binding.

The isolated branch was refreshed by the non-rewriting merge commit
`9c9b6cee` from current origin/main. The repair removes only the duplicate
`#4783` import and retains the original `#4779` binding; all four call sites
continue to use that shared import. No lowering, test, workflow, or harness
behavior changes are included in this repair.

The PR body and checked CLA statement remain unchanged. PR #5073 stays
non-draft with `hold` and outside the merge queue until the repaired head's
PR checks are green. After local and PR validation, remove `hold` through the
REST label endpoint, verify the label is gone and the exact body/head remain,
then enqueue once and require fresh merge-group CI, Differential, every
Test262 shard, merged report, and regression gate before merge.

## Post-repair validation (2026-08-27)

The exact one-row harness run passed in both lanes with structural controls:
host **1/1 pass** and standalone **1/1 pass**, with no failure, compile
error, timeout, or skip. The focused regression suite remains **4/4 passed**
with `TEST262_WORKERS=2`. The two row artifacts are
`.tmp/issue-4779-repair-host.jsonl`
(`eb6ca9a1821717281dc3ee7fe905c68754e459b26929d1461fcbd97e9f96ed57`) and
`.tmp/issue-4779-repair-standalone.jsonl`
(`2fc26a3e448742646bff5228ab589e4e32cf005bb42977bdf87811bdc2a77412`).

TypeScript 7, TypeScript 5.9, full Biome lint, full Prettier check,
`git diff --check`, oracle ratchet, and issue integrity all passed. The
unoptimized differential corpus measured **114/120 matches**; its delta gate
reported **0 new regressions** and two improvements against the 99/104 frozen
baseline. The optimized corpus also measured **114/120 matches**, and the
optimizer outcome gate reported **0 regressions** against the unoptimized
lane. The six non-match rows are the same in both differential outputs and
remain existing corpus coverage outside this bounded fix; the local
optimizer emitted Binaryen assertion text on two rows but did not
change any outcome or the zero-regression gate.

The committed repair therefore has one source-line deletion, one merge-group
conflict record, and no new behavioral or differential regression. The normal
pre-push hook must still pass on this committed tree before publishing the
checkpoint; keep `hold` until the fresh PR checks complete.

## Latest upstream refresh (2026-08-27)

After the initial repaired-head PR checks passed, upstream/main advanced to
`1bf5aa171727d2acfcf7710b8e945182eb99169d` (PR #5081). The branch was
synchronized to that exact tip by non-rewriting merge commit `d9c6bbeb`.
The merge introduced no additional change in the repaired call-receiver file:
`emitSymbolArgToNumberThrow` remains a single import from the #4779 helper,
with all four existing call sites sharing that binding. The PR remains
non-draft, held, and outside the merge queue while this refreshed tree is
validated and published.

## Latest upstream validation (2026-08-27)

On the refreshed head, the exact one-row harness again passed in both lanes:
host **1/1** and standalone **1/1**, with no failures, compile errors,
timeouts, or skips. The focused #4779 regression suite reports **4/4 passed**
with `TEST262_WORKERS=2`. The latest row artifacts are
`.tmp/issue-4779-latest-host.jsonl`
(`eb6ca9a1821717281dc3ee7fe905c68754e459b26929d1461fcbd97e9f96ed57`) and
`.tmp/issue-4779-latest-standalone.jsonl`
(`2fc26a3e448742646bff5228ab589e4e32cf005bb42977bdf87811bdc2a77412`).

TypeScript 7 and 5.9, full Biome lint, full Prettier check, `git diff --check`,
oracle ratchet, and issue integrity all pass. The unoptimized differential
corpus remains **114/120 matches**; its delta gate reports **0 new
regressions** and two improvements against the 99/104 frozen baseline. The
optimized corpus also remains **114/120 matches**, and its outcome gate reports
**0 regressions**. The optimizer emitted assertion text on two existing rows,
but both lanes have identical outcomes and the gate is green.

## Final upstream handoff (2026-08-27)

Upstream/main advanced once more to `220ce6c4913ddb10e6af0417dcf4d3aef6470220`
(PR #5082). The branch now contains the non-rewriting sync checkpoint
`27782f9e` with Thomas authorship and the Codex trailer. The exact row was
rerun after that merge: host **1/1 pass** and standalone **1/1 pass**, with
structural controls passing and no failures, compile errors, timeouts, or
skips. The final artifacts are
`.tmp/issue-4779-final-host-after-5082.jsonl`
(`eb6ca9a1821717281dc3ee7fe905c68754e459b26929d1461fcbd97e9f96ed57`) and
`.tmp/issue-4779-final-standalone-after-5082.jsonl`
(`2fc26a3e448742646bff5228ab589e4e32cf005bb42977bdf87811bdc2a77412`).

The normal pre-commit hook also reran the focused regression (**4/4 passed**)
with `TEST262_WORKERS=2` and the oracle ratchet. The branch is ready to push
only after the normal pre-push checks pass; retain `hold` and keep it outside
the queue until the fresh PR checks are green.
