---
id: 5262
title: "R2 body-emission accounting OVERWRITES the root-cause outcome code — an injected internal throw is reported as `body-emission-evidence`, not `unexpected-internal-throw` (5 tests skipped in issue-3519)"
status: done
completed: 2026-09-03
sprint: current
created: 2026-09-01
updated: 2026-09-03
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
related: [3519, 3521, 3523, 3565, 4502]
---

# R2 body-emission accounting overwrites the root-cause outcome code

## Problem

In `reconcileIrOverlayOutcomes` (`src/codegen/ir-overlay-outcomes.ts`) the R2
body-emission accounting check runs **last** and unconditionally replaces the
outcome that the preceding precedence chain computed:

```ts
if (bodyAccounting) {
  accountingFailure = functionBodyAccountingFailure({ ... });
  if (accountingFailure) outcome = observedFailure(base, accountingFailure);
}
```

When a unit fails for a real, already-classified reason and then falls back to
direct emission, `functionBodyAccountingFailure` (`:339`) fires:

```ts
if (input.outcome.kind === "invariant" && input.accounting.directBodyEmissions !== 0) {
  return bodyEmissionInvariant(
    `${unitId} reached an R2 invariant after ${n} direct body receipts; ` +
      "a fatal prepared owner may retain only zero or one exact IR patch receipt",
  );
}
```

