---
id: 5299
title: "Published prepared-callable outcome rows carry NO (prepareAttempts, directBodyEmissions, irBodyEmissions) triple — absent, not zero — so every R9 ratio over the R2 population silently omits them"
status: ready
sprint: current
created: 2026-09-03
updated: 2026-09-03
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
