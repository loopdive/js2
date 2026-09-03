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
