---
id: 5299
title: "Published prepared-callable outcome rows carry NO (prepareAttempts, directBodyEmissions, irBodyEmissions) triple — absent, not zero — so every R9 ratio over the R2 population silently omits them"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
assignee: ttraenkler/opus-5299
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [5263, 5262, 3521, 3525, 3518]
requested_by: ttraenkler/orchestrator
---

# An accounting gap in the publication path, confirmed twice

Flagged in [#5263](5263-multi-prepared-callables-zero-direct-body-receipts.md)'s
Implementation Plan and **confirmed by measurement** in its implementation
(PR #5530): the outcome rows that
`src/codegen/multi-prepared-callable-publication.ts` publishes for
cross-source prepared callables carry no `prepareAttempts`,
`directBodyEmissions` or `irBodyEmissions` fields at all, although the
truthful values for a prepared unit are `(1, 0, 1)` — one preparation, zero
direct (legacy) body receipts, one IR body receipt.

`src/ir/outcomes.ts:335-360` treats the triple as optional and only validates
it when *any* field is present, so an absent triple passes every invariant —
and drops out of every ratio. That is the R9 denominator problem: the
fail-closed flip (#3518 R9) is judged on "share of units whose body came from
the IR", and the population most certain to be IR-emitted is the one not
counted.

#5263 deliberately did not fix this: its diff had to stay reviewable against
the six red `issue-3525` tests, and this is a different change in a different
file.

## Fix

In the publication path, attach the measured triple to each prepared row at
the point the row is built from the component receipt (`component.units` /
`terminalByUnitId`, publication.ts ~lines 171-199). The values are not
constants to hard-code: derive `prepareAttempts` from the component's
preparation receipt, `irBodyEmissions` from the IR patch receipt the R2
accounting already checks (`reconcileR2FunctionBodyEmissionAccounting`), and
`directBodyEmissions` from the direct-body receipt ledger (must be 0 for a
prepared unit — assert, do not assume).

## Acceptance criteria

1. Every published prepared-callable row on the 34-case dogfood/ratchet corpus
   (gc + standalone) carries the triple; measured count of rows with an
   absent triple goes from N (record N on base) to 0.
2. The `body-emission-evidence` invariant and the #5263 `ownedElsewhereUnitIds`
   skip both stay green — adding the triple must not re-admit the rows the
   reconciler no longer owns (`tests/issue-5262-accounting-precedence.test.ts`
   and the six `issue-3525` tests stay green).
3. A pinned test asserts the triple is present and equals `(1, 0, 1)` for a
   prepared unit; red on base.
4. `check:ir-only` — the ratio this feeds — re-measured before/after and the
   delta recorded in the PR body (READY must not regress; a *higher* IR share
   is the expected direction).
5. Byte identity: publication only (no codegen change) — sha256 identical on
   the whole corpus.

## Conflict surface

`src/codegen/multi-prepared-callable-publication.ts`, `src/ir/outcomes.ts`
(only if the optional-triple validation needs tightening). Do not branch until
PR #5530 has merged; it reshapes the reconciler this row set flows through.

## Implementation Plan

Written 2026-09-03 by the Fable lane from a read of
`src/codegen/multi-prepared-callable-publication.ts`, `src/ir/outcomes.ts`,
`src/codegen/ir-overlay-outcomes.ts`, `src/codegen/legacy-body-audit.ts`,
`src/ir/prepared-component-publication.ts` and `src/ir/program.ts` at
`origin/main` after PR #5535 (#5300). Line numbers are from that revision.

### Where the triple is dropped (reasoned from source; confirm in step 1)

The prepared row is built in `prepareCommit`
(`multi-prepared-callable-publication.ts:317-350`): a literal with
`legacyBodyEmitted: false`, `irBodyEmitted: true`, `kind: "emitted"`,
`stage: "patch"` and **no** `prepareAttempts` / `directBodyEmissions` /
`irBodyEmissions`. `hasMalformedBodyEmissionAccounting`
(`src/ir/outcomes.ts:353-370`) returns `false` when all three are `undefined`,
so the row passes every invariant while contributing nothing to any ratio.
The rows land in `ctx.irOutcomes` at `multi-prepared-program.ts:1015`.

The row is built **before** the component tokens are taken (`tokens` loop
starts at `:353`), so at construction time the publication has no patch
count to cite. That ordering is why the triple was never filled, not an
oversight in the literal.

### Sources of truth (do not hard-code `(1, 0, 1)`)

| counter | source | expected for a prepared unit |
| --- | --- | --- |
| `prepareAttempts` | one `pendingReceipt` per component, one `take` per commit — by construction `1`; assert the receipt `kind` and single take, do not count | `1` |
| `irBodyEmissions` | the token's `publicationPatches` (`prepared-component-publication.ts` `ReceiptState.publicationPatches`, one `PreparedComponentDetachedPatch` per terminal unit) — count the patches whose unit is this `unitId` | `1` |
| `directBodyEmissions` | `legacy-body-audit.ts` indexed `countsByUnitId` (`:96`, incremented only on entering `compileFunctionBody`, `:354-364`) — a prepared unit is skipped, so the count must be `0` | `0` |

`src/ir/program.ts`'s `PreparedIrEmissionLedgerEntry` (`:167-175`) is the
#3525 owner-lifecycle ledger with the same triple; it is **not** wired to
this publication path today. Do not route through it in this slice — note
in the PR body whether the two should be unified (R5 M1B territory).

### Change (one file, plus a small export)

1. **Reorder `prepareCommit`**: take the component tokens first (the
   existing `try { … }` at `:353`), then build `finalOutcomes` from the
   taken tokens. The rows are frozen literals either way; only the order of
   the two blocks moves. Abort semantics stay: a failing take still aborts
   every receipt before any row exists.
2. **Expose per-unit patch counts on the token**: add
   `readonly irPatchCountByUnitId: ReadonlyMap<IrUnitId, number>` to
   `PreparedComponentPublicationToken` (`prepared-component-publication.ts:77-82`),
   computed from `publicationPatches` at token creation (read-only
   projection; no behaviour change to `publishBodies`).
3. **Read the direct count** from the audit index the reconciler already
   uses (`legacy-body-audit.ts` — the same `countsByUnitId` that
   `reconcileR2FunctionBodyEmissionAccounting` reads at
   `ir-overlay-outcomes.ts:297`). If it is not `0` for a prepared unit,
   throw `publicationError(...)` — **fail closed**, never publish a row that
   claims IR ownership of a body the direct compiler also emitted.
4. **Emit the triple** on each row and validate it with the existing
   checker before freezing: export `hasMalformedBodyEmissionAccounting`
   from `src/ir/outcomes.ts` (or a thin
   `assertExactBodyEmissionAccounting(outcome)` wrapper) and call it; a
   malformed triple is a `publicationError`.
5. Leave `legacyBodyEmitted` / `irBodyEmitted` as derived booleans
   (`directBodyEmissions === 1`, `irBodyEmissions === 1`), matching
   `ir-overlay-outcomes.ts:308-309`, instead of literals.

Do not touch `reconcileIrOverlayOutcomes` or `ownedElsewhereUnitIds`
(#5263) — the reconciler still skips these units; the publication path now
owns their accounting end-to-end.

### Measurement order

1. **Probe on base** (`.tmp/probe-5299.ts`): compile a two-source program
   with a cross-source prepared callable (reuse the fixture from
   `tests/issue-3525-multi-prepared-callable-bindings.test.ts`) with
   `trackIrOutcomes: true`; print every published row with
   `preparedComponentId` and its three counters. Expected on base: all three
   `undefined` on every prepared row. Count N = rows with an absent triple on
   the 34-case dogfood/ratchet corpus (gc + standalone) — record N.
2. Capture base copies at first edit (`.tmp/base-*.ts`).
3. Implement 1–5. Re-run the probe: every prepared row carries `(1, 0, 1)`;
   N → 0.
4. Byte identity: publication-only change — per-row sha256 over the 34-case
   corpus, gc + standalone, all rows identical (zero moving rows is the
   acceptance bar; any moved row is a defect).
5. `check:ir-only` before/after: report the numbers it prints; READY must
   hold and the emitted share may only rise. `check:ir-fallbacks`,
   `check:ir-dialect`, `check:ir-kind-neutrality` (quote-hash baseline since
   PR #5533, never hand-edited): unchanged.
6. Keep green: `tests/issue-3525-*`, `issue-3519-*`, `issue-3520-*`,
   `issue-5262-*`, `issue-5300-*`.
7. Equivalence, 8 shards by name, `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`, zero
   name-set diff; full ratchet chain + `LOC_GATE_BASE`.

### Tests

`tests/issue-5299-prepared-callable-receipt-triple.test.ts`:

- (a) every published row with a `preparedComponentId` carries
  `prepareAttempts === 1`, `directBodyEmissions === 0`,
  `irBodyEmissions === 1`, and the derived booleans agree — **red on base**
  (fields absent).
- (b) fail-closed: inject a direct receipt for a prepared unit (the audit's
  test seam, or `JS2WASM_TEST_*` poison if one exists for this path — name
  it) → `prepareCommit` throws `publicationError`, no row is published.
- (c) non-vacuity by revert: with the reorder reverted, (a) is red again
  (the counts are unavailable at the old construction point).

### Budget and conflict surface

`src/codegen/multi-prepared-callable-publication.ts` (+~30 LOC, grant in
this issue's frontmatter with a dated rationale),
`src/ir/prepared-component-publication.ts` (+~8 LOC),
`src/ir/outcomes.ts` (one export). Disjoint from #5283
(`ir-overlay-outcomes.ts`, `module-init.ts`, `legacy-body-audit.ts` —
this slice only READS the audit index; if #5283 changes its shape, rebase
onto it), #5297 (`prepared-component-sealing.ts`, `prepared-dynamic-support.ts`,
`compiler-timer-shim-preparation.ts`), #3520 W1-D (`program-abi-*.ts`),
#3522 W1-A (`select.ts` class arms, `class-bodies.ts`). Branch after #5283
lands if it touches `legacy-body-audit.ts`'s index shape; otherwise now.

## Implementation notes (2026-09-03, ttraenkler/opus-5299)

Implemented as planned. Three deviations, each forced by a measurement.

### 1. The 34-case corpus contains ZERO rows from this publication path

Acceptance criterion 1 assumed the dogfood/ratchet corpus would show a
non-zero N for this row set. It does not, and the plan's own construction
explains why: `MultiPreparedCallablePublication` only ever stages **cross-source
`top-level-function` terminals**, and all 34 corpus cases are compiled
single-source through `compile()`.

Measured on `origin/main` (`986bbf7705`) with a probe over the exact 34 cases,
both lanes:

| | gc | standalone |
| --- | --- | --- |
| outcome rows | 105 | 105 |
| rows with a `preparedComponentId` | 48 | 45 |
| of those, **absent triple** | **13** | **13** |
| of the 13, built by `multi-prepared-callable-publication.ts` | **0** | **0** |

The 13 are 10 `class-member` rows (`classes.ts`), 2 `module-init` rows
(`calendar.ts`, `algorithms.ts`) and 1 derived timer-shim `setTimeout` row
(`async.ts`) — R3/R4 populations that the R2 reconciler does not cover and that
this slice deliberately does not touch. **They are unchanged after the fix**
(13 → 13, both lanes), which is the correct outcome, not a miss: fabricating a
triple for a population whose counters nothing measures is the exact defect
this issue exists to remove. They are the natural follow-up for the R9
denominator work.

So the affected population needed its own corpus (below), and the corpus sweep
served only as the byte-identity and no-collateral check.

### 2. The affected population is standalone-only

Measured across seven `compileMulti` option lanes on the same cross-source
program: `gc/default`, `gc/experimentalIR`, `gc/experimentalIR+nativeStrings`,
`gc/nativeStrings` and `wasi/default` all produce **0** prepared-callable rows;
only `standalone/default` and `standalone/experimentalIR+nativeStrings` reach
the route (2 rows each). Every measurement of the fixed population is therefore
standalone; the gc lane is reported as a byte-identity control.

Eight-program prepared corpus (multi-source, both lanes, 16 compiles):

| | base | branch |
| --- | --- | --- |
| prepared rows | 22 | 22 |
| absent triple | **21** | **0** |
| exact `(1, 0, 1)` | 1 | **22** |
| sha256 of the binary, per case | — | **16/16 identical** |

The one row already exact on base comes from the overlay reconciler
(`ir-overlay-outcomes.ts`), not from this publication — it is the control that
shows the two producers now agree.

### 3. A row states no counters when the direct-body ledger does not exist

`ctx.irBodyRouteAuditSession` requires `trackIrOutcomes` **and** an
`irCutoverRoute` (`context/body-route-audit.ts:29`). Every production entry
point supplies one (`compiler.ts:838` defaults it to `compileSourceSync`), but
a direct `generateMultiModule(ast, { trackIrOutcomes: true })` call does not —
and that spelling is used by existing `issue-3525` tests.

Failing closed there would break a public entry point; writing
`directBodyEmissions: 0` would be an unmeasured claim of exactly the kind this
issue removes. So the row keeps its pre-#5299 booleans and states **no**
counters, which `hasMalformedBodyEmissionAccounting` already treats as
well-formed. A pinned test covers this boundary so a later change cannot
quietly start guessing zeros.

### Ordering, and why the reorder is load-bearing

`prepareCommit` now claims the component tokens **before** building the rows.
Reverting only that reorder (rows built first, `tokens` still empty) makes every
prepared unit read 0 own-body patches, the fail-closed arm fires, and the whole
compile errors — 3 of the 8 new tests go red, including the end-to-end one.
The counts genuinely are unavailable at the old construction point.

Abort semantics are unchanged: nothing between the token loop and the row build
writes, so a rejected row still reaches the owner's `publication.abort()` with
every receipt claimed-but-unpublished — the same state a failing `take` already
produced. A pinned test asserts that abort still succeeds after a post-claim
rejection.

### Budgets

Both budget gates pass **without a grant**: `check-loc-budget` reports net
+130 LOC against `merge-base(origin)` and net −86 against `origin/main`, and
`check-func-budget` reports no unallowed growth on either base. No
`loc-budget-allow:` entry is therefore needed or added.

### Open, deliberately not done

`PreparedIrEmissionLedgerEntry` (`src/ir/program.ts:167`) carries the same
triple for the #3525 owner lifecycle and is still not wired to this path.
Unifying the two is R5 M1B, not this slice.