so the recorded `code` becomes `body-emission-evidence` and the ROOT CAUSE
(`unexpected-internal-throw`, `missing-terminal-outcome`) is lost. The row is
still fail-closed — an `invariant` either way — so nothing mis-compiles; what
is lost is the diagnosis, which is the whole point of the typed-outcome ledger
(#3519).

Note also that the message and the condition disagree: the text says "may
retain only zero or one exact IR patch receipt" while the guard rejects
`directBodyEmissions !== 0`. Part of this issue is deciding which is intended.

## Evidence

Measured 2026-08-31 on pristine `origin/main` (both the test file and the
compiler sources taken from main), during #3523 gap 4:

| expected `code` | actual `code` |
| --- | --- |
| `unexpected-internal-throw` | `body-emission-evidence` |
| `missing-terminal-outcome` | `body-emission-evidence` |

Five tests in `tests/issue-3519-ir-outcomes.test.ts` assert the root-cause code
and fail on main because of this:

- `counts only executable overload implementations and ignores ambient signatures`
- `does not demote an unexpected Promise final-registration throw`
- `does not demote unexpected imported-call planning throws`
- `routes iterator registration throws through the owning source outcome`
- `turns an actual missing integration terminal into a reconciliation invariant`

They were **skipped** (`it.skip`, with the measurement recorded inline) by
#3523 gap 4, because gap 4 had to touch that file and touching a file pulls it
into the required `quality` gate's changed-root step. They were deliberately
NOT re-pointed at the current code: the tests are named "does not demote …",
so asserting the masked code would turn a red flag into a green lie.

## Why it was not caught earlier

`tests/issue-3519-ir-outcomes.test.ts` is only run when a PR touches it (see
#5259 and #5265). It has been red on main for some time with every gate green.

## Acceptance criteria

1. Decide and document the intended precedence: either the accounting check
   only fires when it is the FIRST failure for the unit, or it composes
   (root cause retained, accounting recorded alongside) — not silent overwrite.
2. Resolve the condition/message mismatch at `:339`.
3. The five tests above are **un-skipped** and pass asserting the root-cause
   code, unchanged in intent.
4. No new `body-emission-evidence` regressions: `pnpm run check:ir-only` stays
   READY and `tests/issue-3523-*` stay green.

## Out of scope

The M0-owner receipt defect behind the `issue-3525` skips (#5263) — same
violation code, different trigger.

---

## Implementation Plan

Written 2026-09-03 (architect lane). Every figure below labelled **measured**
was produced in a worktree at `origin/main` `bee5ddd535`; anything labelled
**reasoned** was derived by reading the source and is NOT a measurement.

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
| **owned-elsewhere unit** | a terminal whose ledger row is minted by the prepared-callable publication path, not by `reconcileIrOverlayOutcomes`. See #5263. |

### Root cause

`reconcileIrOverlayOutcomes` computes the root-cause outcome, then at
`src/codegen/ir-overlay-outcomes.ts:969-978` calls `functionBodyAccountingFailure`
and **unconditionally replaces** the outcome with whatever it returns. The
accounting arm at `:351` fires on `outcome.kind === "invariant" &&
directBodyEmissions !== 0` — but *any* unit that reached an invariant after
legitimately falling back to the direct route has `directBodyEmissions === 1`,
so that arm fires on the normal case and overwrites the diagnosis.

The condition/message mismatch at `:351-355` resolves in one direction: the
message ("a fatal prepared owner may retain only zero or one exact IR **patch**
receipt") describes a bound on `irBodyEmissions`, and that bound is **already
enforced upstream** at `:302-304`, where `reconcileR2FunctionBodyEmissionAccounting`
turns `irBodyEmissions > 1` into a `receiptFailure`. The arm as written checks
a different quantity, adds no coverage, and its only effect is the masking.
**Reasoned, not measured** — the implementer should confirm by deleting the arm
and checking that no suite loses a red.

### Measured current behavior

`tests/probe-5262-outcomes.test.ts` = `tests/issue-3519-ir-outcomes.test.ts`
with `it.skip` → `it` (gitignored probe copy). **5 failed / 25 passed**, which
matches the issue's count — but **not** its attribution:

| test | expected `code` | actual | masked by the accounting arm? |
| --- | --- | --- | --- |
| `turns an actual missing integration terminal into a reconciliation invariant` | `missing-terminal-outcome` | `body-emission-evidence` | **yes** |
| `routes iterator registration throws through the owning source outcome` | `unexpected-internal-throw` | `body-emission-evidence` | **yes** |
| `does not demote an unexpected Promise final-registration throw` | `unexpected-internal-throw` | `body-emission-evidence` | **yes** |
| `does not demote unexpected imported-call planning throws` | `unexpected-internal-throw` | `body-emission-evidence` | **yes** |
| `counts only executable overload implementations and ignores ambient signatures` | (asserts `success === true`) | `success === false` | **NO — different bug** |

**Premise correction (measured).** The fifth test is not an accounting-precedence
failure. It fails with:

```
ir/from-ast: direct call to "overloaded" has no exact AST-site plan in run [IR-FALLBACK]
IR-first (#2138): run failed after its legacy body was skipped … [unpatched-slot]
IR outcome invariant [unpatched-slot] for run
```

`run` calls an **overloaded** function; the IR from-AST lowering cannot resolve
the call site to the implementation signature, the legacy slot was already
skipped, and the row fails closed as `unpatched-slot`. Nothing in
`functionBodyAccountingFailure` is involved. **Do not expect this issue's fix to
un-skip that test.** Either (a) file the overload call-site planning gap
separately and leave that one `it.skip` with a pointer, or (b) fix it here as an
explicitly-scoped second change. Recommendation: (a) — it is a `from-ast`
lowering defect, a different owner and a different lane.

So the honest acceptance is **4 of 5 un-skipped**, not 5.

Also measured: the exact overwrite text for the `missing-terminal-outcome` case
is
`… reached an R2 invariant after 1 direct body receipts; a fatal prepared owner may retain only zero or one exact IR patch receipt`
with `directBodyEmissions: 1, irBodyEmissions: 0, legacyBodyEmitted: true`. A
row with `(1, 0)` and an invariant root cause is the **normal** fall-back shape,
which is the clearest single proof that the arm's condition is wrong.

### Changes

**File: `src/codegen/ir-overlay-outcomes.ts`**

1. `functionBodyAccountingFailure` (`:315-358`) — **delete the arm at `:351-356`**
   (`outcome.kind === "invariant" && directBodyEmissions !== 0`). Replace it with
   a comment naming #5262 and stating that the `irBodyEmissions` bound the old
   message described is enforced at `:302-304`, and that a fall-back-then-invariant
   row legitimately carries `directBodyEmissions === 1`.

   If the implementer instead concludes the arm *should* survive in a corrected
   form, the only defensible form is `irBodyEmissions > 1` — and then it must be
   deleted from `reconcileR2FunctionBodyEmissionAccounting` so the check lives in
   exactly one place.

2. `reconcileIrOverlayOutcomes` (`:969-978`) — make the write **non-destructive
   for outcomes that are already invariants, and only for those**:

   ```ts
   let accountingFailure: IrPreparationFailure | undefined;
   let accountingApplied = false;
   if (bodyAccounting) {
     accountingFailure = functionBodyAccountingFailure({ … });
     if (accountingFailure && outcome.kind !== "invariant") {
       outcome = observedFailure(base, accountingFailure);
       accountingApplied = true;
     } else if (accountingFailure) {
       // (#5262) Root cause wins. The accounting evidence rides alongside by
       // spread, exactly like `r2Withdrawal` (#3521 R2-T1): `IrObservedOutcome`
       // is unchanged and no emitter reads the field.
       outcome = { ...outcome, bodyAccountingFailure: accountingFailure };
     }
   }
   ```

   **This asymmetry is load-bearing — do not simplify it to "never overwrite".**
   The accounting arms that fire on `emitted` / `unsupported` rows are the ONLY
   detector for a unit that took neither route or both; #5263's six red tests are
   exactly that detector firing. A blanket "attach, never replace" would leave
   those rows `unsupported`, drop them out of the `outcome.kind === "invariant"`
   diagnostic push at `:986`, and turn a real red into silence. State this in the
   code comment.

3. `:981-988` — the `unchangedReportVisibleInvariant` guard currently keys on
   `accountingFailure === undefined`. Change it to `!accountingApplied`, or a
   report-visible invariant that now merely *carries* an accounting note stops
   being recognised and starts double-reporting into `diagnostics`.

4. When an accounting failure is attached but not applied, still push a
   diagnostic naming it — the evidence must not vanish from the diagnostic
   channel just because it lost the `code` slot. Suggested shape, appended after
   the existing invariant push:
   `IR body-emission accounting note for ${unit.matchName}: ${accountingFailure.detail}`.

**File: `src/ir/r2-withdrawal.ts` (or a sibling)** — if the attached field is
introduced, follow the `IrObservedOutcomeWithR2Withdrawal` precedent exactly:
a widened type plus a single reader function, with `IrObservedOutcome` itself
untouched. Do **not** add the field to `src/ir/outcomes.ts` (that file is
#3520's and its row type is contractually byte-identical).

**Do not touch** `src/codegen/ir-prepared-free-functions.ts` (that is #5282's
file and R2-T1's contract) or `src/ir/module-init.ts` / the identity scanner
(#5283's).

**File: `tests/issue-3519-ir-outcomes.test.ts`** — un-skip the four
accounting-masked tests with their assertions unchanged. Leave the overload test
skipped, and **rewrite its skip comment** to name the real cause
(`from-ast` overload call-site planning) and the new issue id, so the next reader
is not sent here again.

### Ordering constraints

- **#5263 must land before or with this.** Both edit `reconcileIrOverlayOutcomes`
  and `recordObservedIrOutcomes`; #5263 removes owned-elsewhere units from the
  loop this change modifies. Landing #5262 first makes #5263 a textual conflict
  in the same 20 lines.
- **#5283 must land after this.** It edits `legacyBodyEmitted` at `:878-879` in
  the same function.
- **#5282 is independent** — different file entirely
  (`ir-prepared-free-functions.ts`), no shared symbol.

### PR grouping

**Ship #5262 and #5263 as ONE PR, with #5263's change applied first** — they
touch the same 20 lines of `reconcileIrOverlayOutcomes` and the same block of
`recordObservedIrOutcomes`, and #5262's precedence change is only safe once
#5263 has removed the rows reconcile does not own.

### Edge cases

- A row that is invariant **and** has a genuine `receiptFailure` (duplicate or
  foreign direct receipt): the root cause still wins the `code` slot, but the
  receipt corruption must remain visible in `diagnostics`. Verify with a
  hand-built duplicate receipt.
- `evidence.kind === "failed"` with `diagnosticVisibility === "report"`: the
  dedup guard at `:981` must not regress. Add a targeted assertion.
- Multi-source: the same reconcile runs per source; the attached field must
  survive the `.map()` at `src/codegen/index.ts:2548` that rebuilds module-init
  rows with `moduleBindingRefusals` (a spread, so it does — confirm).

### Acceptance measurements

1. `npm test -- tests/issue-3519-ir-outcomes.test.ts` — the four
   previously-skipped tests un-skipped and green; the overload test still skipped
   with a corrected comment naming its real cause.
2. `npm test -- tests/issue-3523-*` green (no change).
3. `pnpm run check:ir-only` still READY; `scripts/ir-only-baseline.json`
   unchanged (this issue must not move a single count — it changes which `code`
   a row carries, never `kind`).
4. Non-vacuity: revert change (1) alone (restore the deleted arm) and confirm the
   four un-skipped tests go red again. Record it in the PR.
5. Anti-greenwash: with #5263's change in the same PR, confirm the six
   `issue-3525` tests are green **because reconcile no longer owns those rows**,
   not because the accounting arm stopped upgrading `unsupported` rows — prove it
   by keeping one hand-built `unsupported`-with-zero-receipts fixture red.

---

## Resolution

Landed 2026-09-03 with #5263 in one PR, applied second. The plan's premise
correction (4 of 5, not 5) was confirmed independently; one of its predictions
was **not** confirmed and is corrected below.

### What changed

1. **Deleted** the accounting arm that fired on
   `outcome.kind === "invariant" && directBodyEmissions !== 0`, with a comment in
   its place naming #5262 and recording that the `irBodyEmissions` bound its
   message described is enforced upstream in
   `reconcileR2FunctionBodyEmissionAccounting`.
2. **Made the write asymmetric**: an accounting failure REPLACES the outcome only
   when the root cause is not already an invariant; otherwise it is attached by
   spread as `bodyAccountingFailure`, following the `r2Withdrawal` precedent
   (#3521 R2-T1) — new sibling `src/ir/body-accounting-note.ts` carries the
   widened type and its single reader; `src/ir/outcomes.ts` is untouched.
3. The `unchangedReportVisibleInvariant` dedup guard now keys on
   `!accountingApplied` rather than on the failure merely existing.
4. An attached-but-not-applied failure still pushes
   `IR body-emission accounting note for <unit>: <detail>` into `diagnostics`, so
   the evidence keeps a channel after losing the `code` slot.

### Measured

| measurement | before | after |
| --- | --- | --- |
| `tests/issue-3519-…` (four masked tests un-skipped) | 5 failed / 25 passed | **29 passed / 1 skipped** |
| the four root-cause codes | all `body-emission-evidence` | `missing-terminal-outcome`, `unexpected-internal-throw` ×3 |
| `check:ir-only` verdict | READY | READY |
| `scripts/ir-only-baseline.json` | — | unchanged |
| published outcome rows, 34-case corpus | 188 | 188, **zero row deltas beyond #5263's** |
| `check:ir-kind-neutrality` verdict table | 55 neutral · 27 js · 3 unresolved | **identical** (accounting-only change moved nothing) |

### Correction to the plan's non-vacuity prediction (measured)

The plan expected that reverting change (1) alone would return the four tests to
red. **It does not — they stay green.** The converse also holds: reverting
change (2) alone leaves them green too. The two changes are *independently
sufficient* for this population, because once precedence is asymmetric the arm's
return value is only ever attached as a note, and once the arm is gone there is
nothing to attach. Non-vacuity is therefore a property of the pair: reverting
**both** restores the base red (measured — 5 failed on pristine `origin/main`).

That makes change (1) look optional, so it was justified separately rather than
assumed. **Measured**: with the arm restored and change (2) in place, every
normal fall-back-then-invariant row gains an extra, *false* diagnostic —

```
IR body-emission accounting note for delay: … reached an R2 invariant after 1
direct body receipts; a fatal prepared owner may retain only zero or one exact
IR patch receipt
```

on a row whose `irBodyEmissions` is `0`. Non-warning diagnostics went 2 → 3
(`missing-terminal.ts`) and 1 → 2 (`iterator-registration.ts`). `(1, 0)` with an
invariant root cause is the NORMAL fall-back shape, so keeping the arm converts
the old masking bug into a diagnostic-noise bug. Deleting it also resolves the
condition/message mismatch this issue asked about (acceptance criterion 2), in
the direction the plan named: the message described `irBodyEmissions`, which is
already bounded upstream, so the arm added no coverage and lost no red.

### Fifth test — NOT fixed, and no longer blamed on this issue

`counts only executable overload implementations and ignores ambient signatures`
stays skipped. Re-measured 2026-09-03 with this fix applied, it fails on:

```
ir/from-ast: direct call to "overloaded" has no exact AST-site plan in run
IR-first (#2138): run failed after its legacy body was skipped [unpatched-slot]
IR outcome invariant [unpatched-slot] for run
```

`run` calls an overloaded function; the IR from-AST lowering cannot resolve the
call site to the implementation signature. Nothing in
`functionBodyAccountingFailure` participates. Its skip comment was rewritten in
place to say exactly this, so the next reader is not sent back here.

**It has no issue id yet** — `claim-issue.mjs --allocate` reported its open-PR
scan DEGRADED (gh unauthenticated in this container), and an id reserved off a
degraded scan must not be handed out as clean. Filing needs one `--allocate`
from an authenticated lane.

### Pins added

`tests/issue-5262-accounting-precedence.test.ts` (3 tests) drives
`reconcileIrOverlayOutcomes` directly and pins:

- (#5263) a unit in `ownedElsewhereUnitIds` yields neither row nor diagnostic,
  with the same call **without** the set asserted to yield both — the control and
  the treatment in one test.
- (#5262) a non-invariant row that fails accounting is still REPLACED — the
  asymmetry guard. This is the anti-greenwash fixture #5263 required.
- (#5262) an invariant row with a duplicate direct receipt keeps its root-cause
  `code`, carries the note, and still surfaces it in `diagnostics`.

The third pin is measurably non-vacuous: restoring the destructive write turns it
red on its own.
