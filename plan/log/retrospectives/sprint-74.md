# Sprint 74 retrospective

**Window:** 2026-07-21

**Target release:** v0.65.0, cut from the closed sprint boundary

## Outcome

Sprint 74 delivered the R0 truth boundary for the IR-only migration. #3519
replaced message-based fallback policy with typed terminal outcomes and an
honest, denominator-bearing `check:ir-only` gate. #3529 then recovered the full
equivalence suite after that boundary exposed 154 previously demoted compile
failures: expected capability gaps became explicit typed Unsupported outcomes,
while real producer and pass invariants were fixed.

Full equivalence closed with **zero new failures** and no baseline expansion.
One baseline-known case now passes but was deliberately left unratcheted in
this recovery slice. The bounded hybrid lane is green at **31 / 37 IR-emitted
units**, with six typed Unsupported units, zero Invariants, and complete unit
accounting. Strict remains intentionally non-green on those six typed blockers
and the separately reported 37 legacy-emitted bodies; R0 does not claim that
the compiler is IR-only.

PR #3483's merge-group differential workflow exposed one release-boundary
regression that branch protection did not block: inferred mutually recursive
boolean returns lost their i32 brand before an `externref` console call, moving
the corpus from 99 / 104 to 98 / 104. Follow-up PR #3486 fixed the producer
seam with the canonical `__box_boolean` helper and restored 99 / 104 without
widening either the differential or equivalence baseline.

## Process lessons

- Run full equivalence early when changing failure classification: focused
  outcome tests did not reveal the full producer-capability population.
- Classify expected gaps at their producer seam and keep unknown throws fatal;
  do not recover parity by matching messages or widening a failure baseline.
- Publish denominators and the strict blocker set with every gate result. A
  green hybrid policy is evidence of honest fallback, not strict readiness.
- Keep baseline cleanup separate from recovery work; the one newly passing
  known case can be ratcheted without obscuring the zero-regression result.
- Treat an advisory differential failure as release-blocking evidence even
  when branch protection permits the queue merge. Close the sprint only after
  the defect is fixed and a fresh merge-group run proves the restored floor.

## Carry-over

#3518 remains open. #3520 is the next ready slice for source-qualified
`IrUnitId` and `ProgramAbiMap`; R2–R8 remain blocked behind R1 and their declared
dependency chain. The v0.65.0 release follows this sprint boundary; execution
pauses after that release is published and verified.

The fresh close harvest mapped all normalized Test262 clusters above 50 rows
to existing Markdown owners except one. Backlog issue #3531 now owns the 216
standalone rows that leak `__array_concat_any`, `__js_array_new`, and
`__js_array_push`.

## Close validation

- PR #3486 merged as `a9b276c0eed97b2ce29b7ccaa29ebc5f4853e08d`,
  which is also the published `sprint/74` tag target.
- Authoritative Test262 merge-group run
  [29857062450](https://github.com/loopdive/js2/actions/runs/29857062450)
  passed at that SHA, including the nonempty merged-report job.
- JS-host closed at **30,282 / 43,099**, unchanged from Sprint 73. Standalone
  closed at **28,149 / 43,106**, a **+13-pass** improvement with no total-count
  change.
