---
id: 5263
title: "Standalone multi-source prepared callables record ZERO direct body receipts — `body-emission-evidence` invariants red on main (6 tests skipped in issue-3525)"
status: done
completed: 2026-09-03
sprint: current
created: 2026-09-01
updated: 2026-09-03
# 2026-09-03 (#5263): +11 lines in the barrel are the `ownedElsewhereUnitIds`
# set construction and the comment naming why reconcile must not see these
# units. The set is assembled from two `ctx.irProgram*` fields that live only on
# the codegen context, at the single call site that owns the reconcile inputs —
# moving it to a subsystem module would export context plumbing to buy back
# eleven lines. Measured: 14740 -> 14751.
loc-budget-allow:
  - src/codegen/index.ts
priority: high
horizon: m
complexity: M
feasibility: medium
reasoning_effort: high
task_type: bug-fix
area: ir, codegen, tests
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r4
related: [3521, 3523, 3525, 5262]
---

# Standalone multi-source prepared callables record zero direct body receipts

## Problem

Six tests in `tests/issue-3525-multi-prepared-callable-bindings.test.ts` fail on
`main` with `body-emission-evidence` invariants of the form:

```
<unitId> fell back to direct emission without exactly one direct body receipt (observed 0)
```

for every callable in a standalone multi-source graph — e.g. `add` in
`dep.ts`, `run` in `entry.ts`, and all five units of the same-spelled-provider
component. The compile reports `success: false`.

Either the units genuinely fall back without entering an audited direct-body
root (a real ownership hole in the M0/M2 prepared-callable route), or the
receipt audit does not see roots it should. Both are worth knowing; the
`observed 0` says the audit counted nothing at all, which points at the second.

## Evidence

