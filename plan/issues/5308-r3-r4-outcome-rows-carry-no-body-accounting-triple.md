---
id: 5308
title: "R3 class-member and R4 module-init outcome rows carry NO (prepareAttempts, directBodyEmissions, irBodyEmissions) triple — 13 rows on the 34-case corpus state nothing, so the R9 compile-once ratio is computed over R2 only"
status: ready
sprint: current
created: 2026-09-03
updated: 2026-09-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [5299, 5283, 5263, 3522, 3523, 3518]
requested_by: ttraenkler/orchestrator
---

# The exact body-emission triple stops at the R2 population

[#5299](5299-prepared-callable-rows-missing-receipt-triple.md) (PR #5549)
measured, on the 34-case dogfood/playground corpus, gc + standalone:

| rows with a `preparedComponentId` | 48 (gc) / 45 (standalone) |
| --- | --- |
| of those, **absent triple** | **13 / 13** |
| built by the prepared-callable publication | 0 |

The 13 are 10 `class-member` rows on `website/playground/examples/js/classes.ts`,
2 `module-init` rows (`dom/calendar.ts`, `js/algorithms.ts`) and 1 derived
timer-shim `setTimeout` row (`js/async.ts`). All are `emitted` — IR-owned
bodies — and none states how many direct or IR bodies were physically emitted
for it. `hasMalformedBodyEmissionAccounting` (`src/ir/outcomes.ts`) treats a
wholly absent triple as well-formed by design, so nothing flags them.

## Why: the reconciler's population is R2 only, by construction

`src/codegen/ir-overlay-outcomes.ts` computes the triple in
`reconcileR2FunctionBodyEmissionAccounting` only for units in
`collectR2FreeFunctionUnitIds` — source-local, public, physical **top-level
free-function** terminals (`unit.kind === "top-level-function"`,
`observedKind === "function"`). Every other unit kind gets
`bodyAccounting = undefined` and only the #5283 root-based `legacyBodyEmitted`
prediction.

The receipts for the other kinds already exist; they are dropped, not missing:

- **Direct side.** Class-member bodies compile through the audited
  `compileFunctionBody` (`src/codegen/declarations.ts:6319/6361/6419` →
  `audited-function-body.ts`), which records a `compileFunctionBody` root
  against the member's declaration node; `nearestInventoryUnit` attributes it
  to the member's own unit id with `unitKind: "class-member"`.
  `#indexDirectFunctionBodyReceipt` (`src/codegen/legacy-body-audit.ts:334-352`)
  then **returns without counting** for any non-`top-level-function` unit
  (after checking identity consistency). Module-init bodies record a
  `compileModuleInitBody` root attributed via `moduleInitUnitIdBySourceFile`;
  same fate.
- **IR side.** `buildIrIntegrationReport` mints `kind: "patched"` terminal
  evidence for **every** terminal owner whose artifact is its own unit
  (`src/ir/integration-report.ts:288-305`), class members and module-init
  included. `indexR2IrTerminalPatchReceipts` (`ir-overlay-outcomes.ts:283-292`)
  filters it to the R2 set.

So the compile-once question — "exactly one body, from exactly one emitter" —
is answerable for R3 and R4 rows today with no new instrumentation.

## Why it matters for R9

`scripts/check-ir-only.ts:403-416` asserts `irBodyEmitted === terminalUnits −
nonExecutable` per lane, and `legacyBodyEmitted === 0`. For R3/R4 rows both
booleans come from predictions (`legacyBodyEmitted` from a root, `irBodyEmitted`
from the outcome kind), not from counted receipts. A class member that was
patched by the IR **and** entered the direct body compiler (compile-twice)
reads `legacy=false, ir=true` and passes — the exact inflation
[#5283](5283-legacy-body-emitted-true-with-zero-direct-emissions.md) closed for
the root-only case, still open here. The R9 flip is judged on this gate.

## Acceptance criteria

1. On the 34-case corpus, gc + standalone, rows with a `preparedComponentId`
   and an absent triple: **13 → 1** per lane (the derived timer-shim row is
   out of scope, see below), with the row-by-row table in the PR body. Every
   R3 `class-member` and R4 `module-init` terminal row carries `(1, d, i)`
   with `d`/`i` counted from receipts, never literals.
2. Fail-closed on compile-twice: a class member with a `patched` IR receipt
   **and** a counted `compileFunctionBody` root raises the same
   `body-emission-evidence` invariant the R2 reconciler raises, with a pinned
   test that injects the second receipt through `ctx.irBodyRouteAuditSession`
   (the seam #5299 used).
3. Byte identity: 34/34 per lane — accounting only.
4. `check:ir-only` READY on both lanes with an identical summary; state
   whether `legacyBodyEmittedCeiling: 0` still holds once R3/R4 booleans are
   receipt-derived (if a real compile-twice surfaces, that is a finding to
   file, not a number to re-seed).

## Implementation Plan (2026-09-03, Fable lane)

Anchors from `origin/main` after PR #5549; re-verify before editing.

1. **`src/codegen/legacy-body-audit.ts`** — in `#indexDirectFunctionBodyReceipt`
   (`:334-352`), the early `return` for non-top-level units becomes a second
   index: count `compileFunctionBody` entries whose `knownUnit.terminal &&
   knownUnit.kind === "class-member"` into `classMemberCountsByUnitId`, and
   `compileModuleInitBody` roots (`entry.entryPoint`, unit from
   `moduleInitUnitIdBySourceFile`, `unit.kind === "module-init"`) into
   `moduleInitCountsByUnitId` — both per source, both with the same
   identity-consistency checks and the same `duplicateUnitIds` violation
   path. Expose them on `IrDirectFunctionBodyReceiptAudit` next to
   `countsByUnitId` (`:96`). Do not merge them into `countsByUnitId`: its
   contract (`:91-96`) is "top-level free functions only" and
   `tests/issue-5283-*` / `issue-5262-*` pin that width.
2. **`src/codegen/ir-overlay-outcomes.ts`** — generalize the population:
   alongside `indexR2FreeFunctionPopulations` add the R3 population (terminal
   `class-member` units of the source, from `identityContext.inventory`) and
   the R4 population (the source's module-init terminal, when
   `moduleInitUnitIdBySourceFile` has one and the module-init plan is
   executable — a `non-executable` row has no body and gets no triple). Index
   `patched` evidence for those ids (`indexR2IrTerminalPatchReceipts` takes a
   unit-id set; call it with the union or once per population). Route the
   three populations through **one** reconciler
   (`reconcileR2FunctionBodyEmissionAccounting` renamed to
   `reconcileFunctionBodyEmissionAccounting`, taking the counts map to read),
   so there is one copy of the rule. `functionBodyAccountingFailure` (`:323`)
   applies unchanged: it is kind-agnostic. Leave `ownedElsewhereUnitIds`
   (#5263) and the #5283 root fallback as they are — the fallback now only
   fires for kinds with no receipt index (derived units).
3. **`src/ir/outcomes.ts`** — no change; `hasMalformedBodyEmissionAccounting`
   validates the new rows as it does R2's.
4. **Out of scope, stated:** the derived timer-shim row (`js/async.ts`,
   `entry.derivedUnit` in `compiler-timer-shim-preparation.ts:316-364`) is a
   derived unit with no direct body of its own; its accounting belongs to the
   R6 shim owner. Keep it at "absent triple" and say so.

### Measurement order

1. Probe on base (`.tmp/probe-5308.mts`): the 34-case corpus, both lanes,
   list every row with a `preparedComponentId` and an absent triple —
   reproduce 13/13 with the kinds above. Also list, per class-member row, the
   audit entries attributed to its unit id (entry point + count) so the
   direct-side receipt is shown to exist before it is counted.
2. Base copies at first edit.
3. Implement 1–2. Re-probe: 1/1 absent (the timer-shim row); every R3/R4 row
   `(1, 0, 1)` on this corpus (all are IR-emitted) — if any row reads
   `(1, 1, 1)` that is a compile-twice finding: keep the invariant, file it,
   do not soften the rule.
4. Byte identity 34/34 × 2 lanes; `check:ir-only` summary before/after;
   `check:ir-fallbacks`, `check:ir-kind-neutrality`, `check:ir-layering`
   unchanged.
5. Keep green: `tests/issue-5283-*`, `issue-5262-*`, `issue-5263-*`,
   `issue-5299-*`, `issue-3519-*`, `issue-3522-*`; failing-name-set diff for
   `issue-3520-*` / `issue-3525-*` empty.
6. Equivalence 8 shards by name (`EQUIVALENCE_FORK_HEAP_MB=4096`), zero diff.

### Tests

`tests/issue-5308-r3-r4-body-accounting.test.ts`:

- (a) `js/classes.ts` (or a fixture with two IR-emitted methods and one
  direct-owned one): every class-member terminal row carries the triple;
  IR-owned rows `(1, 0, 1)`, the direct-owned row `(1, 1, 0)` — red on base.
- (b) a module-init row (`dom/calendar.ts`) carries `(1, 0, 1)` — red on base.
- (c) compile-twice fail-closed for a class member (receipt injected through
  the audit session) → `body-emission-evidence` invariant — red on base (no
  invariant today).
- (d) the `countsByUnitId` R2 index is unchanged in width (a class member
  never appears in it) — green on base, pins the contract.
- (e) a `non-executable` module-init row still carries no triple — green on
  base, the no-over-claim guard.

Non-vacuity: revert step 1 alone → (a),(b) red with "counts unavailable";
revert step 2's population alone → same.

### Budget and conflict surface

`legacy-body-audit.ts` (+~40), `ir-overlay-outcomes.ts` (+~50 net, mostly the
population index), grants in this file's frontmatter. Disjoint from #3522 W1-B
(`select.ts`, `from-ast.ts`), #3520 W1-E (`vec-access-exports.ts`,
`vec-define-writeback.ts`). Touches the two files #5283 landed in; branch from
`origin/main` after PR #5549 (landed 21:59Z). Claim the bare id.