Measured 2026-08-31 during #3523 gap 4, by checking BOTH this test file and the
compiler sources out of pristine `origin/main` and re-running: the same six
fail there, identically. They are not a regression from gap 4 — gap 4's row
carries no `unitId` and enters no prepared-callable denominator (recorded as
the consumer-3 evidence in #3523).

Affected tests:

- `stages one exact cross-source component and publishes it after exact body skips`
- `prepares same-spelled providers as one exact five-unit component`
- `prepares the named-default alias matrix with exact five-unit ownership`
- `publishes two disjoint components together and rejects a stale second scope with a zero prefix`
- `keeps the sibling component publishable when the left component fails preparation`
- `keeps the sibling component publishable when the right component fails preparation`

They were **skipped** by #3523 gap 4 with the measurement recorded inline,
because gap 4 had to touch the file for the terminal/non-executable partition
and touching it pulls the file into the required `quality` gate.

## Acceptance criteria

1. Root-cause named: whether the direct-body roots are missing or unaudited.
2. The six tests are **un-skipped** and pass, with their assertions unchanged in
   intent (they pin exact five-unit ownership; do not weaken them to counts).
3. `pnpm run check:ir-only` stays READY; `tests/issue-3523-*` stay green.

## Notes

The `unresolved-legacy-entry` violation on the whole-program `__module_init`
(`compileModuleInitBody __module_init has no exact source/unit/class identity`)
is a SEPARATE, also-pre-existing finding measured in the same session; it
belongs to #3523 gap 1, not here.

---

## Implementation Plan

Written 2026-09-03 (architect lane). Figures labelled **measured** were produced
in a worktree at `origin/main` `bee5ddd535`.

### Shared vocabulary — R2 accounting cluster (#5262 / #5263 / #5282 / #5283)

Identical block in all four plans. Use these words; they are not synonyms.

| term | meaning |
| --- | --- |
| **direct receipt** | one `compileFunctionBody` entry indexed by `IrBodyRouteAuditSession.#indexDirectFunctionBodyReceipt` (`src/codegen/legacy-body-audit.ts:303`). The ONLY source of `directBodyEmissions`. Recorded **only** for top-level free-function terminals; every other unit kind is dropped at `:312`. |
| **physical root** | any `IrLegacyBodyEntry` carrying a `unitId` — a superset of direct receipts that also includes `compileClassBodies`, `compileModuleInitBody`, `compileStatement`, `compileExpression`. This is what `snapshot()`'s `legacyEntryIds` uses. |
| **the triple** | `(prepareAttempts, directBodyEmissions, irBodyEmissions)`. Present **only** on rows in the R2 population; absent (not zero) everywhere else. |
| **R2 population** | `indexR2FreeFunctionPopulations` (`ir-overlay-outcomes.ts:153`) — source-local, public, physical, last-named top-level function declarations with bodies. |
| **accounting arm** | one `if` branch inside `functionBodyAccountingFailure` (`ir-overlay-outcomes.ts:315-358`). |
| **root-cause outcome** | the outcome the precedence chain at `ir-overlay-outcomes.ts:905-967` computed, *before* the accounting block at `:969-978` runs. |
| **owned-elsewhere unit** | a terminal whose ledger row is minted by the prepared-callable publication path, not by `reconcileIrOverlayOutcomes`. This issue is about exactly those units. |

### Root cause — measured, and it is NEITHER of the two hypotheses in the issue

The issue offers two candidates: "the direct-body roots are missing" or "the
receipt audit does not see roots it should". **Both are refuted.** The roots are
correctly absent, the audit correctly counts zero, and the ledger row is
correct. What leaks is the **diagnostic**, for a row that is thrown away.

Measured with a gitignored probe reproducing the first failing test's fixture
(`dep.ts` / `entry.ts`, `target: "standalone"`, `experimentalIR`,
`trackIrOutcomes`), reading `CompileResult` directly:

```
success = false
errors  = [ "error: IR outcome invariant [body-emission-evidence] for add: … observed 0",
            "error: IR outcome invariant [body-emission-evidence] for run: … observed 0" ]

irOutcomes:
  add : kind=emitted  legacyBodyEmitted=false irBodyEmitted=true
        preparedComponentId="prepared-component:…dep.ts…+…entry.ts…"
  run : kind=emitted  legacyBodyEmitted=false irBodyEmitted=true  (same component)
  <module-init> ×2 : kind=non-executable

irBodyRouteAudit.legacyEntries = [ compileDeclarations:dep.ts:-, compileDeclarations:entry.ts:- ]
irBodyRouteAudit.violations    = []
```

Read that carefully: **the ledger says the right thing** (`emitted`,
`irBodyEmitted: true`, one shared `preparedComponentId`), the route audit is
clean, and there are genuinely no direct-body roots for `add`/`run` — correct,
because they were prepared. Yet the compile fails on two errors describing rows
that are not in `irOutcomes` at all.

The mechanism is in `src/codegen/index.ts`, `recordObservedIrOutcomes`:

- `:2516-2518` — rows for `ctx.irProgramCallablePreparedUnitIds` are excluded
  from `existingOutcomes`.
- `:2541-2551` — the reconciled rows for those same unit ids are **filtered out**
  before being pushed to `ctx.irOutcomes`.
- `:2566` — `for (const diagnostic of reconciled.diagnostics) reportErrorNoNode(ctx, diagnostic);`
  — **every** diagnostic is reported, with no such filter.

So `reconcileIrOverlayOutcomes` computes a full row for each owned-elsewhere
unit (precedence chain reaches `late-preparation-unsupported` because the
cross-source prepared callables are not in `preparedSelection`; the accounting
arm at `ir-overlay-outcomes.ts:341` then upgrades it to a
`body-emission-evidence` invariant because `directBodyEmissions === 0`), the row
is discarded, and its diagnostic is reported as a hard error.

The `observed 0` in the message is therefore **correct and expected**, not a
symptom. The unit did not take the direct route because it was prepared.

Same-run control: the identical compile **without** the
`JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY` stub fails identically, so the
poison stub is not implicated.

### Changes

**File: `src/codegen/ir-overlay-outcomes.ts`**

1. `ReconcileIrOverlayOutcomesInput` (`:43-69`) — add:

   ```ts
   /**
    * (#5263) Terminals whose ledger row is minted by the prepared-callable
    * publication path, not here. Reconcile must produce NEITHER a row nor a
    * diagnostic for them: it cannot see the cross-source preparation, so every
    * conclusion it reaches about them is stale by construction.
    */
   readonly ownedElsewhereUnitIds?: ReadonlySet<IrUnitId>;
   ```

2. `reconcileIrOverlayOutcomes` (`:866`) — first statement of the per-unit loop:

   ```ts
   if (input.ownedElsewhereUnitIds?.has(unit.unitId)) continue;
   ```

   Skip the whole unit, not just the diagnostic push. Computing a row you then
   discard is what produced this bug; do not leave a second copy of that pattern.

**File: `src/codegen/index.ts`**

3. `recordObservedIrOutcomes` (`:2505-2567`) — build the set once and pass it:

   ```ts
   const ownedElsewhereUnitIds = new Set<IrUnitId>([
     ...(ctx.irProgramCallablePreparedUnitIds ?? []),
     ...(ctx.irProgramPreparedModuleInitUnitId ? [ctx.irProgramPreparedModuleInitUnitId] : []),
   ]);
   ```

   Pass it into `reconcileIrOverlayOutcomes`. **Keep** the existing post-filters
   at `:2516-2518` and `:2541-2551` — they become no-ops for these ids but still
   guard the `existingOutcomes` duplicate check, and removing them in the same
   change would conflate two behaviours.

Nothing in `src/ir/`, `multi-prepared-callable-publication.ts` or
`multi-prepared-program.ts` needs to change. **Do not** relax
`functionBodyAccountingFailure` — that arm is a live detector (see the
anti-greenwash criterion below), and **do not** touch
`src/codegen/ir-prepared-free-functions.ts` (#5282's file, R2-T1's contract).

### Second, real finding — file separately, do NOT fix here

The published prepared-callable rows carry **no triple at all**:
`directBodyEmissions` and `irBodyEmissions` are absent on the `add`/`run` rows
above, even though the truthful values are `(1, 0, 1)`. That is a genuine
accounting gap in the publication path and it feeds every R9 denominator, but
fixing it is a different change in a different file
(`multi-prepared-callable-publication.ts`), and doing it here would make this
PR's diff impossible to review against the six red tests. File it as a
follow-up citing this measurement.

### Ordering constraints

- **Land this before or with #5262.** Both edit the same ~20 lines of
  `reconcileIrOverlayOutcomes` and the same block of `recordObservedIrOutcomes`.
  This change should be applied **first** within the shared PR: it removes the
  rows reconcile does not own, which is what makes #5262's precedence change
  reviewable.
- **#5283 lands after** — it edits `legacyBodyEmitted` at `:878-879`, same
  function.
- **#5282 is independent** (different file).

### PR grouping

**One PR with #5262, this change applied first** — same file, same function,
same twenty lines; splitting them guarantees a conflict and makes each half's
non-vacuity argument depend on the other.

### Edge cases

- `ctx.irProgramPreparedModuleInitUnitId` is already used as a row filter at
  `:2546`; including it in the skip set must not suppress the `non-executable`
  row built at `:2559`, which is pushed **after** the filter by contract and
  carries no `unitId`. Verify both module-init rows still appear (measured
  baseline: two `non-executable` rows for this two-source graph).
- A unit that is in `ownedElsewhereUnitIds` **and** genuinely took the direct
  route would now be silently unreported. That state is a real corruption. The
  route audit still catches it (`missing-legacy-entry-evidence` /
  `duplicate-outcome-unit` in `snapshotLegacyBodyAudit`), so it is covered — but
  add an assertion in one of the un-skipped tests that
  `irBodyRouteAudit.legacyEntries` contains no entry for a prepared unit id
  (test `stages one exact cross-source component…` already does exactly this at
  line ~536; keep it).
- Single-source lanes: `irProgramCallablePreparedUnitIds` is empty there, so the
  set is empty and behaviour is byte-identical. Confirm with
  `pnpm run check:ir-only`.

### Acceptance measurements

1. `npm test -- tests/issue-3525-multi-prepared-callable-bindings.test.ts` with
   all six `it.skip` / `it.skip.each` restored to `it` — **52 passed**. Measured
   before the fix: **6 failed / 46 passed**, all six with
   `body-emission-evidence … observed 0`.
2. The six tests' assertions unchanged in intent — they pin exact five-unit
   ownership; do not weaken to counts.
3. `pnpm run check:ir-only` READY, `scripts/ir-only-baseline.json` unchanged.
4. `npm test -- tests/issue-3523-*` green.
5. **Non-vacuity:** revert change (2) alone (drop the `continue`) and confirm the
   six tests go red again with the same message.
6. **Anti-greenwash (mandatory):** the six tests must go green because reconcile
   stopped owning those rows, **not** because the accounting arm at
   `ir-overlay-outcomes.ts:341` was weakened. Prove it by keeping one fixture
   where a non-prepared `unsupported` free function with zero direct receipts
   still produces a `body-emission-evidence` invariant. If that fixture goes
   green too, the fix is in the wrong place.

---

## Resolution

Landed 2026-09-03 with #5262 in one PR, this change applied first. The plan's
root cause held on every point; nothing in it needed correcting.

### What changed

- `ReconcileIrOverlayOutcomesInput` gained `ownedElsewhereUnitIds`, and
  `reconcileIrOverlayOutcomes` `continue`s past those units at the top of its
  per-unit loop — skipping the whole unit, not just the diagnostic push.
- `recordObservedIrOutcomes` builds that set from
  `ctx.irProgramCallablePreparedUnitIds` ∪ the prepared module-init id. The
  existing post-filters were **kept**: they are now no-ops for these ids but
  still guard the `existingOutcomes` duplicate check.

### Measured

| measurement | before | after |
| --- | --- | --- |
| `tests/issue-3525-…` (all six un-skipped) | 6 failed / 46 passed | **52 passed** |
| `check:ir-only` verdict | READY | READY (both lanes measured) |
| `scripts/ir-only-baseline.json` | — | unchanged |
| published outcome rows, 34-case corpus | 188 | 188, **zero row deltas** |
| corpus compiles succeeding | 31 / 34 | **34 / 34** |
| `body-emission-evidence` errors on corpus | 9 | **0** (none added) |
| wasm sha256 over cases that produced bytes on base | — | **31 / 31 identical** |

The zero row-delta is the confirmation of the diagnosis: reconcile's rows for
these units were **already** discarded by the filters at the call site, so
publication never saw them. Only the diagnostic leaked, and only the diagnostic
disappears. The three cases that moved off `<no-binary>` are compiles that
previously failed outright and now emit; no case that produced bytes on base
produced different bytes after.

**Non-vacuity (measured):** dropping the `continue` alone returns exactly the
same six tests to red with the identical `observed 0` message.

**Anti-greenwash (measured):** `tests/issue-5262-accounting-precedence.test.ts`
pins that a non-prepared `unsupported` row with zero direct receipts is still
REPLACED with a `body-emission-evidence` invariant — the detector was not
weakened. The pre-existing duplicate/foreign/missing-receipt pins in
`tests/issue-3520-outcome-correlation-identity.test.ts` also stay green.

### Follow-up found and deliberately NOT fixed here (measured)

Published prepared-callable rows carry **no `(prepareAttempts,
directBodyEmissions, irBodyEmissions)` triple at all** — the field is absent,
not zero — even though the truthful values are `(1, 0, 1)`. This is an
**R9-denominator gap**: every ratio computed over the R2 population silently
omits these units. The fix belongs in
`src/codegen/multi-prepared-callable-publication.ts`, a different file and a
different owner, and doing it here would have made this PR's diff unreviewable
against the six red tests.

**It has no issue id yet.** `claim-issue.mjs --allocate` reported its open-PR
scan DEGRADED (gh unauthenticated in this container), and a reservation made off
a degraded scan must not be handed out as clean — so no id was burned. Filing it
needs one `--allocate` from an authenticated lane.
